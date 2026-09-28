# DeepStream Batch Pod — Architecture & Extension Guide

Reference for understanding and extending `aksha_backend/deepstream_batch`.
One container handles N cameras with one shared model in VRAM.

---

## Architecture

```
Docker container (handles N cameras, one BATCH_ID partition)
│
├── CameraSession × N  (one thread per camera)
│     RTSP → NVDEC → appsink
│       → FPS gate
│       → FAST_PREFILTER (pixel diff)
│       → frame_queue.put()   ───────────────────┐
│                                                 │
├── BatchWorker thread  ◄────────────────────────┘
│     collect one frame per camera (within BATCH_TIMEOUT_MS)
│     → batch_object_detection([frame1..frameN])
│         fixed batch_size=1: loop N session.run() calls
│         dynamic model:      one session.run([N,3,640,640])
│     → per-camera Kafka publish
│     → throttled live image write
│
├── FastAPI /reload endpoint
│     re-reads rtsplinks.json → start/stop CameraSessions
│
└── FastAPI /status endpoint
      returns active camera list
```

---

## Frame Lifecycle (step by step)

```
CameraSession._run()  (per-camera thread)
  → appsink.try-pull-sample()
  → FPS gate
  → _gst_buffer_to_numpy()     RGBx buffer → numpy (H,W,3) RGB
  → _ssim_pass()               pixel diff vs per-camera prev_frame
      pass  → frame_queue.put_nowait((frame_id, frame, ts))
      skip  → write live img (throttled) → continue

BatchWorker._batch_worker()  (single shared thread)
  → for each CameraSession: queue.get(timeout=remaining)
  → collect up to N frames within BATCH_TIMEOUT_MS window
  → batch_object_detection(frames, ort_session, ...)
      detect batch_dim from model input shape
      batch_dim != 1 → stack [N,3,640,640], one session.run()
      batch_dim == 1 → loop: one session.run() per frame
  → for each frame: Kafka publish + throttled live write
```

---

## Key Classes & Functions

### `CameraSession`
One instance per active camera. Each runs in its own daemon thread.

| Attribute | Type | What it is |
|---|---|---|
| `frame_queue` | `Queue(maxsize=2)` | Passes frames to BatchWorker. Drop=True prevents stale frames |
| `prev_frame` | `ndarray` | Previous frame for pixel diff |
| `_last_live_write` | `float` | monotonic time of last live image write |
| `min_interval` | `float` | 1/fps — minimum seconds between processed frames |
| `_ref_date` | `date` | Tracks when reference image was last written |

| Method | What it does |
|---|---|
| `start() / stop()` | Start/stop the thread |
| `_build_pipeline()` | Constructs GStreamer pipeline string |
| `_ssim_pass()` | Per-camera prefilter |
| `_run()` | Main loop: pull sample → gate → prefilter → enqueue |

### `BatchInferenceService`
Owns all `CameraSession` instances and the single `BatchWorker` thread.

| Method | What it does |
|---|---|
| `start()` | Starts the BatchWorker thread |
| `reload()` | Re-reads rtsplinks.json, starts/stops sessions to match |
| `_batch_worker()` | Collects frames, runs inference, publishes |
| `cameras_status()` | Returns dict of active cameras |

### FastAPI endpoints

| Endpoint | Method | What it does |
|---|---|---|
| `/reload` | POST | Triggers `service.reload()` — add/remove cameras without restart |
| `/status` | GET | Returns active camera names + FPS |
| `/health` | GET | Liveness check |

---

## Threading Model

```
Main thread:          uvicorn FastAPI server (handles /reload, /status)
BatchWorker thread:   inference + Kafka publish for all cameras
CameraSession × N:    one thread per camera (GStreamer pull loop)
GLib daemon × N:      one per camera (GStreamer bus events)
publish_live × N:     fire-and-forget HTTP threads
```

**GIL impact:** All Python threads share one GIL. At >13 cameras the GIL becomes the bottleneck.
- Each camera thread does: `appsink.try-pull-sample()` (C, releases GIL) → `_ssim_pass()` (Python, holds GIL)
- BatchWorker holds GIL during `batch_object_detection()` (ONNX releases GIL during inference)
- Practical limit: ~13 cameras per container before CPU saturates

