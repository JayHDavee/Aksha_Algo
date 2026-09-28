# Face Recognition Pod

Two-stage pipeline on top of `deepstream_service`:
1. **Detect** faces (YOLOv8-face or RetinaFace ONNX)
2. **Recognise** identity by comparing 512-d embedding against a database (ArcFace ONNX)

---

## Architecture

```
RTSP → NVDEC → FAST_PREFILTER → Stage 1: face detector (ONNX/TRT)
                                       ↓  crop + align face ROI
                               Stage 2: ArcFace embedding (ONNX/TRT)
                                       ↓  cosine similarity vs Redis/MongoDB embeddings
                               Kafka → { identity, confidence, bbox }
```

---

## Models

### Stage 1 — Face Detector

| Model | Size | Speed | Notes |
|---|---|---|---|
| **YOLOv8n-face** | 6MB | ~4ms | Best choice — same ONNX pipeline as detection |
| **RetinaFace-MobileNet** | 1.7MB | ~6ms | Includes 5 landmarks for alignment |
| **SCRFD-500M** | 2.5MB | ~3ms | NVIDIA recommended for DeepStream |

Export YOLOv8-face:
```bash
yolo export model=yolov8n-face.pt format=onnx imgsz=640 simplify=True dynamic=True
```

Output: `[batch, N, 6]` → `[x0, y0, x1, y1, score, class_id=0]`
With landmarks: `[batch, N, 16]` → `[x0, y0, x1, y1, score, lx0, ly0, lx1, ly1, lx2, ly2, lx3, ly3, lx4, ly4, class_id]`

### Stage 2 — Face Embedding (ArcFace)

| Model | Size | Embedding | Speed |
|---|---|---|---|
| **ArcFace-R18** | 92MB | 512-d | ~3ms |
| **ArcFace-R34** | 130MB | 512-d | ~6ms |
| **ArcFace-R100** | 249MB | 512-d | ~12ms |

Download from InsightFace model zoo, export to ONNX:
```python
import onnx
# Already available as .onnx from insightface model zoo
# buffalo_l pack: det_10g.onnx + w600k_r50.onnx
```

---

## Face Alignment (5-point)

Required before ArcFace — raw crops give poor accuracy. Align to a canonical 112×112 face.

```python
import cv2
import numpy as np

# ArcFace standard 5-landmark template (112×112)
_ARCFACE_SRC = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)

def align_face(img, landmarks_5pt):
    """
    img: RGB numpy (H, W, 3)
    landmarks_5pt: numpy (5, 2) — [left_eye, right_eye, nose, left_mouth, right_mouth]
    returns: aligned RGB face (112, 112, 3)
    """
    M, _ = cv2.estimateAffinePartial2D(
        landmarks_5pt.reshape(5, 1, 2),
        _ARCFACE_SRC.reshape(5, 1, 2),
        method=cv2.LMEDS
    )
    return cv2.warpAffine(img, M, (112, 112),
                          borderValue=0.0, flags=cv2.INTER_LINEAR)
```

If your detector does not output landmarks, skip alignment — just resize crop to 112×112. Accuracy drops ~5% but still works for clear frontal faces.

---

## Embedding Database

Store known face embeddings in **MongoDB** (persistent) and cache in **Redis** (fast lookup).

```python
# Store a known person
def register_face(name: str, embedding: np.ndarray, mongo_collection):
    mongo_collection.update_one(
        {"name": name},
        {"$set": {"embedding": embedding.tolist(), "name": name}},
        upsert=True
    )

# Load all embeddings into memory at startup
def load_known_faces(mongo_collection) -> dict[str, np.ndarray]:
    return {
        doc["name"]: np.array(doc["embedding"], dtype=np.float32)
        for doc in mongo_collection.find({})
    }

# Cosine similarity search
def find_identity(embedding: np.ndarray,
                  known: dict[str, np.ndarray],
                  threshold: float = 0.4) -> tuple[str, float]:
    best_name, best_sim = "unknown", 0.0
    emb_norm = embedding / (np.linalg.norm(embedding) + 1e-6)
    for name, ref in known.items():
        ref_norm = ref / (np.linalg.norm(ref) + 1e-6)
        sim = float(np.dot(emb_norm, ref_norm))
        if sim > best_sim:
            best_sim, best_name = sim, name
    if best_sim < threshold:
        return "unknown", best_sim
    return best_name, best_sim
```

