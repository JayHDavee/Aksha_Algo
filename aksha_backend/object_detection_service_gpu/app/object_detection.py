"""
object_detection — YOLOv10 ONNX inference helpers for object_detection_service_gpu (GPU/TRT).

Inference pipeline (called per Kafka frame in main.py):

  BGR frame (H×W×3)  — from cv2.imread or base64 decode
    → BGR → RGB conversion          (YOLO was trained on RGB images)
    → letterbox(640×640, auto=False) resize + gray-pad, preserve aspect ratio
    → HWC → CHW transpose           match ONNX input layout
    → add batch dim + float32/255   normalise to [0, 1]
    → ORT session.run  shape [1, 3, 640, 640]
    → raw output       shape [1, 300, 6]  (x0,y0,x1,y1,score,cls_id  in network coords)
    → threshold > 0.35               discard low-confidence detections
    → un-project coords              subtract letterbox padding, divide by scale ratio
    → xyxy → xywh                   convert to NMSBoxes-compatible format
    → get_labels() / NMSBoxes        second NMS pass (conf ≥ 0.5, IoU ≤ 0.4)
    → [{label, x, y, w, h, confidence}, ...]

  Execution provider priority: TensorRT FP16 → CUDA → CPU
    (provider list is built in main.py and passed to load_object_detection_model)
  For CPU-only inference see object_detection_service.
"""

import cv2
import numpy as np
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes):
	"""
	Apply a second NMS pass and return detections as a list of dicts.

	YOLOv10 applies end-to-end NMS internally, but overlapping anchor scales
	can still produce duplicates. This second pass (conf ≥ 0.5, IoU ≤ 0.4)
	removes them before the result reaches downstream services.

	Args:
	  boxes      — list of [x, y, w, h] in original image coordinates
	  confs      — list of float confidence scores (0–1)
	  class_ids  — list of int class indices
	  classes    — full class-name list (index → label string)

	Returns:
	  list of dicts: [{label, x, y, w, h, confidence}, ...]
	"""
	if not boxes:
		return []

	indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
	if len(indexes) == 0:
		return []

	# OpenCV 4.5+ returns a 1D array; older versions return [[i],[j],...].
	# Convert to a set so the membership check below is O(1) not O(n).
	indexes = set(indexes.flatten())

	all_results = []
	for i, conf in zip(range(len(boxes)), confs):
		if i in indexes:
			x, y, w, h = boxes[i]
			label = str(classes[class_ids[i]])
			all_results.append({
				"label":      label,
				"x":          x,
				"y":          y,
				"w":          w,
				"h":          h,
				"confidence": conf,
			})
	return all_results


