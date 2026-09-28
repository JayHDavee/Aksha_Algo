# DeepStream NvInfer Pod — Why Each Block Exists

Reference for understanding and extending `aksha_backend/deepstream_nvinfer` (the production
successor to `deepstream_batch_optimized`, same architecture). Unlike
[deepstream_single.md](deepstream_single.md) and [deepstream_batch.md](deepstream_batch.md),
this doc is organized around **why** each design choice was made, not just what it does —
use it when deciding whether to change something, not just when reading the code top to bottom.

---

## Architecture

```
Docker container (handles up to MAX_CAMERAS cameras, one BATCH_ID partition)
│
├── nvurisrcbin × N  (one per camera)
│     └── tee
│          ├── Branch A: queue(leaky,max=1) → nvstreammux(batch=MAX_CAMERAS) → nvinfer(TRT FP16) → fakesink
│          │                                                                       ↑ pad-probe → _latest_detections[source_id]
│          └── Branch B: queue(leaky,max=1) → nvvideoconvert → capsfilter(RGBA) → appsink
│                                                                                    ↑ pull thread × N
│                                                                                       motion-gate → JPEG → merge detections → Kafka
│
├── FastAPI /reload, /health, /add, /remove/{cam_name}, /cameras
│
└── Recovery loop  (stall watchdog, 404 counter, offline-camera reconnect)
```

---

## Why This Design, Block by Block

### Why `nvurisrcbin`, not plain `rtspsrc` (like `deepstream_single`/`deepstream_batch`)

`nvurisrcbin` is DeepStream's higher-level source bin — it wraps `rtspsrc` + depay + parse +
`nvv4l2decoder` as one element and, critically, exposes properties `deepstream_single`'s
manual pipeline string can't easily get at hot-add time: `rtsp-reconnect-interval`,
`drop-frame-interval` (hardware frame-skip *before* decode), and a `deep-element-added`
signal used to force TCP transport on the internal `rtspsrc` child:

```python
# deepstream_nvinfer/app/main.py:736-745
def _on_deep_element_added_build(_bin, _sub_bin, element):
    factory = element.get_factory()
    if factory and factory.get_name() == "rtspsrc":
        element.set_property("protocols", 4)   # GST_RTSP_LOWER_TRANS_TCP
        element.set_property("latency", 200)
src.connect("deep-element-added", _on_deep_element_added_build)
```
**Why TCP is forced:** UDP RTP packet loss silently corrupts H.264 NAL units, which NVDEC
then fails to decode — the symptom is 0 frames delivered even though the camera is reachable
and `ffplay` (software decode, more error-tolerant) plays it fine. This was a real incident
(see repo memory `project_nvinfer_issues`), not a defensive guess.

**Why hardware frame-skip (`drop-frame-interval`) instead of dropping in Python:**
```python
# main.py:747-755
if src_fps > fps:
    drop_iv = max(1, round(src_fps / fps))
    src.set_property("drop-frame-interval", drop_iv)
```
Dropping unwanted frames *before* NVDEC decodes them saves the decode cost entirely — a
25fps camera that only needs 5fps analysis never decodes the other 20 frames/sec. Doing the
same downsampling in Python (as `deepstream_service` effectively does via its FPS gate) still
pays the full NVDEC decode cost per frame; only the *inference* is skipped.

### Why `tee` — splitting into two branches instead of one linear pipeline

A single linear pipeline (`src → mux → nvinfer → appsink`) would force every consumer to run
at inference speed and would mean a JPEG-encode/Kafka-publish stall blocks the next camera's
frame from ever reaching the batch. `tee` decouples "produce detections" (Branch A) from
"produce a publishable frame" (Branch B) so they can run at **different, independent
cadences** — Branch A can infer on every batched tick while Branch B only publishes when its
own motion-gate says a frame is worth sending. This is the direct fix for the constraint
`deepstream_batch` lives with, where a slow batch-worker cycle risks stalling every camera's
decode thread.

### Why `queue(leaky=downstream, max-size-buffers=1)` on both tee branches

