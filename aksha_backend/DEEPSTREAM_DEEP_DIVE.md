# DeepStream Pipeline Deep Dive

Block-by-block breakdown of the three camera-inference architectures in this repo, with the
actual code backing each block. All three read the same `rtsplinks.json` camera list and
publish to the same Kafka topic (`object_detection_results`) — they differ only in **how many
cameras share a process** and **how/where frames get batched for inference**.

| Service | Cameras/container | Batching | Inference engine |
|---|---|---|---|
| `deepstream_service` | 1 | none | ONNX Runtime, per-frame |
| `deepstream_batch` | N | software (Python/numpy stack) | ONNX Runtime, `[N,3,640,640]` |
| `deepstream_batch_optimized` → `deepstream_nvinfer` | N | native GPU (`nvstreammux`) | DeepStream `nvinfer` (TensorRT) |

`deepstream_nvinfer` is the current production service (the one `controller_kubernetes`
manages) — `deepstream_batch_optimized` is its direct predecessor with the identical
architecture, so it's covered together with `deepstream_nvinfer` in §3.

---

## 0. Where DeepStream Sits in the Full Aksha Pipeline

DeepStream (whichever of the 3 variants) is the **entry point** of the entire alert pipeline
— it's the only component that ever touches raw RTSP video. Everything after it only ever
sees the Kafka JSON contract described in each section below, so the rest of the system is
completely blind to which of the 3 variants produced a given message:

```
RTSP camera
   │
   ▼
[ DeepStream — one of the 3 variants, §1/§2/§3 below ]
   │  produces: {frame_id, frame_bytes (b64 JPEG), object_detection_results: [...]}
   ▼
Kafka topic: object_detection_results
   │
   ▼
alert_identification   (aksha_backend/alert_identification)
   — matches detections against per-camera "My Alert" rule configs (Mongo `Alerts` collection)
   │  produces: AlertResult {alert_results, detection_results, frame_bytes, ...}
   ▼
Kafka topic: post_processing
   │
   ▼
post_processor   (aksha_backend/post_processor)
   — draws bbox/zone overlays (annotate.py), decides which alert type "wins" for this frame
   ├─► MongoDB `meta_<camera_name>`        (per-frame event history)
   ├─► HTTP POST /api/monitor → Node/Go backend → Socket.IO io.emit(camera_name, ...) → dashboard live view
   └─► Kafka topic: notification_service
          │
          ▼
       notification service   (aksha_backend/notification)
          — email (Gmail API) + Telegram + push, rate-limited per (group, camera)
```

**How each variant is actually chosen and deployed** — this is decided by
`controller_kubernetes`, not by anything inside DeepStream itself. `POST /Surveillance`
takes a `deployment_mode` param per camera:

