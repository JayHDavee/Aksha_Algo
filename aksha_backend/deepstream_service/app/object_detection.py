"""
object_detection — YOLOv10 ONNX inference helpers for deepstream_service.

Single-camera inference pipeline (called from DeepStreamService._run_inference):

  RGB frame (H×W×3)
    → letterbox(640×640, gray pad, aspect-preserved)
    → HWC → CHW + float32 / 255
    → ORT session.run  shape [1, 3, 640, 640]
    → raw output       shape [1, 300, 6]  (x0,y0,x1,y1,score,cls_id)
    → threshold > 0.35
    → un-project coordinates  (subtract padding, divide by scale ratio)
    → xyxy → xywh
    → get_labels() — NMSBoxes (conf ≥ 0.5, IoU ≤ 0.4)
    → [{label, x, y, w, h, confidence}, ...]

  Session setup:
    yolov10.onnx → ORT InferenceSession (TRT FP16 → CUDA → CPU)
"""

import cv2
import numpy as np
import datetime as dt
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes):
	"""
	Apply NMS and return detections as a list of dicts.

	Each dict: {label, x, y, w, h, confidence}  (xywh in original image coordinates).

	YOLOv10 includes end-to-end NMS internally, but this second pass (IoU > 0.4)
	removes duplicates from overlapping anchor scales that slip through.
	"""
	indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
	all_results = []
	if len(indexes) == 0:
		return all_results
	# OpenCV 4.5+ returns a 1D array; older versions return [[i],[j],...] — flatten handles both.
	# Use a set so the membership check below is O(1) not O(n).
	indexes = set(indexes.flatten())
	for i, j in zip(range(len(boxes)), confs):
		if i in indexes:
			x, y, w, h = boxes[i]
			label = str(classes[class_ids[i]])
			all_results.append({"label": label, "x": x, "y": y, "w": w, "h": h, "confidence": j})
	return all_results


def letterbox(im, new_shape=(640, 640), color=(114, 114, 114), auto=True, scaleup=True, stride=32):
	"""
	Resize *im* to *new_shape* while preserving aspect ratio, padding the shorter
	axis with gray bars (value 114, matching the YOLO training letterbox color).

	Returns:
	  im       — letterboxed image (H', W', C)
	  r        — scale ratio applied (original → resized), needed to un-project detections
	  (dw, dh) — half-pixel padding added on each side, needed to un-project detections
	"""
	shape = im.shape[:2]  # current (H, W)
	if isinstance(new_shape, int):
		new_shape = (new_shape, new_shape)

	# Scale factor — use the smaller ratio so the image fits within new_shape
	r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
	if not scaleup:
		r = min(r, 1.0)  # only scale down, never up

	# Dimensions after scaling (before padding)
	new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))
	# Padding needed to reach new_shape
	dw, dh = new_shape[1] - new_unpad[0], new_shape[0] - new_unpad[1]

	if auto:
		# Snap padding to a multiple of stride so padded dims are stride-aligned
		dw, dh = np.mod(dw, stride), np.mod(dh, stride)

	# Split padding evenly on both sides
	dw /= 2
	dh /= 2

	if shape[::-1] != new_unpad:
		im = cv2.resize(im, new_unpad, interpolation=cv2.INTER_LINEAR)
	# Convert half-pixel padding to integer counts for copyMakeBorder
	top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
	left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
	# Add gray padding bars (114 matches YOLO training letterbox color)
	im = cv2.copyMakeBorder(im, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
	return im, r, (dw, dh)


def load_object_detection_model(RELATIVE_PATH_YOLO, RELATIVE_PATH_COCO, cuda=False, providers=None):
	"""
	Load the YOLOv10 ONNX model and return the session, class names, and color palette.

	Args:
	  RELATIVE_PATH_YOLO: path to the .onnx model file
	  RELATIVE_PATH_COCO: path to coco.names (one label per line)
	  cuda:               ignored when *providers* is given; kept for backwards compatibility
	  providers:          ORT execution provider list (TRT FP16 → CUDA → CPU)

	Returns:
	  (ort_session, class_names, colors)
	    colors — {class_name: [B, G, R]} random palette for bounding-box drawing
	"""
	if providers is None:
		providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if cuda else ['CPUExecutionProvider']

	with open(RELATIVE_PATH_COCO, "r") as f:
		class_names = [line.strip() for line in f.readlines()]
	# Assign a random BGR colour per class for bounding-box drawing
	colors = {name: [random.randint(0, 255) for _ in range(3)] for i, name in enumerate(class_names)}

	object_detection_service = ort.InferenceSession(RELATIVE_PATH_YOLO, providers=providers)
	return object_detection_service, class_names, colors


def object_detection(frame, object_detection_service, class_names, colors):
	"""
	Run single-frame YOLOv10 inference and return raw detection arrays.

	Args:
	  frame:                    RGB numpy array (H, W, 3)
	  object_detection_service: ORT InferenceSession loaded by load_object_detection_model

	Returns:
	  (boxes, confidence, classes, class_names)
	    boxes      — list of [x, y, w, h] in original image coordinates
	    confidence — list of float scores
	    classes    — list of int class indices
	"""
	image, ratio, dwdh = letterbox(frame.copy(), auto=False)
	# HWC → CHW, add batch dim, normalise to [0, 1]
	image = image.transpose((2, 0, 1))
	image = np.expand_dims(image, 0)
	im = image.astype(np.float32) / 255

	outname = [i.name for i in object_detection_service.get_outputs()]
	inname  = [i.name for i in object_detection_service.get_inputs()]
	# Run inference — output shape [1, 300, 6] where 6 = [x0,y0,x1,y1,score,cls_id]
	outputs = object_detection_service.run(outname, {inname[0]: im})[0][0]

	confidence, boxes, classes = [], [], []
	for x0, y0, x1, y1, score, cls_id in outputs:
		if score > 0.35:  # discard low-confidence detections
			box = np.array([x0, y0, x1, y1])
			# Undo letterbox padding offset, then undo scale factor
			box -= np.array(dwdh * 2)
			box /= ratio
			box = box.round().astype(np.int32).tolist()
			confidence.append(round(float(score), 3))
			# Convert xyxy → xywh for NMSBoxes compatibility
			boxes.append([int(box[0]), int(box[1]), int(box[2] - box[0]), int(box[3] - box[1])])
			classes.append(int(cls_id))

	return boxes, confidence, classes, class_names