---

## BatchWorker Collection Window

```python
timeout  = BATCH_TIMEOUT_MS / 1000.0   # default 33ms
deadline = time.monotonic() + timeout

for sess in sessions:
    remaining = deadline - time.monotonic()
    frame_id, frame, ts = sess.frame_queue.get(timeout=remaining)
    collected.append(...)
```

The worker visits cameras in order. Each `queue.get()` blocks for up to `remaining` seconds.
If a camera has no frame ready, it is skipped for this batch cycle.
**Result:** batch size = number of cameras that had a frame ready within the window.

At 3fps (333ms per frame interval) and 33ms timeout:
- Best case: all 10 cameras have frames → batch_size=10
- Typical: 3–5 cameras → batch_size=3–5 (frames arrive staggered)
- Worst case: no cameras ready → no inference call, sleep briefly

---

## reload() — Hot Camera Add/Remove

Controller sends `POST /reload` after writing `rtsplinks.json`. No container restart needed.

```python
def reload(self):
    with open(rtsp_path) as f:
        data = json.load(f)

    desired = {cam_name: ... for url, info in data.items()
               if info["running_status"] and int(info["batch_id"]) == BATCH_ID}

    with self._lock:
        for cam in current - wanted:      # cameras to remove
            self._cameras[cam].stop()
            del self._cameras[cam]
        for cam in wanted - current:      # cameras to add
            sess = CameraSession(cam, url, fetch_camera_config(cam))
            sess.start()
            self._cameras[cam] = sess
```

`_rtsp_lock` in the controller protects concurrent writes to `rtsplinks.json`.
The batch container's `self._lock` (RLock) protects `self._cameras` during reload vs BatchWorker reads.

---

## batch_object_detection() — True vs Sequential

```python
batch_dim = ort_session.get_inputs()[0].shape[0]
use_true_batch = batch_dim != 1 and len(frames) > 1

if use_true_batch:
    # One GPU kernel for all N frames — higher SM occupancy
    inp = np.stack(processed_list, axis=0)          # [N, 3, 640, 640]
    all_outputs = ort_session.run(..., {inname[0]: inp})[0]  # [N, 300, 6]
else:
    # N separate GPU calls — current default (fixed batch_size=1 model)
    all_outputs = [session.run(...) for each frame]
```

**To unlock true batching:** re-export YOLO with `--dynamic`:
```bash
yolo export model=best.pt format=onnx imgsz=640 simplify=True dynamic=True
```
No code change needed — the batch detection auto-detects from the model's input shape.

---

## Adding a New ML Model

### `object_detection.py` — three functions needed

`main.py` calls:
```python
# warmup call at startup
object_detection(np.zeros((640, 640, 3), dtype=np.uint8), ort_session, class_names, colors)

# per-frame fallback / warmup
boxes, confs, class_ids, classes = object_detection(frame, ort_session, class_names, colors)

# main batch call
results_list = batch_object_detection(frames, ort_session, class_names, colors)
# returns list of N get_labels() results, one per frame
```

Signature contract for `batch_object_detection`:
```python
def batch_object_detection(frames, ort_session, class_names, colors):
    # frames: list of N RGB numpy arrays (H, W, 3)
    # returns: list of N result lists
    # each result list: [{"label":..., "x":..., "y":..., "w":..., "h":..., "confidence":...}, ...]
    ...
```

### `main.py` — two lines to change
```python
_model_path = os.path.join(os.path.dirname(__file__), "your_model.onnx")
_names_path = os.path.join(os.path.dirname(__file__), "your_labels.names")
OUTPUT_TOPIC = "your_topic"
```

### To add extra fields to Kafka payload (batch worker)

In `_batch_worker`, the publish block:
```python
payload = {
    'frame_id':                 frame_id,
    'frame_bytes':              base64.b64encode(jpeg.tobytes()).decode('utf-8'),
    'object_detection_results': results,
    # add custom fields here:
    'your_field':               your_value,
}
```