def letterbox(im, new_shape=(640, 640), color=(114, 114, 114), auto=True, scaleup=True, stride=32):
	"""
	Resize *im* to *new_shape* while preserving aspect ratio, padding the shorter
	axis with gray bars (value 114 — matches the YOLO training letterbox colour).

	Returns:
	  im       — letterboxed image (H', W', C)
	  r        — scale ratio applied (original → resized); needed to un-project detections
	  (dw, dh) — half-pixel padding added on each side; needed to un-project detections
	"""
	shape = im.shape[:2]  # current (H, W)
	if isinstance(new_shape, int):
		new_shape = (new_shape, new_shape)

	# Scale factor: use the smaller ratio so the entire image fits within new_shape
	r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
	if not scaleup:
		r = min(r, 1.0)  # only scale down, never up (improves val mAP)

	# Dimensions after scaling (before padding)
	new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))

	# How much padding is needed to reach new_shape
	dw, dh = new_shape[1] - new_unpad[0], new_shape[0] - new_unpad[1]

	if auto:
		# Snap padding to a multiple of stride so the padded dimensions are stride-aligned
		dw, dh = np.mod(dw, stride), np.mod(dh, stride)

	# Distribute padding evenly on both sides
	dw /= 2
	dh /= 2

	if shape[::-1] != new_unpad:
		im = cv2.resize(im, new_unpad, interpolation=cv2.INTER_LINEAR)

	# Convert half-pixel padding to integer pixel counts for copyMakeBorder
	top,    bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
	left,   right  = int(round(dw - 0.1)), int(round(dw + 0.1))

	# Add gray border bars (114 matches the training-time letterbox fill colour)
	im = cv2.copyMakeBorder(im, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
	return im, r, (dw, dh)


def load_object_detection_model(RELATIVE_PATH_YOLO, RELATIVE_PATH_COCO, cuda=False, providers=None):
	"""
	Load the YOLOv10 ONNX model and return the session, class names, and colour palette.

	Args:
	  RELATIVE_PATH_YOLO — path to the .onnx weights file
	  RELATIVE_PATH_COCO — path to coco.names (one label per line)
	  cuda               — legacy flag: prefer CUDA over CPU (ignored when providers given)
	  providers          — explicit ORT provider list; overrides cuda flag when supplied.
	                       Typically built by main.py as TRT FP16 → CUDA → CPU.

	Returns:
	  (ort_session, class_names, colors)
	    colors — {class_name: [B, G, R]} random palette (one colour per class)
	"""
	# Use the explicit provider list if given; fall back to cuda flag for backward compat
	if providers is None:
		providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if cuda else ['CPUExecutionProvider']

	# Parse class labels from coco.names — one label per line, stripped of whitespace
	with open(RELATIVE_PATH_COCO, "r") as f:
		class_names = [line.strip() for line in f.readlines()]

	# Assign a random BGR colour per class — used for any downstream bounding-box drawing
	colors = {
		name: [random.randint(0, 255) for _ in range(3)]
		for i, name in enumerate(class_names)
	}

	# Create the ONNX Runtime inference session with the selected provider priority list
	ort_session = ort.InferenceSession(RELATIVE_PATH_YOLO, providers=providers)

	return ort_session, class_names, colors


def object_detection(frame, object_detection_service, class_names, colors):
	"""
	Run single-frame YOLOv10 GPU inference on *frame* and return raw detection arrays.

	Args:
	  frame                    — BGR numpy array (H, W, 3) as returned by cv2.imread
	  object_detection_service — ORT InferenceSession from load_object_detection_model
	  class_names              — list of class label strings (len = num classes)
	  colors                   — {label: [B,G,R]} palette (unused here, kept for API compat)

	Returns:
	  (boxes, confidence, classes, class_names)
	    boxes      — list of [x, y, w, h] in original image coordinates
	    confidence — list of float scores
	    classes    — list of int class indices
	    class_names — full label list (passed through for get_labels)
	"""
	# ── Step 1: colour-space conversion ──────────────────────────────────────
	# YOLOv10 was trained on RGB images; OpenCV loads BGR.  Convert before letterbox.
	img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

	# ── Step 2: letterbox resize + padding → 640×640 ─────────────────────────
	# auto=False: use exact 640×640 padding (no stride snapping needed for inference)
	image, ratio, dwdh = letterbox(img.copy(), auto=False)

	# ── Step 3: HWC → CHW + batch dim + normalise to [0, 1] ─────────────────
	image = image.transpose((2, 0, 1))          # (H, W, C) → (C, H, W)
	im    = np.expand_dims(image, 0).astype(np.float32) / 255  # → [1, 3, 640, 640]

	# ── Step 4: ONNX Runtime inference (TRT/CUDA/CPU depending on provider) ──
	# Output shape: [1, 300, 6]  where 6 = [x0, y0, x1, y1, score, cls_id]
	outname = [i.name for i in object_detection_service.get_outputs()]
	inname  = [i.name for i in object_detection_service.get_inputs()]
	outputs = object_detection_service.run(outname, {inname[0]: im})[0][0]

	# ── Step 5: decode detections ────────────────────────────────────────────
	confidence, boxes, classes = [], [], []
	for x0, y0, x1, y1, score, cls_id in outputs:
		if score <= 0.35:
			continue  # discard low-confidence detections

		box = np.array([x0, y0, x1, y1])

		# Un-project step A: subtract letterbox padding offset (applied symmetrically)
		box -= np.array(dwdh * 2)
		# Un-project step B: scale back from network resolution to original image size
		box /= ratio

		box = box.round().astype(np.int32).tolist()
		confidence.append(round(float(score), 3))

		# Convert xyxy → xywh for NMSBoxes compatibility
		boxes.append([
			int(box[0]),
			int(box[1]),
			int(box[2] - box[0]),   # width
			int(box[3] - box[1]),   # height
		])
		classes.append(int(cls_id))

	return boxes, confidence, classes, class_names
