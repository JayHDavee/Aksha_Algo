"""
object_detection — YOLOv10 ONNX inference helpers (single-frame and batch).

Inference pipeline:

  RGB frame (H×W×3)
    → letterbox(640×640, gray pad, aspect-preserved)   preserve ratio, pad shorter axis
    → HWC → CHW + float32 / 255                        normalise to [0, 1]
    → ORT session.run  shape [N, 3, 640, 640]          single GPU kernel for true-batch
    → raw output       shape [N, 300, 6]               x0,y0,x1,y1,score,cls_id  (xyxy)
    → threshold > 0.35                                 drop low-confidence detections
    → un-project coords (subtract padding, divide by scale ratio)
    → xyxy → xywh                                      NMSBoxes expects xywh
    → NMSBoxes (conf ≥ 0.5, IoU ≤ 0.4)                second pass — removes anchor dups
    → [{label, x, y, w, h, confidence}, ...]

Session setup:
  yolov10.onnx
    → _patch_topk_negative_axis()   axis=-1 → axis=1 so TRT/CUDA accept the graph
    → yolov10.onnx.patched.onnx
    → ORT InferenceSession          provider order: TRT FP16 → CUDA → CPU
"""

import cv2
import numpy as np
import onnx
import onnxruntime as ort
import random

# Cache input/output tensor names per ONNX session.
# Calling get_inputs()/get_outputs() on every frame is slow (list comprehension + FFI).
# Keyed by id(session) so each loaded session gets its own entry.
_session_io_cache = {}


def _get_io_names(ort_session):
    """Return (input_names, output_names) for *ort_session*, fetching once and caching by id."""
    # Return cached names if already fetched for this session object
    sid = id(ort_session)
    if sid not in _session_io_cache:
        _session_io_cache[sid] = (
            [i.name for i in ort_session.get_inputs()],   # e.g. ['images']
            [i.name for i in ort_session.get_outputs()],  # e.g. ['output0']
        )
    return _session_io_cache[sid]


def get_labels(boxes, confs, class_ids, classes):
    """
    Apply a second NMS pass and return detections as a list of dicts.

    Each dict: {label, x, y, w, h, confidence}  (xywh in original image coordinates).

    YOLOv10 includes NMS internally, but this second pass (IoU > 0.4) removes
    duplicates from overlapping anchor scales that slip through the model's own NMS.
    """
    # YOLOv10 ONNX already applies NMS internally, but duplicate detections can
    # still appear when different anchor scales fire on the same object.
    # This second NMS pass cleans up IoU > 0.4 overlaps before returning results.
    if not boxes:
        return []

    # score_threshold=0.5, nms_threshold=0.4
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
    # Resize the image to new_shape while preserving aspect ratio.
    # Padding (gray bars) is added symmetrically on the shorter axis.
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
        # Snap padding to a multiple of stride so the padded dims are stride-aligned
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
    return im, r, (dw, dh)  # return scale ratio and padding offsets for coordinate un-scaling


def _patch_topk_negative_axis(model_path):
    """
    Rewrite TopK axis=-1 → axis=1 in the ONNX graph and save a sibling .patched.onnx.

    Some YOLOv10 exporters emit axis=-1 on TopK nodes, which TensorRT and certain
    ORT backends reject.  Patching to axis=1 makes the model load cleanly on TRT,
    CUDA, and CPU providers without changing model semantics.  Returns the patched path.
    """
    # YOLOv10 ONNX models exported with some tools use axis=-1 on TopK nodes.
    # TensorRT and some ORT backends reject negative axis values.
    # This patch forces axis=1 on every TopK node so the model loads cleanly
    # on both TRT and CUDA execution providers.
    model = onnx.load(model_path)

    for node in model.graph.node:
        if node.op_type != "TopK":
            continue  # only patch TopK ops

        # Find the existing axis attribute (may be absent on some exported models)
        axis_attr = None
        for attr in node.attribute:
            if attr.name == "axis":
                axis_attr = attr
                break

        # YOLOv10 TopK output shape is [1, N, classes] — axis=1 is correct
        if axis_attr:
            axis_attr.i = 1  # overwrite whatever was there
        else:
            # Attribute missing entirely — add it explicitly
            node.attribute.append(
                onnx.helper.make_attribute("axis", 1)
            )

    # Save to a sibling file so the original is never modified on disk
    patched_path = model_path + ".patched.onnx"
    onnx.save(model, patched_path)

    return patched_path


