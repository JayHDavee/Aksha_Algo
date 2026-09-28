# deepstream_nvinfer

DeepStream 8.0 NvInfer service — runs YOLOv10 FP16 object detection on RTSP camera streams and publishes detections to Kafka.

## Build & Push

```bash
# Update the tag in exec_script.sh, then:
bash exec_script.sh
```

Tag format: `DDMMYYYY-<build-number>` (e.g. `24072026-32`)

Image: `dockerhubalgo/deepstream_nvinfer:<tag>`

---

## Pipeline Architecture

```
nvurisrcbin (per camera)
    └── tee
         ├── Branch A: queue → nvstreammux → nvinfer (TRT FP16) → fakesink
         └── Branch B: queue → nvvideoconvert → appsink → pull_worker → Kafka
```

- **Branch A** — inference only, pure NVMM zero-copy, never decoded to CPU
- **Branch B** — decoded frames pulled by Python worker, published to Kafka topic `frame_detections`
- Cameras are added/removed surgically (hot-add/remove) without stopping the pipeline
- Ghost pad detected → full pipeline restart with clean mux

---

## Configuration

Each pod is configured via environment variables in `docker-compose-nvinfer-70cams.yml`:

| Variable | Description |
|----------|-------------|
| `BATCH_ID` | Which cameras this pod owns (matched against `batch_id` in rtsplinks.json) |
| `KAFKA_BROKER` | Kafka broker address |
| `RTSP_LINKS_PATH` | Path to `rtsplinks.json` inside the container |

Camera list: `deployment/Aksha/rtsplinks.json`

---

## REST API

All endpoints on `http://localhost:800{BATCH_ID}` (e.g. pod 1 → port 8001).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Pipeline health check |
| POST | `/add` | Hot-add a camera |
| DELETE | `/remove/{cam_name}` | Hot-remove a camera |
| POST | `/reload` | Reload cameras from rtsplinks.json |
| GET | `/cameras` | List active cameras |

### Add camera
```bash
curl -X POST http://localhost:8001/add \
  -H "Content-Type: application/json" \
  -d '{"cam_name":"cam1","rtsp_url":"rtsp://user:pass@ip:554/path","rtsp_id":"1","batch_id":1}'
```

### Remove camera
```bash
curl -X DELETE http://localhost:8001/remove/cam1
```

---

## Recovery Behaviour

| Condition | Action |
|-----------|--------|
| Camera 404 (< 10 consecutive) | Ignored — NVR transient overload, self-recovers |
| Camera 404 (≥ 10 consecutive) | Remove + hot-add with fresh TCP connection |
| No frames for > 120s (single cam) | `_refresh_camera_source` — remove + re-add |
| No frames for > 120s (all cams) | Full pipeline restart via `_restart_after(5)` |
| Ghost pad on hot-add | Full pipeline restart (DS 8.0: `release_request_pad` is a no-op) |
| Hot-add fails repeatedly | Exponential backoff: 2min → 4min → 8min → 10min cap |

---

## TensorRT Engine

- Model: `app/yolov10.onnx` (patched for TRT compatibility by `patch_models.py`)
- Precision: FP16, batch size 40
- Cache: `./Aksha/trt_cache/yolov10_b40_fp16_sm86.engine`
- First build: ~5–8 min on RTX 3050. Subsequent starts load cache in ~2s.
- CUDA arch: `sm_86` (Ampere — RTX 3050/3060/3070/3080)

---

## App Directory

```
app/
├── main.py               # FastAPI + GStreamer pipeline service
├── object_detection.py   # Kafka publisher + detection parsing
├── ds_config/            # DeepStream nvinfer config files
├── yolov10.onnx          # Detection model
├── yolov10_dynamic.onnx  # Dynamic-batch variant
└── coco.names            # Class labels
```