| `deployment_mode` | What the controller spins up | When it's actually used |
|---|---|---|
| `deepstream_single` | One k8s `Deployment` per camera, GPU-scheduled, image = `deepstream_service` | Small camera counts, cameras needing per-camera isolation (one crash ≠ everyone's outage) or a different model per camera |
| `deepstream_batch` | A shared-model `Deployment` per **batch** of up to `MAX_CAMERAS_PER_POD` (default 10) cameras, image = `deepstream_batch`; controller writes the batch's camera list into `rtsplinks.json` and calls `POST /reload` on that batch's pod | Medium camera counts where isolation matters less than VRAM/CPU efficiency, and the ~13-camera GIL ceiling (see `skills/deepstream_batch.md`) is acceptable |
| `deepstream_nvinfer` | Same batch-of-N-per-pod model as above, image = `deepstream_nvinfer`; default mode per `DEEPSTREAM_SERVICE` env var | Large camera counts (70–100+/GPU) — this is the production default, since native GPU batching removes the GIL ceiling `deepstream_batch` hits |

The controller doesn't pick a mode automatically based on camera count — the caller
specifies `deployment_mode` per camera/batch. What **is** automatic (the Phase-2 autoscaling
work on this branch) is scaling the *number of batch pods within a mode*: `_ensure_batch_deployment`
spawns a new batch `Deployment` once the current batches are full (`MAX_CAMERAS_PER_POD`
reached), and `MAX_BATCHES_PER_GPU_NODE` caps how many batch pods (across both `deepstream_batch`
and `deepstream_nvinfer`, since they share the same GPU node pool) any one GPU node can run.

Regardless of mode, every batch/single pod ends up producing the **exact same** Kafka
message shape on `object_detection_results` — that identical contract is what lets
`alert_identification` downstream need zero awareness of which DeepStream variant, or how
many camera-per-pod, produced any given frame.

---

## 1. `deepstream_service` — single camera, no batching

```
rtspsrc → rtph264depay → h264parse → nvv4l2decoder → nvvideoconvert(scale) → nvvideoconvert(RGBx) → appsink → [Python] letterbox → ORT.run(batch=1) → NMS → Kafka
```

One container = one camera = one Python process. GStreamer never touches inference; it only
gets the decoded frame onto the CPU as a numpy array.

| # | Block | GStreamer element / code | What it actually does |
|---|---|---|---|
| 1 | RTSP pull | `rtspsrc location=... latency=200 protocols=tcp retry=5` | Opens the RTSP session, forces TCP transport (avoids UDP packet loss corrupting H.264), retries 5× on connect failure. |
| 2 | Depayload/parse | `rtph264depay ! h264parse` (or `rtph265depay`/`h265parse`) | Strips RTP framing, reassembles the raw H.264/H.265 Annex-B bytestream. |
| 3 | Hardware decode | `nvv4l2decoder` | NVDEC decodes to an NV12 frame that stays in GPU memory (`NVMM`) — no CPU involved yet. |
| 4 | GPU resize | `nvvideoconvert` → `video/x-raw(memory:NVMM),format=NV12,width=W,height=H` | Scales the frame to the configured output resolution, still on-GPU. |
| 5 | GPU→CPU handoff | second `nvvideoconvert` → `video/x-raw,format=RGBx` | Converts NVMM→system memory and NV12→RGBx, because `appsink` cannot read GPU (NVMM) buffers directly. |
| 6 | Frame sink | `appsink name=appsink0 max-buffers=2 drop=true sync=false` | Python pulls from here with `appsink.emit('try-pull-sample', ...)`; `drop=true` discards stale frames instead of blocking the pipeline. |
| 7 | Buffer→numpy | `_gst_buffer_to_numpy` | Maps the GStreamer buffer, reshapes to `(H,W,4)`, drops the alpha channel → RGB numpy array. |
| 8 | Change gate | `_ssim_pass` | Skips inference entirely if the frame is unchanged from the last one (structural similarity), except every `FORCE_INTERVAL=10s` (heartbeat). |
| 9 | Preprocess | `letterbox()` in `object_detection.py` | Resizes to 640×640 preserving aspect ratio, pads with gray bars, HWC→CHW, normalizes to `[0,1]`, adds batch dim → `[1,3,640,640]`. |
| 10 | Inference | `ort_session.run(...)` | **One frame per call.** Output `[1,300,6]` = up to 300 candidate boxes `(x0,y0,x1,y1,score,cls_id)`. |
| 11 | Postprocess | threshold `>0.35` → un-letterbox → xyxy→xywh → `get_labels()` (`cv2.dnn.NMSBoxes`, conf≥0.5, IoU≤0.4) | Produces the final `[{label,x,y,w,h,confidence}, ...]` detection list. |
| 12 | Publish | `self._publish(...)` | Sends frame + detections downstream (Kafka `object_detection_results`, same contract as the other two services). |

**Code — pipeline construction** (`deepstream_service/app/main.py:271-296`):
```python
pipeline_str = (
    f"rtspsrc location=\"{rtsp_url}\" latency=200 protocols=tcp retry=5 "
    f"! {depay} ! {parse} ! nvv4l2decoder "
    f"! nvvideoconvert "
    f"! video/x-raw(memory:NVMM),format=NV12,width={width},height={height} "
    f"! nvvideoconvert "
    f"! video/x-raw,format=RGBx "
    f"! appsink name=appsink0 emit-signals=false sync=false max-buffers=2 drop=true"
)
pipeline = Gst.parse_launch(pipeline_str)
```

**Code — pull loop + per-frame inference call** (`deepstream_service/app/main.py:490-531`):
```python
while not state.restart.is_set():
    sample = appsink.emit('try-pull-sample', Gst.SECOND)
    ...
    frame = self._gst_buffer_to_numpy(sample, self.width, self.height)
    ...
    if not self._ssim_pass(frame, frame_id, force):
        continue                      # static scene — skip inference
    results = self._run_inference(frame) if self.object_det else []
    self._publish(frame_id, frame, results, timestamp)
```

**Code — the actual batch=1 ORT call** (`deepstream_service/app/object_detection.py:134-143`):
```python
image, ratio, dwdh = letterbox(frame.copy(), auto=False)
image = image.transpose((2, 0, 1))
image = np.expand_dims(image, 0)          # → [1, 3, 640, 640]
im = image.astype(np.float32) / 255
outputs = object_detection_service.run(outname, {inname[0]: im})[0][0]
```

---

## 2. `deepstream_batch` — software batching across cameras

```
[per camera] rtspsrc→NVDEC→nvvideoconvert→appsink → GPU/CPU motion-diff prefilter → AdaptiveSkip → frame_queue
                                                                                                        ↓ (N queues)
                                                                          BatchWorker: collect 1 frame/camera in 33ms
                                                                            → np.stack → ORT.run(batch=N) → NMS
                                                                            → JPEG encode → Kafka (per camera)
```

One container manages N cameras. Each camera keeps its **own** GStreamer decode pipeline
identical in shape to `deepstream_service`'s (block 1–7 above are the same). What's new is
everything after the frame lands on CPU.

| # | Block | Code | What it actually does |
|---|---|---|---|
| 1–7 | Per-camera decode | `CameraSession._build_pipeline()` (`main.py:438-465`) | Same `rtspsrc→NVDEC→nvvideoconvert(scale)→nvvideoconvert(RGBA)→appsink` chain as `deepstream_service`, one instance per camera thread. |
| 8 | Motion prefilter | `_motion_check()` (`main.py:467-520`) | 3-tier speed fallback: `cv2.cuda.absdiff` (stays on GPU, no download) → numpy mean-abs-diff (CPU) → SSIM (slowest, opt-in). Returns `False` ("static scene") to skip the frame entirely — cheaper than running a full inference to find out nothing changed. |
| 9 | Adaptive skip | `_AdaptiveSkip.should_run_od()` (`main.py:208-235`) | Even when motion *is* detected, throttles to every Kth frame during **sustained** motion (e.g. blowing leaves) — only lets every frame through during the first `burst_frames` of a **new** motion event. |
| 10 | Per-camera queue | `self.frame_queue.put_nowait(...)` (`main.py:660-669`) | Non-blocking; on overflow it drops the oldest queued frame rather than blocking the GStreamer thread — decode must never stall waiting on the batch worker. |
| 11 | Batch collection | `BatchInferenceService._batch_worker()` (`main.py:771-799`) | Single thread, one iteration per `BATCH_TIMEOUT_MS` (default 33 ms ≈ 1 frame period): pulls **at most one frame per camera** from whichever queues have one ready, stops early if the deadline expires. This is the actual "batch" — assembled in Python, not GStreamer. |
| 12 | Batched inference | `batch_object_detection()` (`main.py:806`, `object_detection.py:237-270`) | `np.stack(processed_list, axis=0)` → `[N,3,640,640]` → **one** `ort_session.run()` call for all N cameras' frames together. |
| 13 | Per-camera publish | `main.py:816-871` | Loops the batch results back out per camera: BGR convert → JPEG encode → Kafka `object_detection_results` (same payload/header shape as `deepstream_service`) + live thumbnail write. |

**Code — the batch-collection deadline loop** (`deepstream_batch/app/main.py:775-799`):
```python
while self._running:
    deadline = time.monotonic() + timeout          # BATCH_TIMEOUT_MS, default 33ms
    collected = []
    for sess in sessions:                          # one CameraSession per active camera
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break                                   # deadline hit — run with whatever we have
        try:
            frame_id, frame, ts = sess.frame_queue.get(timeout=max(remaining, 0.005))
            collected.append((sess.camera_name, frame_id, frame, ts, sess.min_interval))
        except _queue.Empty:
            pass                                    # this camera had nothing ready this cycle
```

**Code — the actual numpy stack + single batched ORT call** (`deepstream_batch/app/object_detection.py:269-270`):
```python
inp = np.stack(processed_list, axis=0)              # [N, 3, 640, 640] — N = however many cameras had a frame ready
all_outputs = ort_session.run(outname, {inname[0]: inp})[0]   # ONE GPU kernel launch for all N frames
```

Note the batch size here is **variable and best-effort** — if only 6 of 10 cameras had a
fresh frame within the 33 ms window, the batch is `[6,3,640,640]`, not padded to 10. This is
the key difference from §3's native batching, where `nvstreammux` batch-size is a fixed
GStreamer property.

---

## 3. `deepstream_batch_optimized` / `deepstream_nvinfer` — native GPU batching

```
[per camera] nvurisrcbin → tee ─┬─ queue → nvstreammux(batch=MAX_CAMERAS) → nvinfer(TRT FP16) → fakesink
                                 │                                              ↑ pad-probe reads tensor metadata → _latest_detections[source_id]
                                 └─ queue → nvvideoconvert → capsfilter(RGBA) → appsink → [pull thread] motion-gate → JPEG → merge detections → Kafka
```

This is the only one of the three where **GStreamer itself does the batching** — `nvstreammux`
assembles N cameras' GPU frames into one batched NVMM buffer before `nvinfer` ever runs, so
the TensorRT engine executes one batched inference per pipeline tick, entirely on-GPU, with
zero Python/numpy involvement in the inference path itself.

Each camera's `tee` splits the stream into two independent branches that never block each
other:

| # | Block | Code | What it actually does |
|---|---|---|---|
| 1 | Source | `nvurisrcbin` (`main.py:710,727-745`) | Hardware-accelerated RTSP source; forced to TCP via a `deep-element-added` hook (UDP loss corrupts NVDEC); `drop-frame-interval` set when the camera's native FPS exceeds the configured target FPS, so downsampling happens at the source, before decode even runs. |
| 2 | Split | `tee` (`main.py:711,782-790`) | One buffer, two consumers — Branch A (inference) and Branch B (JPEG/publish) run independently; a stall in one never blocks the other. |
| 3a | Branch A entry | `queue` leaky, max 1 buffer (`main.py:712,757-761`) | `leaky=2` (downstream) + `max-size-buffers=1`: if `nvinfer` is momentarily busy, this queue **drops** the stale frame rather than backing up — inference always sees the *latest* frame, never a growing backlog. |
| 3b | Native batching | `nvstreammux` (`main.py:663-677`) | `batch-size=MAX_CAMERAS` (fixed, e.g. 10) — every camera has a reserved mux sink pad (`request_pad_simple(f"sink_{i}")`); assembles the current buffer from every linked camera into **one** batched NVMM tensor per push cycle (`batched-push-timeout`). This is the actual "batch" — built by the GStreamer plugin, not Python. |
| 4a | Inference | `nvinfer` (`main.py:679-684`) | Runs the TensorRT FP16 engine (`config-file-path=DS_CONFIG_PATH`) once per batched buffer — one GPU kernel launch covers however many cameras are currently linked into the mux, up to `MAX_CAMERAS`. |
| 4b | Metadata read | `pgie.get_static_pad("src").add_probe(..., self._tensor_probe)` (`main.py:698-699`) | A **pad probe**, not a sink — reads detection tensor metadata off the buffer as it passes, without pulling pixels to CPU. |
| 5a | Terminal (Branch A) | `fakesink` (`main.py:687-689,694`) | Buffer is discarded here — Branch A's only job was to produce metadata, which the probe already captured; no frame data needs to leave the GPU on this branch. |
| 5b | Tensor parse | `_tensor_probe` → `_parse_tensors` (`main.py:1051-1126`) | For each frame in the batch: casts the raw TRT output buffer via `pyds`/`ctypes` to a `[300,6]` float array, filters `score > CONF_THRESHOLD`, rescales boxes from network resolution back to the camera's original resolution, runs NMS (`get_labels`) → stores into `self._latest_detections[source_id]`, **keyed by camera index**, decoupled from any specific Kafka-publish timing. |
| 3b'/4b' | Branch B entry | `queue` leaky (`main.py:713,757-761`) → `nvvideoconvert` → `capsfilter(RGBA,W,H)` (`main.py:714-716,763-764`) | Separate GPU→CPU conversion path, only for frames that will actually be published (JPEG/live-view) — completely decoupled from the inference branch's cadence. |
| 5b' | Frame sink | `appsink` (`main.py:716,766-769`) | `max-buffers=1, drop=true` — same "always freshest frame" policy as Branch A's queue. |
| 6 | Pull + gate | `_pull_worker_camera()` (`main.py:1131-1310`), one thread per camera | Pulls the appsink, converts RGBA→BGR, runs the same GPU/CPU motion-diff prefilter and `_AdaptiveSkip` throttle as §2, decides whether this frame is worth publishing. |
| 7 | Detection merge | `detections = self._latest_detections.get(cam_idx, [])` (`main.py:1315`) | **This is the join between the two branches** — Branch B's pull worker doesn't run inference itself; it just reads whatever Branch A's tensor probe most recently wrote for this camera index and attaches it to the frame it's about to publish. |
| 8 | Publish | `main.py:1317-1353` | JPEG-encode the frame, build the same Kafka payload/header shape as §1/§2, send to `object_detection_results`. |

**Code — building the batching backbone** (`deepstream_nvinfer/app/main.py:663-696`):
```python
mux = Gst.ElementFactory.make("nvstreammux", "mux")
mux.set_property("batch-size", MAX_CAMERAS)     # fixed — reserves N mux sink pads up front
mux.set_property("width", NETWORK_W)
mux.set_property("height", NETWORK_H)
mux.set_property("live-source", 1)
mux.set_property("batched-push-timeout", BATCH_TIMEOUT_US)
pipeline.add(mux)

pgie = Gst.ElementFactory.make("nvinfer", "pgie")
pgie.set_property("config-file-path", DS_CONFIG_PATH)   # TensorRT engine + model config
pgie.set_property("interval", INFER_INTERVAL)
pipeline.add(pgie)

mux.link(pgie)
pgie.link(fakesink)
pgie.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._tensor_probe)
```

**Code — the tee split per camera, wired to both branches** (`deepstream_nvinfer/app/main.py:782-791`):
```python
tee_a = tee.request_pad_simple("src_%u")
tee_a.link(q_a.get_static_pad("sink"))
q_a.get_static_pad("src").link(mux_pad)          # Branch A → shared nvstreammux

tee_b = tee.request_pad_simple("src_%u")
tee_b.link(q_b.get_static_pad("sink"))
q_b.link(conv); conv.link(cfilt); cfilt.link(asink)   # Branch B → this camera's own appsink
```

**Code — reading TRT tensor metadata off the GPU buffer, no pixel copy** (`deepstream_nvinfer/app/main.py:1057-1074`):
```python
batch_meta = pyds.gst_buffer_get_nvds_batch_meta(hash(buf))
l_frame = batch_meta.frame_meta_list
while l_frame is not None:
    fm = pyds.NvDsFrameMeta.cast(l_frame.data)
    source_id = fm.source_id                      # which camera this frame in the batch belongs to
    self._latest_detections[source_id] = self._parse_tensors(fm, orig_w, orig_h)
    l_frame = l_frame.next
```

**Code — Branch B merging in Branch A's detections at publish time** (`deepstream_nvinfer/app/main.py:1315-1330`):
```python
detections = self._latest_detections.get(cam_idx, [])   # written asynchronously by the tensor probe
payload = {
    "frame_id": frame_id,
    "frame_bytes": base64.b64encode(jpeg_bytes).decode(),
    "object_detection_results": detections,
}
producer.send(OUTPUT_TOPIC, value=payload, key=frame_id.encode(), headers=headers)
```

### `deepstream_batch_optimized` vs `deepstream_nvinfer`

Identical architecture (`deepstream_batch_optimized/app/main.py` docstring literally says
*"nvinfer TRT + fixed pull workers"*, and `deepstream_nvinfer`'s says *"same pattern as
deepstream_batch_optimized"*). `deepstream_nvinfer` is the hardened evolution:
`/reload`+`/health` HTTP endpoints, incremental hot-add/hot-remove of individual camera
branches without rebuilding the whole pipeline, RTSP-stall watchdogs, and the DS 8.0
TRT-engine-naming fix (DS 7.1→8.0 engine filename mismatch, batch-size VRAM tuning, surgical
per-camera removal on RTSP failure — see `deepstream_nvinfer/README.md` for the operational
runbook).

---

## Why the batching mechanism matters

- **`deepstream_service`**: correctness/isolation first — one bad camera can't affect
  another, but GPU sits idle between single-frame inference calls. Doesn't scale past a
  handful of cameras per GPU.
- **`deepstream_batch`**: better GPU utilization via batching, but the batch is assembled by
  Python (`np.stack`) from independently-timed per-camera queues — batch size is variable,
  and there's a full CPU round-trip (JPEG encode, numpy) per frame even for the inference
  path.
- **`deepstream_batch_optimized`/`deepstream_nvinfer`**: `nvstreammux` batches natively on
  GPU before `nvinfer` runs, and the `tee` decouples "get me detections" from "get me a
  publishable frame" — this is why these are the ones scaling to 70–100 cameras per GPU in
  the compose files (`docker-compose-nvinfer-70cams.yml`, batch-size tuning documented in
  the nvinfer issues memory).
