"""
object_detection — post-processing helpers for the nvinfer TRT pipeline.

In deepstream_batch_optimized, inference is handled entirely by nvinfer (C++/TRT FP16).
This module only handles post-processing of the raw tensor output:

  nvinfer tensor output  [N, 300, 6]  (x0,y0,x1,y1,score,cls_id  in network coords)
    → _parse_tensors() in main.py     scale coords back to original camera resolution
    → get_labels()                    second NMS pass (IoU ≤ 0.4) + format as dicts
    → [{label, x, y, w, h, confidence}, ...]

  letterbox() is retained for any CPU-side resize that needs aspect-ratio preservation
  (e.g. reference image generation), but is NOT called on the inference path.
"""

import cv2
import numpy as np


def get_labels(boxes, confs, class_ids, classes):
    """
    Apply a second NMS pass and return detections as a list of dicts.

    Each dict: {label, x, y, w, h, confidence}  (xywh in original camera coordinates).

    nvinfer's built-in NMS cleans most overlaps, but a second pass (IoU > 0.4) removes
    duplicates from overlapping anchor scales that slip through.
    """
    # YOLO ONNX output is already NMS-filtered by the model internally.
    # This second pass removes any remaining overlaps above 0.4 IoU.
    if not boxes:
        return []
    indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
    if len(indexes) == 0:
        return []
    # OpenCV 4.5+ returns a 1D array; older versions return [[i], [j], ...] — flatten handles both.
    # Use a set so the `i in indexes` membership check below is O(1) not O(n).
    indexes = set(indexes.flatten())
    all_results = []
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
    # Convert half-pixel padding to integer pixel counts for copyMakeBorder
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    # Add gray padding bars (114 matches YOLO training letterbox color)
    im = cv2.copyMakeBorder(im, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
    return im, r, (dw, dh)
