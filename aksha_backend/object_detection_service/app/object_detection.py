"""
object_detection — YOLOv10 ONNX inference helpers for object_detection_service (CPU).

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

  Execution provider: CPUExecutionProvider (no GPU in this service variant).
  For GPU/TRT inference see object_detection_service_gpu.
"""

import cv2
import numpy as np
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes):
	"""
	Post-process raw detections with a second NMS pass and return structured results.

	Architecture role
	─────────────────
	This is the final stage of the inference pipeline.  object_detection() already
	applies a confidence threshold (> 0.35) and coordinate un-projection.  This
	function applies a stricter confidence gate (0.5) via NMS and converts the
	surviving detections into the canonical dict format consumed by downstream
	Kafka topics (post_processor_service, alert_service, etc.).

	Why a second NMS?
	  YOLOv10 performs end-to-end NMS internally (no separate NMS head needed).
	  However, when multiple YOLO anchor scales detect the same object at slightly
	  different offsets, the built-in NMS may leave residual overlapping boxes.
	  This second pass with a tighter IoU threshold (0.4) removes those before
	  results leave this service.

	NMS thresholds chosen:
	  conf_threshold = 0.5  — stricter than the 0.35 pre-filter in object_detection()
	                          so only high-quality detections reach downstream.
	  nms_threshold  = 0.4  — two boxes overlapping by > 40 % IoU are considered the
	                          same object; keep only the higher-confidence one.

	Args:
	  boxes      — list of [x, y, w, h] in original image coordinates (pixels)
	  confs      — list of float confidence scores in [0, 1]
	  class_ids  — list of int class indices aligned with boxes/confs
	  classes    — full class-name list (index → label string), e.g. COCO 80-class

	Returns:
	  list of dicts: [{label, x, y, w, h, confidence}, ...]
	  Empty list if no detections survive NMS.
	"""
	# ── Guard: nothing to process ─────────────────────────────────────────────
	if not boxes:
		return []

	# ── NMS: suppress overlapping / low-confidence boxes ─────────────────────
	# NMSBoxes expects boxes as [x, y, w, h] (already in that form from object_detection).
	# Returns the *indices* of surviving boxes, not the boxes themselves.
	indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
	if len(indexes) == 0:
		return []

	# OpenCV 4.5+ returns a 1D array; older versions return [[i],[j],...].
	# Convert to a set so the membership check below is O(1) not O(n).
	indexes = set(indexes.flatten())

	# ── Build structured result list ──────────────────────────────────────────
	# Walk every (box, conf) pair; include only those whose index survived NMS.
	# class_ids[i] maps the integer class index to a human-readable label string.
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
	Resize *im* to *new_shape* with aspect-ratio-preserving padding (letterboxing).

	Architecture role
	─────────────────
	YOLOv10's ONNX input node expects a fixed [1, 3, 640, 640] tensor.  Naive
	cv2.resize would distort the image and degrade detection accuracy.  This
	function instead:
	  1. Scales the image uniformly so the longest side fits within new_shape.
	  2. Pads the shorter axis with gray bars (value 114, matching YOLO training).
	The returned ratio *r* and padding offsets *(dw, dh)* are used later by
	object_detection() to project detections back to original image coordinates.

	Parameters
	──────────
	im        — input image, BGR or RGB, shape (H, W, C)
	new_shape — target (height, width); default 640×640 for YOLOv10
	color     — padding fill value; 114 matches the YOLO training letterbox gray
	auto      — if True, snap total padding to a multiple of *stride* so the
	            padded dimension is stride-aligned (useful during training/eval,
	            disabled during pure inference via auto=False)
	scaleup   — if False, only shrink images, never enlarge (improves val mAP on
	            images already smaller than new_shape)
	stride    — network stride, used only when auto=True

	Returns
	───────
	im       — letterboxed image, shape (new_shape[0], new_shape[1], C)
	r        — uniform scale ratio  (resized_size / original_size)
	            used in object_detection() as:  box_orig = (box_net - pad) / r
	(dw, dh) — half-padding added on each side (float, before rounding)
	            object_detection() subtracts [dw, dh, dw, dh] before dividing by r
	"""
	shape = im.shape[:2]  # current (H, W)
	if isinstance(new_shape, int):
		new_shape = (new_shape, new_shape)

	# ── Step 1: compute uniform scale ratio ──────────────────────────────────
	# Use the *smaller* ratio so the entire image fits without cropping.
	# e.g. a 1280×720 frame → min(640/720, 640/1280) = 0.5 → 640×360 before padding
	r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
	if not scaleup:
		r = min(r, 1.0)  # clamp: never enlarge a small image (hurts val mAP)

	# ── Step 2: dimensions after uniform scaling, before padding ─────────────
	# Round to the nearest pixel; note (W, H) order for cv2.resize.
	new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))

	# ── Step 3: total padding needed on each axis ─────────────────────────────
	# dw = pixels to add horizontally, dh = pixels to add vertically.
	dw, dh = new_shape[1] - new_unpad[0], new_shape[0] - new_unpad[1]

	if auto:
		# Snap padding to a stride multiple so the final dimension is stride-aligned.
		# e.g. stride=32: dw=27 → dw=27%32=27 … keeps min padding while aligning.
		dw, dh = np.mod(dw, stride), np.mod(dh, stride)

	# ── Step 4: split padding evenly between both sides of each axis ─────────
	# Dividing by 2 means equal gray bars top+bottom and left+right.
	# The resulting dw/dh (possibly non-integer) is returned for un-projection.
	dw /= 2
	dh /= 2

	# ── Step 5: resize if needed ─────────────────────────────────────────────
	if shape[::-1] != new_unpad:  # shape[::-1] = (W, H); skip if already correct size
		im = cv2.resize(im, new_unpad, interpolation=cv2.INTER_LINEAR)

	# ── Step 6: add gray border bars ─────────────────────────────────────────
	# Round half-padding to integers: subtract 0.1 from the top/left side so
	# that a fractional half (e.g. 0.5) always rounds down on one side, keeping
	# the total padding exactly equal to dw*2 / dh*2.
	top,    bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
	left,   right  = int(round(dw - 0.1)), int(round(dw + 0.1))

	# BORDER_CONSTANT fills with a solid colour (114 gray matches training padding)
	im = cv2.copyMakeBorder(im, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
	return im, r, (dw, dh)


def load_object_detection_model(RELATIVE_PATH_YOLO, RELATIVE_PATH_COCO, cuda=False):
	"""
	Load the YOLOv10 ONNX model and return the session, class names, and colour palette.

	Args:
	  RELATIVE_PATH_YOLO — path to the .onnx weights file
	  RELATIVE_PATH_COCO — path to coco.names (one label per line)
	  cuda               — if True, prefer CUDAExecutionProvider over CPU

	Returns:
	  (ort_session, class_names, colors)
	    colors — {class_name: [B, G, R]} random palette (one colour per class)
	"""
	# CPU-only service: ignore cuda flag, always use CPUExecutionProvider
	providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if cuda else ['CPUExecutionProvider']

	# Parse class labels from coco.names — one label per line, stripped of whitespace
	with open(RELATIVE_PATH_COCO, "r") as f:
		class_names = [line.strip() for line in f.readlines()]

	# Assign a random BGR colour per class — used for any downstream bounding-box drawing
	colors = {
		name: [random.randint(0, 255) for _ in range(3)]
		for i, name in enumerate(class_names)
	}

	# Create the ONNX Runtime inference session with the selected provider list
	ort_session = ort.InferenceSession(RELATIVE_PATH_YOLO, providers=providers)

	return ort_session, class_names, colors


def object_detection(frame, object_detection_service, class_names, colors):
	"""
	Run single-frame YOLOv10 inference on *frame* and return raw detection arrays.

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

	# ── Step 4: ONNX Runtime inference ───────────────────────────────────────
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