Cosine similarity threshold guide:
- `> 0.5` — very confident match
- `0.4–0.5` — likely match
- `< 0.4` — unknown / stranger

---

## object_detection.py

```python
import cv2
import numpy as np
import onnxruntime as ort
import random

_ARCFACE_SRC = np.array([
    [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
    [41.5493, 92.3655], [70.7299, 92.2041],
], dtype=np.float32)


def get_labels(boxes, confs, class_ids, classes, identities=None):
    indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
    results = []
    for i in range(len(boxes)):
        if i in indexes:
            x, y, w, h = boxes[i]
            result = {"label": str(classes[class_ids[i]]),
                      "x": x, "y": y, "w": w, "h": h, "confidence": confs[i]}
            if identities:
                result["identity"]       = identities[i][0]
                result["face_similarity"] = identities[i][1]
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


def _align(img, lmks):
    M, _ = cv2.estimateAffinePartial2D(
        lmks.reshape(5, 1, 2), _ARCFACE_SRC.reshape(5, 1, 2), method=cv2.LMEDS)
    return cv2.warpAffine(img, M, (112, 112), borderValue=0.0)


def _arcface_preprocess(face_112):
    """Normalise 112×112 RGB face for ArcFace."""
    inp = (face_112.astype(np.float32) - 127.5) / 128.0
    return np.expand_dims(inp.transpose(2, 0, 1), 0)  # [1, 3, 112, 112]


def load_object_detection_model(detector_path, names_path,
                                 arcface_path=None, providers=None):
    if providers is None:
        providers = ['CPUExecutionProvider']
    with open(names_path) as f:
        class_names = [l.strip() for l in f]
    colors = {n: [random.randint(0, 255) for _ in range(3)] for n in class_names}
    detector = ort.InferenceSession(detector_path, providers=providers)
    arcface  = ort.InferenceSession(arcface_path, providers=providers) if arcface_path else None
    return (detector, arcface), class_names, colors


def object_detection(frame, sessions, class_names, colors,
                     known_faces=None, threshold=0.4):
    detector, arcface = sessions
    image, ratio, dwdh = letterbox(frame.copy(), auto=False)
    inp = np.expand_dims(image.transpose(2, 0, 1).astype(np.float32) / 255, 0)
    inname  = [i.name for i in detector.get_inputs()]
    outname = [i.name for i in detector.get_outputs()]
    raw     = detector.run(outname, {inname[0]: inp})[0][0]

    boxes, confidence, classes, identities = [], [], [], []
    has_landmarks = raw.shape[-1] >= 16   # 16 = bbox(4)+score(1)+lmks(10)+cls(1)

    for det in raw:
        score = float(det[4])
        if score < 0.35:
            continue
        x0, y0, x1, y1 = det[:4]
        box = np.array([x0, y0, x1, y1])
        box -= np.array(list(dwdh) * 2)
        box /= ratio
        x0i, y0i, x1i, y1i = box.round().astype(np.int32).tolist()
        confidence.append(round(score, 3))
        boxes.append([x0i, y0i, x1i - x0i, y1i - y0i])
        classes.append(0)

        identity = ("unknown", 0.0)
        if arcface is not None and known_faces:
            h, w = frame.shape[:2]
            cx0, cy0 = max(0, x0i), max(0, y0i)
            cx1, cy1 = min(w, x1i), min(h, y1i)
            if cx1 > cx0 and cy1 > cy0:
                if has_landmarks:
                    lmks = det[5:15].reshape(5, 2)
                    # Scale landmarks back to original frame coords
                    lmks -= np.array(list(dwdh) * 5).reshape(5, 2)
                    lmks /= ratio
                    face = _align(frame, lmks.astype(np.float32))
                else:
                    face = cv2.resize(frame[cy0:cy1, cx0:cx1], (112, 112))

                arc_in   = [i.name for i in arcface.get_inputs()]
                arc_out  = [i.name for i in arcface.get_outputs()]
                emb      = arcface.run(arc_out, {arc_in[0]: _arcface_preprocess(face)})[0][0]
                identity = _find_identity(emb, known_faces, threshold)
        identities.append(identity)

    return boxes, confidence, classes, class_names, identities


def _find_identity(emb, known, threshold):
    best_name, best_sim = "unknown", 0.0
    emb_n = emb / (np.linalg.norm(emb) + 1e-6)
    for name, ref in known.items():
        sim = float(np.dot(emb_n, ref / (np.linalg.norm(ref) + 1e-6)))
        if sim > best_sim:
            best_sim, best_name = sim, name
    return (best_name if best_sim >= threshold else "unknown", round(best_sim, 3))
```

