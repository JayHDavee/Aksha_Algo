# DeepStream Single Pod — Architecture & Extension Guide

Reference for understanding and extending `aksha_backend/deepstream_service`.
One container = one camera. Scale horizontally by adding more containers.

---

## Architecture

```
Docker container (one per camera)
│
├── GStreamer thread (GLib.MainLoop)
│     RTSP → nvv4l2decoder (NVDEC) → nvvideoconvert → appsink
│                                                         │
├── Processing loop (main thread)  ←─ appsink.try-pull-sample()
│     1. FPS gate         (skip frames faster than target FPS)
│     2. FAST_PREFILTER   (pixel diff — skip static frames)
│     3. _run_inference() (ONNX/TRT model)
│     4. _publish()       (Kafka: JPEG + detections)
│     5. cv2.imwrite      (live image, throttled 5s)
│
└── Reconnect loop        (restarts pipeline on RTSP drop)
```

---

## Frame Lifecycle (step by step)

```
appsink.try-pull-sample()
  → _gst_buffer_to_numpy()          RGBx buffer → numpy (H,W,3) RGB
  → FPS gate                         drop if < min_frame_interval
  → _ssim_pass()                     pixel diff vs prev_frame
      FAST_PREFILTER=true  → np.abs(frame - prev) / 255 → mean score
      FAST_PREFILTER=false → scikit-image SSIM (slow, accurate)
      score < (1 - ssim_threshold) AND not force → skip, write live img
  → _run_inference()                 object_detection() → results list
  → _publish()                       imencode JPEG → Kafka
  → cv2.imwrite (throttled)          workday.jpg / holiday.jpg
```

---

## Key Classes & Functions

### `DeepStreamService`
Single class that owns the entire pipeline lifecycle for one camera.

| Method | What it does |
|---|---|
| `__init__` | Read args/env, init state |
| `_run_session()` | Build pipeline, run processing loop, return True to reconnect |
| `run()` | Outer loop: calls `_run_session()`, reconnects on drop |
| `_ssim_pass()` | Prefilter — returns True if frame changed enough |
| `_run_inference()` | Calls `object_detection()`, logs timing |
| `_publish()` | Encodes JPEG, builds Kafka payload, sends |
| `_store_reference()` | Writes reference image daily + at 09:00 |
| `_gst_buffer_to_numpy()` | Maps GStreamer buffer → numpy array |

### `build_pipeline(rtsp_url, width, height, codec)`
Builds the GStreamer pipeline string:
```
rtspsrc → rtph264depay → h264parse → nvv4l2decoder
  → nvvideoconvert (GPU resize to WxH)
  → nvvideoconvert (NVMM → system RAM, RGBx)
  → appsink
```

### `PipelineState`
Simple dataclass: `running`, `rtsp_down`, `restart (Event)`.
GStreamer bus callback sets `restart` on ERROR or EOS → triggers reconnect.

---

## Threading Model

```
Main thread:    processing loop (appsink poll → inference → Kafka)
Daemon thread:  GLib.MainLoop (GStreamer bus events only)
Daemon threads: publish_live_image() calls (fire-and-forget HTTP)
```

**GIL impact:** one camera = one Python process (Docker container). No GIL contention.
**Bottleneck:** the main thread is single-threaded by design — inference blocks the loop.
This is fine: at 3fps there is ~330ms of slack between frames.

---

## FORCE_INTERVAL Heartbeat

Even if SSIM says the scene is unchanged, a frame is force-sent every **10 seconds**:
```python
FORCE_INTERVAL = 10.0
force = (now - last_force_time) >= FORCE_INTERVAL
```
This keeps downstream services (`alert_identification`, `post_processor`) alive.
Without it, a perfectly static scene would send zero Kafka messages indefinitely.

---

## Reconnect Logic

`_run_session()` returns `True` to reconnect, `False` to exit cleanly.
`run()` sleeps 5s between reconnect attempts and writes `RTSP_ISSUE_IMG.png` to live path.
Max retry is controlled by `retry=5` in the GStreamer `rtspsrc` element — after 5 failures GStreamer emits an ERROR and the bus callback triggers reconnect.

---

## GStreamer Pipeline Detail

```python
f"rtspsrc location=\"{url}\" latency=200 protocols=tcp retry=5 "
f"! rtph264depay ! h264parse ! nvv4l2decoder "
f"! nvvideoconvert "
f"! video/x-raw(memory:NVMM),format=NV12,width={W},height={H} "
f"! nvvideoconvert ! video/x-raw,format=RGBx "
f"! appsink name=appsink0 emit-signals=false sync=false max-buffers=2 drop=true"
```

