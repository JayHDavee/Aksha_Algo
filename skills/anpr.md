# ANPR (Automatic Number Plate Recognition) Pod

Two-stage pipeline on top of `deepstream_service`:
1. **Detect** license plate bounding box (YOLOv8 plate detector)
2. **Read** plate text from cropped ROI (OCR model — LPRNet or PaddleOCR)

---

## Architecture

```
RTSP → NVDEC → FAST_PREFILTER → Stage 1: plate detector (ONNX/TRT)
                                       ↓  crop plate ROI
                               Stage 2: OCR model (ONNX/TRT)
                                       ↓
                               Kafka → { plate_text, confidence, bbox }
```

---

## Models

### Stage 1 — Plate Detector
Any YOLOv8 model trained on license plates. Single output class: `license_plate`.

Export:
```bash
yolo export model=plate_detector.pt format=onnx imgsz=640 simplify=True dynamic=True
```

Public pretrained options:
- `keremberke/yolov8n-license-plate-detection` (Hugging Face)
- `nicehash/license-plate-yolov8s`

### Stage 2 — OCR / Text Recognition

| Model | Speed | Accuracy | Notes |
|---|---|---|---|
| **LPRNet** (ONNX) | ~2ms/crop | Good for fixed formats | Best for India (IND plates) |
| **PaddleOCR** (ONNX) | ~8ms/crop | High | Works on any text |
| **EasyOCR** | ~15ms/crop | High | CPU-heavy, not recommended |
| **CRNN** (custom ONNX) | ~3ms/crop | Depends on training | Fastest if trained on your plate format |

For India plates (white/yellow, fixed font): **LPRNet** is recommended — fast, small, accurate.

---

## object_detection.py

```python
import cv2
import numpy as np
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes, plate_texts=None):
    indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
    results = []
    for i in range(len(boxes)):
        if i in indexes:
            x, y, w, h = boxes[i]
            result = {
                "label":      str(classes[class_ids[i]]),
                "x": x, "y": y, "w": w, "h": h,
                "confidence": confs[i],
            }
            if plate_texts:
                result["plate_text"] = plate_texts[i]
            results.append(result)
    return results


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


def _preprocess_ocr_crop(crop, target_h=24, target_w=94):
    """Resize plate crop to LPRNet input size (3, 24, 94)."""
    resized = cv2.resize(crop, (target_w, target_h))
    inp = resized.astype(np.float32) / 127.5 - 1.0   # [-1, 1]
    return np.expand_dims(inp.transpose(2, 0, 1), 0)  # [1, 3, 24, 94]


# LPRNet character set (Chinese/Indian plates — adjust for your region)
_CHARS = [
    '0','1','2','3','4','5','6','7','8','9',
    'A','B','C','D','E','F','G','H','I','J','K','L','M',
    'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
    '-'   # blank/separator
]

def _decode_lprnet(output):
    """Greedy CTC decode of LPRNet output [1, num_chars, seq_len]."""
    pred = np.argmax(output[0], axis=0)  # [seq_len]
    chars, prev = [], len(_CHARS) - 1
    for p in pred:
        if p != prev and p != len(_CHARS) - 1:
            chars.append(_CHARS[p])
        prev = p
    return ''.join(chars)


def load_object_detection_model(detector_path, names_path,
                                 ocr_path=None, providers=None):
    if providers is None:
        providers = ['CPUExecutionProvider']
    with open(names_path) as f:
        class_names = [l.strip() for l in f]
    colors = {n: [random.randint(0, 255) for _ in range(3)] for n in class_names}
    detector = ort.InferenceSession(detector_path, providers=providers)
    ocr_session = ort.InferenceSession(ocr_path, providers=providers) if ocr_path else None
    return (detector, ocr_session), class_names, colors


def object_detection(frame, sessions, class_names, colors):
    detector, ocr_session = sessions

    # --- Stage 1: plate detection ---
    image, ratio, dwdh = letterbox(frame.copy(), auto=False)
    inp = np.expand_dims(image.transpose(2, 0, 1).astype(np.float32) / 255, 0)
    inname  = [i.name for i in detector.get_inputs()]
    outname = [i.name for i in detector.get_outputs()]
    outputs = detector.run(outname, {inname[0]: inp})[0][0]

    boxes, confidence, classes, plate_texts = [], [], [], []
    for x0, y0, x1, y1, score, cls_id in outputs:
        if score < 0.35:
            continue
        box = np.array([x0, y0, x1, y1])
        box -= np.array(list(dwdh) * 2)
        box /= ratio
        x0i, y0i, x1i, y1i = box.round().astype(np.int32).tolist()
        confidence.append(round(float(score), 3))
        boxes.append([x0i, y0i, x1i - x0i, y1i - y0i])
        classes.append(int(cls_id))

        # --- Stage 2: OCR on cropped plate ---
        text = ""
        if ocr_session is not None:
            # Clamp crop to frame bounds
            h, w = frame.shape[:2]
            cx0, cy0 = max(0, x0i), max(0, y0i)
            cx1, cy1 = min(w, x1i), min(h, y1i)
            if cx1 > cx0 and cy1 > cy0:
                crop = frame[cy0:cy1, cx0:cx1]
                ocr_inp  = _preprocess_ocr_crop(crop)
                ocr_in   = [i.name for i in ocr_session.get_inputs()]
                ocr_out  = [i.name for i in ocr_session.get_outputs()]
                ocr_out  = ocr_session.run(ocr_out, {ocr_in[0]: ocr_inp})[0]
                text     = _decode_lprnet(ocr_out)
        plate_texts.append(text)

    return boxes, confidence, classes, class_names, plate_texts
```