---

## main.py Changes

```python
from object_detection import load_object_detection_model, get_labels
import pymongo

_detector_path = os.path.join(os.path.dirname(__file__), "yolov8n_face.onnx")
_names_path    = os.path.join(os.path.dirname(__file__), "face.names")   # just: face
_arcface_path  = os.path.join(os.path.dirname(__file__), "arcface_r18.onnx")

OUTPUT_TOPIC = "face_recognition_results"

# Load known faces from MongoDB at startup
_mongo   = pymongo.MongoClient(os.environ.get("MONGODB_URI"))
_faces_col = _mongo["Aksha"]["known_faces"]
known_faces = {doc["name"]: np.array(doc["embedding"]) for doc in _faces_col.find({})}

# _run_inference
def _run_inference(self, frame):
    from object_detection import object_detection
    boxes, confs, class_ids, classes, identities = object_detection(
        frame, ort_session, class_names, colors,
        known_faces=known_faces, threshold=0.4
    )
    return get_labels(boxes, confs, class_ids, classes, identities)
```

---

## Kafka Payload

```json
{
  "frame_id": "entrance_cam_1716000000.123",
  "frame_bytes": "<base64 JPEG>",
  "object_detection_results": [
    {
      "label": "face",
      "x": 312, "y": 145, "w": 92, "h": 110,
      "confidence": 0.94,
      "identity": "John_Doe",
      "face_similarity": 0.71
    },
    {
      "label": "face",
      "x": 480, "y": 160, "w": 88, "h": 104,
      "confidence": 0.88,
      "identity": "unknown",
      "face_similarity": 0.21
    }
  ]
}
```

---

## Register New Faces (CLI)

Add a one-off script `app/register_face.py` to enroll known people:

```python
import cv2, sys, numpy as np, pymongo, onnxruntime as ort, os

mongo = pymongo.MongoClient(os.environ["MONGODB_URI"])
col   = mongo["Aksha"]["known_faces"]

arcface = ort.InferenceSession("arcface_r18.onnx",
          providers=["CUDAExecutionProvider", "CPUExecutionProvider"])

def embed(img_path):
    img  = cv2.cvtColor(cv2.imread(img_path), cv2.COLOR_BGR2RGB)
    face = cv2.resize(img, (112, 112))
    inp  = ((face.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)
    emb  = arcface.run(None, {"input": np.expand_dims(inp, 0)})[0][0]
    return emb / np.linalg.norm(emb)

name, img_path = sys.argv[1], sys.argv[2]
emb = embed(img_path)
col.update_one({"name": name}, {"$set": {"name": name, "embedding": emb.tolist()}}, upsert=True)
print(f"Registered {name}")
```

Usage:
```bash
docker exec -it face_cam python3 app/register_face.py "John_Doe" /Aksha/faces/john.jpg
```

---

## requirements.txt Additions

```
# No extra packages needed for pure ONNX inference
# insightface is only needed for model download/export, not runtime
```

---

## Performance Notes

| Operation | Time | GPU? |
|---|---|---|
| Face detection (YOLOv8n-face) | ~4ms | TRT |
| Face alignment (cv2.warpAffine) | ~0.3ms | CPU |
| ArcFace embedding (R18) | ~3ms | TRT |
| Cosine search (100 known faces) | ~0.1ms | CPU numpy |
| Total per frame | ~7–8ms | mostly GPU |

VRAM: face detector (~50MB) + ArcFace R18 (~92MB) = ~142MB — well within 8GB RTX 2070.

At 20 cams × 3fps × 30% SSIM pass = 18 face-rec calls/sec × 8ms = 14% CUDA (same profile as object detection).