- `nvv4l2decoder` — NVIDIA hardware decoder (NVDEC). Uses dedicated silicon, ~0% CUDA.
- First `nvvideoconvert` — GPU resize from stream resolution to `OUTPUT_WIDTH × OUTPUT_HEIGHT`. Stays in NVMM (GPU memory).
- Second `nvvideoconvert` — moves frame from NVMM → system RAM as RGBx. Necessary because appsink cannot read NVMM directly.
- `max-buffers=2 drop=true` — appsink drops oldest frame if the processing loop is slow. Prevents memory growth.
- `sync=false` — do not sync to clock; deliver as fast as possible.

**Frame format:** RGBx (4 bytes/pixel). Python drops the X channel:
```python
np.frombuffer(data, dtype=np.uint8).reshape((H, W, 4))[:, :, :3]
```
Frame is **RGB**, not BGR. Convert before any OpenCV write:
```python
bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
cv2.imwrite(path, bgr)
```

---

## Kafka Payload

**Topic:** `object_detection_results`

```json
{
  "frame_id": "camera_name@14:32:01.123456",
  "frame_bytes": "<base64 JPEG>",
  "object_detection_results": [
    {"label": "person", "x": 100, "y": 50, "w": 80, "h": 200, "confidence": 0.87}
  ]
}
```

**Headers:**
```
frame_id      → camera_name@HH:MM:SS.ffffff
timestamp_str → ISO 8601 datetime
camera_name   → camera name string
content-type  → image/jpeg
```

---

## Adding a New ML Model

**Only two files change:**

### 1. `object_detection.py` — swap inference logic
The function signature `main.py` calls must stay the same:
```python
def object_detection(frame, ort_session, class_names, colors):
    # frame: RGB numpy (H, W, 3)
    # returns: boxes, confidence, classes, class_names
    ...
```

### 2. `main.py` — update three lines
```python
# Model file paths (resolved relative to app/ directory)
_model_path = os.path.join(os.path.dirname(__file__), "your_model.onnx")
_names_path = os.path.join(os.path.dirname(__file__), "your_labels.names")

# Kafka topic
OUTPUT_TOPIC = "your_topic"
```

Everything else — pipeline, SSIM, reconnect, Kafka serialization — is unchanged.

---

## Env Vars

| Var | Default | Notes |
|---|---|---|
| `CAMERA_NAME` | required | Used for paths and Kafka key |
| `RTSP_URL` | required | Full RTSP URL including auth |
| `RTSP_ID` | CAMERA_NAME | ID used for reference image filename |
| `RTSP_CODEC` | `h264` | `h264` or `h265` |
| `OUTPUT_WIDTH` | `640` | GPU resize target width |
| `OUTPUT_HEIGHT` | `360` | GPU resize target height |
| `FPS` | `1.0` | Target processing FPS (not stream FPS) |
| `OBJECT_DETECTION` | `true` | Set `false` to disable inference (prefilter only) |
| `SSIM_THRESH` | `0.95` | Pixel diff threshold — lower = more frames pass |
| `FAST_PREFILTER` | `true` | `true` = pixel diff, `false` = scikit-image SSIM |
| `LIVE_WRITE_INTERVAL` | `5.0` | Seconds between live image disk writes |
| `ENABLE_GPU` | `true` | Use GPU ONNX providers |
| `ENABLE_TENSORRT` | `true` | Use TRT execution provider |
| `ENABLE_TRT_FP16` | `true` | FP16 for Turing+; set `false` for Pascal GTX 10xx |
| `TRT_CACHE_PATH` | `/Aksha/trt_cache` | TRT engine cache dir (shared volume) |
| `KAFKA_BOOTSTRAP_SERVERS` | `broker:9092` | Kafka broker address |
| `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB for camera config fetch |
| `AKSHA_PATH` | `/Aksha` | Root of shared volume |

---

## File Layout in /Aksha Volume

```
/Aksha/
  {camera_name}/
    live/
      workday.jpg       ← latest frame (frontend display)
      holiday.jpg       ← same frame (alternate schedule)
    spotlight/          ← alert crop images (written by post_processor)
    alerts/             ← alert metadata
    frame/              ← temporary frame storage
    log/                ← rotating log files
  Reference_images/
    {rtsp_id}.jpg       ← daily reference image (updated 09:00)
  trt_cache/
    *.engine            ← TRT compiled engine (built on first run, reused)
```

---

## Performance Profile (single pod, RTX 2070)

| Operation | Time | Thread | CPU |
|---|---|---|---|
| NVDEC decode | ~0ms CPU | GLib thread | NVDEC silicon |
| Frame copy (frombuffer) | ~1ms | main | ~0.06 cores at 60fps |
| FAST_PREFILTER (numpy) | ~1.5ms | main | ~0.08 cores at 60fps |
| TRT inference | ~8ms | main | GPU |
| JPEG encode (imencode) | ~7ms | main | ~0.04 cores at 18fps |
| cv2.imwrite (throttled) | ~5ms | main | ~0.01 cores at 4/sec |
| Kafka send | ~2ms | main | negligible |
| **Total CPU per pod** | | | **~9%** |

At 20 pods × 9% = ~1.8 CPU cores + ~40% GPU.