def load_object_detection_model(model_path, names_path, providers=None):
    """
    Load and prepare a YOLOv10 ONNX model for inference.

    Steps:
      1. Parse class names from *names_path* (one label per line).
      2. Patch TopK axis in the ONNX graph so TRT/CUDA providers accept it.
      3. Create an ORT InferenceSession with the given provider priority list.
      4. Pre-warm the IO name cache so the first inference call pays no lookup cost.

    Returns:
      (ort_session, class_names, colors)
        colors — {class_name: [B, G, R]} random palette for bounding-box drawing
    """
    # Default to CPU if no provider list supplied
    if providers is None:
        providers = ['CPUExecutionProvider']

    # Load class names from coco.names (one label per line)
    with open(names_path, "r") as f:
        class_names = [line.strip() for line in f.readlines()]

    # Assign a random BGR color per class for bounding-box drawing
    colors = {name: [random.randint(0, 255) for _ in range(3)] for name in class_names}

    # Patch TopK axis before loading — TRT cache must not be built from an unpatched model
    patched_path = _patch_topk_negative_axis(model_path)

    # Create the ONNX Runtime inference session with the given provider priority list
    session = ort.InferenceSession(patched_path, providers=providers)

    # Pre-warm the IO name cache so the first inference call doesn't pay the lookup cost
    _get_io_names(session)

    return session, class_names, colors


def object_detection(frame, ort_session, class_names, colors):
    """Single-frame inference — used for model warmup and as a fallback."""
    inname, outname = _get_io_names(ort_session)

    # Letterbox to 640×640, auto=False uses exact padding (no stride snapping needed for inference)
    image, ratio, dwdh = letterbox(frame, auto=False)

    # HWC → CHW, add batch dim, normalise to [0, 1]
    image = image.transpose((2, 0, 1))
    im = np.expand_dims(image, 0).astype(np.float32) / 255

    # Run inference — output shape [1, 300, 6] where 6 = [x0,y0,x1,y1,score,cls_id]
    outputs = ort_session.run(outname, {inname[0]: im})[0][0]

    boxes, confidence, classes = [], [], []
    for x0, y0, x1, y1, score, cls_id in outputs:
        if score > 0.35:  # discard low-confidence detections
            box = np.array([x0, y0, x1, y1])
            # Undo letterbox padding offset, then undo the scale factor
            box -= np.array(list(dwdh) * 2)
            box /= ratio
            box = box.round().astype(np.int32).tolist()
            confidence.append(round(float(score), 3))
            # Convert xyxy → xywh for NMSBoxes compatibility
            boxes.append([int(box[0]), int(box[1]), int(box[2] - box[0]), int(box[3] - box[1])])
            classes.append(int(cls_id))

    return boxes, confidence, classes, class_names


def batch_object_detection(frames, ort_session, class_names, colors):
    """
    Batch inference over N frames using one shared ONNX/TRT session.
    Input:  list of N RGB numpy arrays (H, W, 3)
    Output: list of N detection-result lists (same format as get_labels)

    If the model's first input dim is dynamic (not fixed to 1), all frames are
    stacked into [N, 3, 640, 640] and run in a single GPU kernel call.
    If fixed batch_size=1, frames are run sequentially (one session.run per frame).
    Export with --dynamic to unlock true batching and higher GPU utilisation.
    """
    if not frames:
        return []

    inname, outname = _get_io_names(ort_session)

    # Preprocess all frames: letterbox + CHW transpose + float32 normalisation.
    # letterbox does not modify the input array, so no .copy() needed here.
    processed_list, ratios, dwdhs = [], [], []
    for frame in frames:
        proc, ratio, dwdh = letterbox(frame, auto=False)
        processed_list.append(proc.transpose((2, 0, 1)).astype(np.float32) / 255)
        ratios.append(ratio)
        dwdhs.append(dwdh)

    # Check whether the model was exported with a dynamic first (batch) dimension.
    # A static export has batch_dim == 1; a dynamic export has batch_dim as a string or 'None'.
    batch_dim = ort_session.get_inputs()[0].shape[0]
    use_true_batch = batch_dim != 1 and len(frames) > 1

    if use_true_batch:
        # True GPU batch: stack all frames into [N, 3, 640, 640] and run once
        inp = np.stack(processed_list, axis=0)
        all_outputs = ort_session.run(outname, {inname[0]: inp})[0]  # [N, 300, 6]
    else:
        # Static batch_size=1: run each frame in its own session.run call sequentially
        all_outputs = [
            ort_session.run(outname, {inname[0]: np.expand_dims(p, 0)})[0][0]
            for p in processed_list
        ]

    all_results = []
    for frame_outputs, ratio, dwdh in zip(all_outputs, ratios, dwdhs):
        boxes, confidence, classes = [], [], []
        for x0, y0, x1, y1, score, cls_id in frame_outputs:
            if score > 0.35:  # confidence threshold
                box = np.array([x0, y0, x1, y1])
                # Reverse letterbox: subtract padding offset then divide by scale
                box -= np.array(list(dwdh) * 2)
                box /= ratio
                box = box.round().astype(np.int32).tolist()
                confidence.append(round(float(score), 3))
                # xyxy → xywh
                boxes.append([int(box[0]), int(box[1]), int(box[2] - box[0]), int(box[3] - box[1])])
                classes.append(int(cls_id))
        # Apply second-pass NMS and format into label dicts
        all_results.append(get_labels(boxes, confidence, classes, class_names))

    return all_results
