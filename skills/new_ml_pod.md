# How to Build a New ML Pod on DeepStream Single

Use `deepstream_service` as the base template for any new single-camera ML inference pod.
The architecture is: `RTSP → NVDEC → FAST_PREFILTER → your_model → Kafka`.

---

## Folder Structure to Copy

```
aksha_backend/
  deepstream_service/          ← copy this entire folder, rename it
    app/
      main.py                  ← pipeline + Kafka publish (minimal changes needed)
      object_detection.py      ← replace with your model's inference logic
      your_model.onnx          ← drop your ONNX model here
      your_labels.names        ← one label per line
      LOADING_IMG.png          ← keep as-is
      RTSP_ISSUE_IMG.png       ← keep as-is
    dockerfile                 ← add your extra pip deps only
    requirements.txt           ← add your extra packages only
    exec_script.sh             ← change image tag
```

---

## Step 1 — Export Your Model to ONNX

### YOLOv8 / YOLOv10 (detection)
```bash
yolo export model=best.pt format=onnx imgsz=640 simplify=True
# For true batch support (higher GPU utilisation):
yolo export model=best.pt format=onnx imgsz=640 simplify=True dynamic=True
```

### PyTorch custom model
```python
import torch
model.eval()
dummy = torch.zeros(1, 3, 640, 640)
torch.onnx.export(model, dummy, "model.onnx",
    input_names=["images"], output_names=["output0"],
    dynamic_axes={"images": {0: "batch"}, "output0": {0: "batch"}})
```

ONNX output shape must be `[batch, N_detections, 6]` where each row is `[x0, y0, x1, y1, score, class_id]`.
If your model outputs a different format, adapt `object_detection.py` accordingly.

---

## Step 2 — Write object_detection.py

The only function `main.py` calls is:
```python
boxes, confs, class_ids, classes = object_detection(frame, ort_session, class_names, colors)
```

`frame` is always an **RGB numpy array** `(H, W, 3) uint8` from the GStreamer RGBx pipeline.

Minimal template:
```python
import cv2
import numpy as np
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes):
    indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
    return [
        {"label": str(classes[class_ids[i]]), "x": x, "y": y,
         "w": w, "h": h, "confidence": confs[i]}
        for i, (x, y, w, h) in enumerate(
            [boxes[j] for j in range(len(boxes))]
        ) if i in indexes
    ]


def letterbox(im, new_shape=(640, 640), color=(114, 114, 114),
              auto=True, scaleup=True, stride=32):
    shape = im.shape[:2]
    if isinstance(new_shape, int):
        new_shape = (new_shape, new_shape)
    r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
    if not scaleup:
        r = min(r, 1.0)
    new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))
    dw = (new_shape[1] - new_unpad[0]) / 2
    dh = (new_shape[0] - new_unpad[1]) / 2
    if auto:
        dw, dh = np.mod(dw * 2, stride) / 2, np.mod(dh * 2, stride) / 2
    if shape[::-1] != new_unpad:
        im = cv2.resize(im, new_unpad, interpolation=cv2.INTER_LINEAR)
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    im = cv2.copyMakeBorder(im, top, bottom, left, right,
                            cv2.BORDER_CONSTANT, value=color)
    return im, r, (dw, dh)


def load_object_detection_model(model_path, names_path, providers=None):
    if providers is None:
        providers = ['CPUExecutionProvider']
    with open(names_path) as f:
        class_names = [l.strip() for l in f]
    colors = {n: [random.randint(0, 255) for _ in range(3)] for n in class_names}
    session = ort.InferenceSession(model_path, providers=providers)
    return session, class_names, colors


def object_detection(frame, ort_session, class_names, colors):
    # frame is RGB — letterbox directly, no BGR conversion needed
    image, ratio, dwdh = letterbox(frame.copy(), auto=False)
    image = image.transpose((2, 0, 1)).astype(np.float32) / 255
    im = np.expand_dims(image, 0)
    inname  = [i.name for i in ort_session.get_inputs()]
    outname = [i.name for i in ort_session.get_outputs()]
    outputs = ort_session.run(outname, {inname[0]: im})[0][0]
    boxes, confidence, classes = [], [], []
    for x0, y0, x1, y1, score, cls_id in outputs:
        if score > 0.35:
            box = np.array([x0, y0, x1, y1])
            box -= np.array(list(dwdh) * 2)
            box /= ratio
            box = box.round().astype(np.int32).tolist()
            confidence.append(round(float(score), 3))
            boxes.append([int(box[0]), int(box[1]),
                          int(box[2] - box[0]), int(box[3] - box[1])])
            classes.append(int(cls_id))
    return boxes, confidence, classes, class_names
```