---

## main.py Changes

```python
# Import signature change — add plate_texts return value
from object_detection import load_object_detection_model, get_labels

# Model paths
_detector_path = os.path.join(os.path.dirname(__file__), "plate_detector.onnx")
_names_path    = os.path.join(os.path.dirname(__file__), "plate.names")
_ocr_path      = os.path.join(os.path.dirname(__file__), "lprnet.onnx")

ort_session, class_names, colors = load_object_detection_model(
    _detector_path, _names_path, ocr_path=_ocr_path, providers=providers
)

# _run_inference — unpack plate_texts
def _run_inference(self, frame):
    from object_detection import object_detection
    boxes, confs, class_ids, classes, plate_texts = object_detection(
        frame, ort_session, class_names, colors
    )
    return get_labels(boxes, confs, class_ids, classes, plate_texts)

# OUTPUT_TOPIC
OUTPUT_TOPIC = "anpr_results"
```

---

## Kafka Payload

```json
{
  "frame_id": "gate_cam_1716000000.123",
  "frame_bytes": "<base64 JPEG>",
  "object_detection_results": [
    {
      "label": "license_plate",
      "x": 210, "y": 340, "w": 180, "h": 60,
      "confidence": 0.91,
      "plate_text": "MH12AB1234"
    }
  ]
}
```

---

## Resolution Tip

Plate text is small. Use higher resolution for the pipeline if cameras are far away:
```yaml
OUTPUT_WIDTH:  "1280"
OUTPUT_HEIGHT: "720"
```

Or lower FPS to compensate for the extra GPU memory:
```yaml
FPS: "1"
```

---

## requirements.txt Additions

```
# No extra packages needed for LPRNet ONNX
# For PaddleOCR instead:
# paddlepaddle==2.6.1
# paddleocr==2.7.3
```

---

## Indian Plate Format Regex (post-processing)

```python
import re
IND_PLATE = re.compile(r'^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$')

def clean_plate(text: str) -> str:
    text = text.upper().replace(' ', '').replace('-', '')
    return text if IND_PLATE.match(text) else ""
```
