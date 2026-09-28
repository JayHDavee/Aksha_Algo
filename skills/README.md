# Skills

Engineering reference docs for building and optimising ML pods in this stack.

## Architecture References

| Doc | What it covers |
|---|---|
| [deepstream_single.md](deepstream_single.md) | Full internals of deepstream_service — frame lifecycle, classes, threading, GStreamer pipeline, reconnect, Kafka payload, extension points |
| [deepstream_batch.md](deepstream_batch.md) | Full internals of deepstream_batch — BatchWorker, CameraSession, reload API, multi-container scaling, true batch inference |
| [deepstream_nvinfer.md](deepstream_nvinfer.md) | Why each block exists in deepstream_nvinfer — tee split, nvstreammux fixed batch-size, pad-probe vs appsink, surgical recovery, Kafka publish rationale |

## Building New ML Pods

| Doc | What it covers |
|---|---|
| [new_ml_pod.md](new_ml_pod.md) | Step-by-step template — copy deepstream_service, swap ONNX model, wire Dockerfile + compose |
| [anpr.md](anpr.md) | ANPR pod — plate detector + LPRNet OCR, 2-stage pipeline, Indian plate format |
| [face_recognition.md](face_recognition.md) | Face recognition pod — YOLOv8-face + ArcFace, 5-point alignment, MongoDB enrollment CLI |

## Performance & Optimization

| Doc | What it covers |
|---|---|
| [../DEEPSTREAM_OPTIMIZATIONS.md](../DEEPSTREAM_OPTIMIZATIONS.md) | GPU/CPU optimization log — FAST_PREFILTER, RGBx pipeline, imwrite throttle, batch inference, rollback hashes |