```python
# main.py:757-761
for q in (q_a, q_b):
    q.set_property("max-size-buffers", 1)
    q.set_property("leaky",            2)   # GST_QUEUE_LEAK_DOWNSTREAM
```
**Justification:** if `nvinfer` (Branch A) or the JPEG pull worker (Branch B) is momentarily
busy, the *default* GStreamer queue behavior is to buffer up and eventually block upstream —
which would stall `nvurisrcbin`'s decode and, transitively, every other camera sharing that
pipeline once buffers back up far enough. `leaky=downstream` + `max-size-buffers=1` makes the
queue **drop the stale frame and keep only the newest** instead of blocking. The tradeoff
(explicit, not accidental) is that a slow consumer sees skipped frames rather than a growing
backlog — correct for a live-monitoring system where the latest frame always matters more
than every frame.

### Why `nvstreammux` with a **fixed** `batch-size=MAX_CAMERAS`, not one pad per active camera

```python
# main.py:667
mux.set_property("batch-size", MAX_CAMERAS)  # reserve MAX_CAMERAS slots so hot-add never exceeds the pad cap
```
**Justification:** the TensorRT engine's batch dimension is baked in at *engine-build time*
(`config_infer_primary_yolov10.txt` → `.engine` file). Rebuilding the engine takes 3–8 minutes
(see repo memory: DS 8.0 engine-naming issue). If `batch-size` tracked the *current* camera
count, every hot-add/hot-remove would either need a new engine or silently reuse a
wrong-shaped one. Reserving `MAX_CAMERAS` slots up front means the engine is built exactly
once per container lifetime, and hot-add just claims an already-reserved mux sink pad
(`request_pad_simple(f"sink_{i}")`) — no rebuild, no downtime. The cost is some idle VRAM for
unused slots when fewer than `MAX_CAMERAS` cameras are actually connected — judged worth it
against a multi-minute rebuild on every camera change (this is also why `MAX_CAMERAS` itself
was tuned down from 40→10 per pod after a VRAM budget incident, see `project_nvinfer_issues`).

### Why `nvinfer` (native DeepStream plugin) instead of `onnxruntime` (as in `deepstream_service`/`deepstream_batch`)