---

## Kafka Payload

**Topic:** `object_detection_results` (configurable via `OUTPUT_TOPIC`)

```json
{
  "frame_id": "camera_name@14:32:01.123456",
  "frame_bytes": "<base64 JPEG>",
  "object_detection_results": [
    {"label": "person", "x": 100, "y": 50, "w": 80, "h": 200, "confidence": 0.87}
  ]
}
```

Headers identical to single pod. Downstream consumers (`alert_identification`, `post_processor`) need no changes.

---

## Multi-Container Setup (docker-compose)

```yaml
  deepstream_batch1:
    image: dockerhubalgo/deepstream_batch:24052026-2
    runtime: nvidia
    environment:
      BATCH_ID: "1"          # cameras with batch_id=1 in rtsplinks.json
      BATCH_TIMEOUT_MS: "33"
      ...

  deepstream_batch2:
    image: dockerhubalgo/deepstream_batch:24052026-2
    runtime: nvidia
    environment:
      BATCH_ID: "2"          # cameras with batch_id=2
      ...
```

Controller routes cameras to containers via `batch_id` in `rtsplinks.json`.
Set `BATCH_COUNT=3` in controller env to signal all 3 containers on bulk camera ops.

---

## Env Vars

| Var | Default | Notes |
|---|---|---|
| `BATCH_ID` | `1` | Which partition of cameras this container handles |
| `BATCH_TIMEOUT_MS` | `33` | Max ms to collect frames per batch cycle |
| `LIVE_WRITE_INTERVAL` | `5.0` | Seconds between live image writes per camera |
| `FAST_PREFILTER` | `true` | Pixel diff vs scikit-image SSIM |
| `ENABLE_GPU` | `true` | GPU ONNX providers |
| `ENABLE_TENSORRT` | `true` | TRT execution provider |
| `ENABLE_TRT_FP16` | `true` | FP16 for Turing+; `false` for GTX 10xx |
| `TRT_CACHE_PATH` | `/Aksha/trt_cache` | Shared TRT engine cache |
| `PUBLISH_RAW_FRAME` | `false` | Also publish to `raw_frame` Kafka topic |
| `KAFKA_BOOTSTRAP_SERVERS` | `broker:9092` | Kafka broker |
| `MONGODB_URI` | required | MongoDB for per-camera config fetch |
| `AKSHA_PATH` | `/Aksha` | Root of shared volume |

Per-camera config is fetched from MongoDB at camera add time (not env vars):

| MongoDB field | What it controls |
|---|---|
| `FPS` | Target processing FPS |
| `Output_Width` | GPU resize width |
| `Output_Height` | GPU resize height |
| `SSIM_Thresh` | Pixel diff threshold |
| `RTSP_Codec` | `h264` or `h265` |

---

## Scaling Rules

| Cameras | Setup | Reason |
|---|---|---|
| 1–3 | 1 batch container | Overhead not worth splitting |
| 4–13 | 1 batch container | One GIL, one TRT session in VRAM |
| 14–30 | 2–3 batch containers | GIL saturates >13 cams; split by BATCH_ID |
| 30+ | 3 containers + tune FPS | RTX 2070 VRAM limit (8GB) |

Single pod vs batch pod decision:

| Use single pod when | Use batch pod when |
|---|---|
| 1–3 cameras | 4+ cameras |
| Cameras need different models | All cameras use same model |
| Isolation required (one crash = one camera) | VRAM is limited |
| Camera needs custom per-pod settings | Dynamic add/remove at runtime |

---

## Performance Profile (per container, RTX 2070)

| Cameras | Batch size (typical) | GPU CUDA | CPU cores |
|---|---|---|---|
| 5 | 2–3 | ~10% | ~0.5 |
| 10 | 4–6 | ~20% | ~0.9 |
| 13 | 6–8 | ~28% | ~1.2 (GIL limit) |
| 13 + dynamic ONNX | 6–8 true batch | ~55% | ~1.0 |

VRAM: one TRT engine ~178MB regardless of camera count.
CPU bottleneck: GIL at ~13 cameras → split into 2 containers.
