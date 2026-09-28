"""
jewelry_detection.py — model load + detect-and-track for the jewelry service.

Uses Ultralytics' YOLO wrapper (not raw onnxruntime, unlike ppe_detection.py)
specifically so `.track(..., tracker="bytetrack.yaml")` is available for free —
every tracking-dependent rule (dwell, counter-jump, footfall, occupancy) needs
stable track IDs, and re-implementing ByteTrack by hand isn't worth it when
Ultralytics already bundles it.

Model: the same general-purpose yolov10.onnx used by object_detection_service
(13 classes: person, supine person, helmet, no_helmet, car, bicycle, truck,
motorbike, backpack, handbag, gate_open, gate_closed, fork_lift) — no
jewelry-specific model is trained yet, so showcase/drawer/safe-door rules bind
to the gate_open/gate_closed classes as proxies (see jewelry_rules.CLASS_MAP).
"""

from dataclasses import dataclass

import torch
from ultralytics import YOLO


def resolve_device():
    """Use a GPU if this container actually has one (CUDA-capable torch +
    a visible device), otherwise fall back to CPU — same image works in both
    environments, unlike object_detection_service's separate GPU/CPU builds."""
    return "cuda:0" if torch.cuda.is_available() else "cpu"


@dataclass
class Detection:
    box: tuple           # x1,y1,x2,y2 in pixels
    conf: float
    cls_id: int
    cls_name: str
    track_id: int = -1


class GreedyIoUTracker:
    """Fallback tracker: IoU matching + max_age.

    Deliberately simple; ByteTrack (via model.track()) is the production
    choice — this only exists so the pipeline degrades safely if the
    tracker ever returns no IDs for a frame (has happened with some
    end-to-end ONNX exports on certain Ultralytics versions).
    """

    def __init__(self, iou_fn, iou_thr=0.3, max_age=15):
        self.iou_fn = iou_fn
        self.iou_thr, self.max_age = iou_thr, max_age
        self.next_id, self.tracks = 1, {}   # id -> {box, missed}

    def update(self, dets):
        assigned, used = {}, set()
        pairs = []
        for di, d in enumerate(dets):
            for tid, t in self.tracks.items():
                s = self.iou_fn(d.box, t["box"])
                if s >= self.iou_thr:
                    pairs.append((s, di, tid))
        for s, di, tid in sorted(pairs, key=lambda p: -p[0]):
            if di in assigned or tid in used:
                continue
            assigned[di], used = tid, used | {tid}
        for di, d in enumerate(dets):
            tid = assigned.get(di)
            if tid is None:
                tid = self.next_id
                self.next_id += 1
            self.tracks[tid] = {"box": d.box, "missed": 0}
            d.track_id = tid
        for tid in list(self.tracks):
            if tid not in used and tid not in assigned.values():
                self.tracks[tid]["missed"] += 1
                if self.tracks[tid]["missed"] > self.max_age:
                    del self.tracks[tid]
        return dets


def load_model(model_path):
    model = YOLO(model_path, task="detect")
    class_names = model.names if isinstance(model.names, dict) else {i: n for i, n in enumerate(model.names)}
    name_to_id = {v: k for k, v in class_names.items()}
    return model, class_names, name_to_id


def detect_and_track(model, frame, class_names, person_role_ids, fallback_tracker, conf_threshold, iou_threshold, imgsz, device):
    res = model.track(frame, persist=True, tracker="bytetrack.yaml",
                       conf=conf_threshold, iou=iou_threshold,
                       imgsz=imgsz, device=device, verbose=False)[0]
    dets = []
    if res.boxes is None or len(res.boxes) == 0:
        return dets
    xyxy = res.boxes.xyxy.cpu().numpy()
    confs = res.boxes.conf.cpu().numpy()
    clss = res.boxes.cls.cpu().numpy().astype(int)
    ids = res.boxes.id.cpu().numpy().astype(int) if res.boxes.id is not None else None
    for i in range(len(xyxy)):
        dets.append(Detection(
            box=tuple(float(v) for v in xyxy[i]),
            conf=float(confs[i]), cls_id=int(clss[i]),
            cls_name=class_names.get(int(clss[i]), str(clss[i])),
            track_id=int(ids[i]) if ids is not None else -1,
        ))
    if ids is None:                       # tracker gave us nothing -> degrade safely
        person_like = [d for d in dets if d.cls_id in person_role_ids]
        fallback_tracker.update(person_like)
    return dets