`onnxruntime.run()` requires the frame on CPU (or at least in a CUDA buffer ORT itself
manages) and pays a Python function-call + array-marshalling cost per invocation.
`nvinfer` runs the TensorRT engine **inside the GStreamer pipeline itself**, consuming the
already-GPU-resident NVMM buffer that `nvstreammux` assembled — zero additional GPU↔CPU
copies, zero Python in the hot path. This is the entire reason this architecture scales to
70–100 cameras/pod (`docker-compose-nvinfer-70cams.yml`) where `deepstream_batch`'s
Python-level `np.stack` + `ort_session.run()` tops out around a dozen cameras before the GIL
becomes the bottleneck (documented in `deepstream_batch.md`'s threading-model section).

### Why a **pad probe** on `nvinfer`'s src pad, not an `appsink` for Branch A

```python
# main.py:698-699
pgie.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._tensor_probe)
```
**Justification:** an `appsink` would require the buffer to actually flow to Python-managed
memory — even a "shallow" pull triggers ref-counting and potential mapping overhead per
buffer, for a branch whose only purpose is reading detection *metadata*, not pixels. A pad
probe intercepts the buffer as it passes through the pad **without diverting or copying it**
— `pyds.gst_buffer_get_nvds_batch_meta(hash(buf))` reads the tensor-metadata struct DeepStream
already attached, then the buffer continues straight to `fakesink`. This is the cheapest
possible way to extract "what did the model see" from a GPU-resident batch without paying for
a pixel round-trip that Branch A doesn't need.

### Why `fakesink`, not a real sink, terminates Branch A

Branch A's job ends the moment the tensor probe has read the metadata — the actual pixel
buffer has no further use on this branch (Branch B already has its own independent copy of
the frame for JPEG/publish purposes). `fakesink` explicitly declares "this data is
intentionally discarded here," which is clearer intent than routing it to, say, a `filesink`
or `appsink` that would just never be read.

### Why a **separate** GPU→CPU conversion path in Branch B, not reusing Branch A's buffer

```python
# main.py:713-716, 787-791
q_b → nvvideoconvert → capsfilter(RGBA,W,H) → appsink
```
Branch A never leaves NVMM/GPU memory (by design, see above) — there is no CPU-side buffer to
"reuse." Branch B needs its **own** `nvvideoconvert` because JPEG encoding (`cv2.imencode`)
and the motion-diff prefilter both operate on CPU-side RGBA arrays. Duplicating the
conversion per branch costs one extra GPU convert op per frame but is what keeps the two
branches truly independent — Branch A can be busy inferring while Branch B is mid-JPEG-encode
without either blocking the other.

### Why the motion-gate + adaptive-skip run in Branch B, not before Branch A

This is the biggest structural difference from `deepstream_batch`, where the motion prefilter
runs **before** the frame is even queued for inference (skip the frame → never pay for
inference). Here, `nvstreammux`/`nvinfer` runs on **every** batched tick regardless of motion,
and only Branch B's `_pull_worker_camera` (`main.py:1269-1310`) decides whether the resulting
JPEG is worth *publishing*:

```python
# main.py:1289-1291, 1305-1310
if not motion and not force_pub and not live_write_due:
    _adaptive_skip.should_run_od(cam_name, False)
    continue
...
if not _adaptive_skip.should_run_od(cam_name, motion) and not force_pub:
    continue
```
**Justification:** because `nvstreammux` batches whatever arrived from every linked camera
into a single native-GPU inference call regardless of which frames "changed," skipping
inference per-camera would require pulling that camera out of the batch entirely (an
expensive structural operation, not a cheap boolean check) — so it's not worth trying to
avoid the GPU cost here the way `deepstream_batch` does. What *is* worth gating is the CPU
work downstream of inference (JPEG encode, base64, Kafka send) and the *volume* of Kafka
traffic — a static scene still gets its detections computed "for free" as part of the batch,
but doesn't spam Kafka with an identical frame every tick. This also means detections are
**always fresh** in `_latest_detections` whenever a publish does eventually fire, with no
extra latency waiting for inference to "catch up" to a motion event.

### Why detections are read from `_latest_detections[cam_idx]` at publish time, not passed inline

```python
# main.py:1315
detections = self._latest_detections.get(cam_idx, [])
```
Branch A (writes detections, via the tensor probe) and Branch B (reads them, in the per-camera
pull thread) run on **different threads with no shared call stack** — the tee split means
there is no return value to pass directly from "inference happened" to "now publish it."
A dict keyed by `source_id`/`cam_idx`, written by the probe and read by the pull worker, is the
simplest correct hand-off between two independently-scheduled GStreamer/thread contexts. The
tradeoff: detections read here reflect whatever the *most recent* inference batch produced,
which may be a few milliseconds older than the exact JPEG frame being published — acceptable
since both branches originate from the same `tee` within one native-batching cycle.

### Why per-camera pull **threads** (one per camera), not one shared worker (unlike `deepstream_batch`'s single `BatchWorker`)

`deepstream_batch` has one `BatchWorker` because it must serialize the Python `np.stack` +
single `ort_session.run()` call across cameras — batching *is* the Python bottleneck there,
so one thread doing it made sense. Here, inference is already batched natively by
`nvstreammux`/`nvinfer` — there's no equivalent shared GPU call left in Python for a single
worker to own. Each camera's Branch B (motion-gate → JPEG → publish) is independent CPU work
with no cross-camera dependency, so giving each camera its own thread lets a slow camera
(e.g. stuck on a big JPEG encode) never delay another camera's publish — same GIL-sharing
caveat as `deepstream_batch` applies, but there's no forced synchronization point between
cameras the way `BatchWorker`'s collection window creates.

### Why the recovery model is "surgical remove," never "restart the whole pipeline," for a single bad camera

```python
# main.py:1160-1175 (stall detection), see also project_nvinfer_issues memory
```
`nvstreammux` holds a `batch-size=MAX_CAMERAS` fixed reservation — removing one camera's
branch doesn't perturb the mux's shape or any other camera's linked pad. A full pipeline
rebuild, by contrast, tears down the shared TensorRT engine context (CUDA context release
takes ~10-15s) and every camera's decode — acceptable at startup, unacceptable every time one
RTSP source (out of 70-100) has a bad day. This is why `_pull_worker_camera` explicitly logs
"DO NOT restart the pipeline" (main.py:1171-1172) when a single camera stalls — it's a
documented decision, not an oversight, learned from an earlier full-rebuild design that caused
cascading downtime (`project_nvinfer_issues`, Issue 3/4/6).

---

## How It's Published to Kafka

```python
# main.py:1317-1330
detections = self._latest_detections.get(cam_idx, [])
frame_id   = f"{cam_name}@{ts.strftime('%H:%M:%S.%f')}"
payload = {
    "frame_id":                 frame_id,
    "frame_bytes":              base64.b64encode(jpeg_bytes).decode(),
    "object_detection_results": detections,
}
headers = [
    ("frame_id",      frame_id.encode()),
    ("timestamp_str", ts.isoformat().encode()),
    ("camera_name",   cam_name.encode()),
    ("content-type",  b"image/jpeg"),
]
producer.send(OUTPUT_TOPIC, value=payload, key=frame_id.encode(), headers=headers)
```

**Why the frame is base64-encoded inside the JSON body, not sent as raw bytes on its own
topic/partition:** every downstream consumer (`alert_identification`, `post_processor`) is
already written against one self-contained JSON message per frame — same contract as
`deepstream_service` and `deepstream_batch` (see their skill docs' identical payload shape).
Keeping the schema identical across all three pipeline variants means the entire rest of the
Kafka pipeline (`alert_identification` → `post_processor` → `notification`) needs **zero
changes** regardless of which DeepStream variant produced the message — this is a deliberate
compatibility contract, not an accident of all three being written by the same author.

**Why headers duplicate fields already in the payload:** `frame_id`/`camera_name`/`timestamp`
in headers let a Kafka consumer filter or route messages without deserializing the full JSON
body (and without base64-decoding a JPEG it might not even want) — useful for any future
consumer that only cares about a subset of cameras, or wants to log throughput without paying
the JSON-parse + JPEG-decode cost per message.

**Why `key=frame_id.encode()`:** Kafka guarantees ordering only within a partition, and
partition assignment defaults to a hash of the key. Keying by `frame_id` (which embeds
`camera_name`) means all frames for one camera consistently land in the same partition — so a
single camera's detections are processed **in order** by whichever consumer instance owns that
partition, even though many cameras are being produced from this one container concurrently.

**Why `PUBLISH_RAW_FRAME` is a separate, optional topic (`raw_frame`)** rather than folding raw
frames into the same message: the anomaly-detection pipeline (`anomaly_model_loader`) wants
frames independent of whether an object-detection alert fired, and most deployments don't run
anomaly detection at all — making it an opt-in second `producer.send()` call
(`main.py:1335-1351`) avoids doubling Kafka traffic for every deployment that doesn't need it.

---

## Where This Differs From the Other Two — Summary

| Decision point | `deepstream_service` / `deepstream_batch` | `deepstream_nvinfer` | Why the difference |
|---|---|---|---|
| Motion-gate timing | **Before** inference (skip = skip the inference call) | **After** inference (skip = skip the publish) | Native GPU batching makes per-camera inference skip impractical; CPU/Kafka cost is what's worth gating instead |
| Batching mechanism | Python `np.stack` (`deepstream_batch` only) | GStreamer `nvstreammux`, native GPU | Removes the GIL/Python bottleneck that caps `deepstream_batch` around ~13 cameras |
| Detection↔frame hand-off | Same function call, same thread | Async dict (`_latest_detections`), cross-thread | Branches run on independent GStreamer/thread schedules after the `tee` split |
| Failure recovery | Reconnect whole pipeline (1 camera/pipeline anyway) | Surgical single-branch removal | A shared TRT engine + mux makes full rebuilds too expensive to do per-camera |
| Batch size | N/A / variable (best-effort within `BATCH_TIMEOUT_MS`) | Fixed at engine-build time (`MAX_CAMERAS`) | TRT engine batch dimension can't change without a 3-8 min rebuild |
