import cv2
import numpy as np 
import onnxruntime as ort
import random


def get_labels(boxes, confs, class_ids, classes):
    """
    Post-process raw detections with NMS and return structured results.

    Args:
        boxes      — list of [x, y, w, h] in original image coordinates (pixels)
        confs      — list of float confidence scores in [0, 1]
        class_ids  — list of int class indices aligned with boxes/confs
        classes    — full class-name list (index → label string), PPE 8-class

    Returns:
        list of dicts: [{label, x, y, w, h, confidence}, ...]
        Empty list if no detections survive NMS.
    """
    if not boxes:
        return []

    indexes = cv2.dnn.NMSBoxes(boxes, confs, 0.5, 0.4)
    if len(indexes) == 0:
        return []

    indexes = set(indexes.flatten())

    all_results = []
    for i, conf in zip(range(len(boxes)), confs):
        if i in indexes:
            x, y, w, h = boxes[i]
            label = str(classes[class_ids[i]])
            all_results.append({
                "label": label,
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "confidence": conf,
            })
    return all_results


def letterbox(im, new_shape=(640, 640), color=(114, 114, 114), auto=True, scaleup=True, stride=32):
    # Resize and pad image while meeting stride-multiple constraints
    shape = im.shape[:2]  # current shape [height, width]
    if isinstance(new_shape, int):
        new_shape = (new_shape, new_shape)

    # Scale ratio (new / old)
    r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
    if not scaleup:  # only scale down, do not scale up (for better val mAP)
        r = min(r, 1.0)

    # Compute padding
    new_unpad = int(round(shape[1] * r)), int(round(shape[0] * r))
    dw, dh = new_shape[1] - new_unpad[0], new_shape[0] - new_unpad[1]  # wh padding

    if auto:  # minimum rectangle
        dw, dh = np.mod(dw, stride), np.mod(dh, stride)  # wh padding

    dw /= 2  # divide padding into 2 sides
    dh /= 2

    if shape[::-1] != new_unpad:  # resize
        im = cv2.resize(im, new_unpad, interpolation=cv2.INTER_LINEAR)
    top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
    left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
    im = cv2.copyMakeBorder(im, top, bottom, left, right,
                            cv2.BORDER_CONSTANT, value=color)  # add border
    return im, r, (dw, dh)


def load_ppe_detection_model(model_path, names_path, cuda=False):
    """
    Load the PPE detection ONNX model and return the session, class names, and colour palette.

    Args:
        model_path — path to best.onnx weights file
        names_path — path to ppe.names (one label per line)
        cuda       — if True, prefer CUDAExecutionProvider over CPU

    Returns:
        (ort_session, class_names, colors)
    """
    providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if cuda else ['CPUExecutionProvider']

    with open(names_path, "r") as f:
        class_names = [line.strip() for line in f.readlines()]

    colors = {name: [random.randint(0, 255) for _ in range(3)] for name in class_names}

    ppe_detection_service = ort.InferenceSession(model_path, providers=providers)

    return ppe_detection_service, class_names, colors


def ppe_detection(frame, ppe_detection_service, class_names, colors):
    """
    Run single-frame PPE (Harness model) inference and return raw detection arrays.

    Args:
        frame                    — BGR numpy array (H, W, 3)
        ppe_detection_service    — ORT InferenceSession from load_ppe_detection_model
        class_names              — list of class label strings
        colors                   — {label: [B,G,R]} palette (unused here, kept for API compat)

    Returns:
        (boxes, confidence, classes, class_names)
    """
    img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    image, ratio, dwdh = letterbox(img.copy(), auto=False)
    image = image.transpose((2, 0, 1))
    im = np.expand_dims(image, 0).astype(np.float32) / 255

    outname = [i.name for i in ppe_detection_service.get_outputs()]
    inname = [i.name for i in ppe_detection_service.get_inputs()]
    outputs = ppe_detection_service.run(outname, {inname[0]: im})[0][0]

    confidence, boxes, classes = [], [], []
    for x0, y0, x1, y1, score, cls_id in outputs:
        if score <= 0.35:
            continue

        box = np.array([x0, y0, x1, y1])
        box -= np.array(dwdh * 2)
        box /= ratio
        box = box.round().astype(np.int32).tolist()

        confidence.append(round(float(score), 3))
        boxes.append([
            int(box[0]),
            int(box[1]),
            int(box[2] - box[0]),
            int(box[3] - box[1]),
        ])
        classes.append(int(cls_id))

    return boxes, confidence, classes, class_names