---

## Step 3 — main.py Changes

Only three lines need changing:

```python
# 1. Change the import at the top
from object_detection import load_object_detection_model, object_detection, get_labels

# 2. Change model/names filenames (same directory as main.py)
_model_path = os.path.join(os.path.dirname(__file__), "your_model.onnx")
_names_path = os.path.join(os.path.dirname(__file__), "your_labels.names")

# 3. Change OUTPUT_TOPIC if this pod writes to a different Kafka topic
OUTPUT_TOPIC = "object_detection_results"   # or "anpr_results", "face_results", etc.
```

Everything else — GStreamer pipeline, FAST_PREFILTER, SSIM, Kafka publish, MongoDB config fetch, live image writes — stays exactly the same.

---

## Step 4 — Dockerfile

Only add extra pip packages. Keep the base image unchanged:

```dockerfile
FROM nvcr.io/nvidia/deepstream:6.3-gc-triton-devel

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-gi python3-gi-cairo \
    gir1.2-gst-plugins-base-1.0 gir1.2-gstreamer-1.0 \
    libglib2.0-0 libgl1 \
    # add your apt deps here, e.g.:
    # libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH}

WORKDIR /code
COPY requirements.txt ./
RUN pip3 install --no-cache-dir \
    onnxruntime-gpu==1.17.1 \
    --extra-index-url https://aiinfra.pkgs.visualstudio.com/PublicPackages/_packaging/onnxruntime-cuda-12/pypi/simple/ && \
    pip3 install --no-cache-dir -r requirements.txt

COPY app/ ./app/
ENTRYPOINT ["python3", "app/main.py"]
```

---

## Step 5 — Docker Compose Entry

```yaml
  your_service_name:
    container_name: your_camera_name
    image: dockerhubalgo/your_image:tag
    networks:
      - aksha-net
    restart: always
    runtime: nvidia
    environment:
      TZ: Asia/Kolkata
      CAMERA_NAME: your_camera_name
      RTSP_ID: "1"
      RTSP_URL: rtsp://user:pass@192.168.1.100/stream
      OUTPUT_WIDTH: "640"
      OUTPUT_HEIGHT: "360"
      FPS: "3"
      OBJECT_DETECTION: "true"
      SSIM_THRESH: "0.95"
      RTSP_CODEC: "h264"
      FAST_PREFILTER: "true"
      LIVE_WRITE_INTERVAL: "5"
      KAFKA_BOOTSTRAP_SERVERS: broker:9092
      MONGODB_URI: mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false
      AKSHA_PATH: /Aksha
      ENABLE_GPU: "true"
      ENABLE_TENSORRT: "true"
      TRT_CACHE_PATH: /Aksha/trt_cache
      NVIDIA_VISIBLE_DEVICES: all
    volumes:
      - ./Aksha:/Aksha
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    depends_on:
      kafka_broker:
        condition: service_started
      mongodb:
        condition: service_healthy
```

---

## Step 6 — Kafka Output Format

Default payload (matches `alert_identification` consumer):
```json
{
  "frame_id": "camera_name_1716000000.123",
  "frame_bytes": "<base64 JPEG>",
  "object_detection_results": [
    {"label": "person", "x": 100, "y": 50, "w": 80, "h": 200, "confidence": 0.87}
  ]
}
```

To add custom fields (e.g. plate text, face ID), extend `_publish` in `main.py`:
```python
payload = {
    'frame_id':                 frame_id,
    'frame_bytes':              base64.b64encode(jpeg.tobytes()).decode('utf-8'),
    'object_detection_results': results,
    'plate_text':               plate_text,   # custom field
}
```

---

## Checklist

- [ ] ONNX model exported and placed in `app/`
- [ ] `.names` file with one label per line in `app/`
- [ ] `object_detection.py` returns `(boxes, confs, class_ids, class_names)`
- [ ] `main.py` model path + topic updated
- [ ] `dockerfile` base image unchanged (`deepstream:6.3-gc-triton-devel`)
- [ ] `exec_script.sh` tag updated and pushed
- [ ] Docker compose entry added
- [ ] Controller `deployment_mode` set (or pod added manually to compose)
