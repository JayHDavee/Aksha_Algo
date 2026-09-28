# Jewelry Custom Detection Model — Training

`data.yaml` defines the 9 core classes from `JEWELRY-STORE-CV-DESIGN.md`'s
"Detection Model" section. `classes_future.txt` lists the Phase-2 classes
(Jewelry Tray, Ring Display, etc.) — add those to `data.yaml` and re-annotate
once the core 9 classes are working.

## What's here vs. what isn't

This is a **training scaffold**, not a trained model. No annotated dataset
exists yet, and training a real YOLOv11 model needs real store footage,
hand-labeled bounding boxes, and GPU time — none of which can be produced by
writing code. Until that dataset exists, the jewelry detection service
(`aksha_backend/jewellary_usecase/app/`) keeps running against the existing
general-purpose `yolov10.onnx`, with `showcase_open`/`showcase_closed`
proxied to that model's `gate_open`/`gate_closed` classes (see
`jewelry_rules.py`'s `CFG["class_map"]`) — the same proxy technique the
reference notebook (`jewelry_store_ai_surveillance_aksha.py`) documents.

## 1. Collect and annotate data

- Pull 15–20 minutes of real footage per camera angle you plan to deploy to
  (counter, entrance, vault, gold-counter) — the 3 AI-generated demo clips in
  `../videos_rtsp/` are for pipeline testing only, not training data; a model
  trained on synthetic video will not transfer to a real store.
- Sample a frame every 2–5 seconds. Label with any YOLO-format annotator
  (CVAT, Roboflow, LabelImg) using the exact class list in `data.yaml`.
- Start with the classes most likely to be learnable from a static camera
  angle — `Showcase Open`/`Showcase Closed`/`Counter` — before committing to
  annotating all 9. ~300–500 annotated frames is enough to tell whether those
  three are learnable on your camera angles before scaling up.
- Drop annotated images into `dataset/images/{train,val}/` and their matching
  YOLO `.txt` label files into `dataset/labels/{train,val}/` (same filename,
  `.txt` extension, one line per box: `class_id x_center y_center width height`,
  all normalized 0–1).
- `Staff` vs `Customer` as separate detector classes is worth reconsidering
  before annotating at scale — see the reference notebook's own "What's
  missing" section: a YOLO box can't reliably tell a uniformed employee from
  a well-dressed customer across stores/lighting, and a zone-based heuristic
  (whoever is behind the counter is staff) or face recognition against a
  staff gallery is more robust. Decide this before labeling, since it changes
  the schema.

## 2. Train

```bash
pip install ultralytics
yolo detect train data=data.yaml model=yolo11n.pt imgsz=640 epochs=100 batch=16
```

Start from `yolo11n.pt` (nano) for fast iteration on a small dataset; move up
to `yolo11s.pt`/`yolo11m.pt` once you have enough data that model capacity
becomes the bottleneck rather than annotation volume.

## 3. Swap the trained model into the jewelry service

1. Copy the resulting `runs/detect/train/weights/best.pt` (or export to ONNX:
   `yolo export model=best.pt format=onnx`) into
   `aksha_backend/jewellary_usecase/app/`.
2. Update `jewelry_reader.py`'s `model_path` to point at the new file.
3. Update `jewelry_rules.py`'s `CFG["class_map"]` to bind directly to the new
   class names (`"showcase_open": "Showcase Open"`, `"showcase_closed":
   "Showcase Closed"`, `"cash_drawer_open": "Cash Drawer"`, `"safe_door_open":
   "Safe Door"`) instead of the `gate_open`/`gate_closed` proxies — this is
   the "one line of config per rule" swap the reference notebook is built
   around, no rule-class changes needed.
4. Update `deployment/Aksha/labels_jewelry.txt` and
   `aksha_backend/jewellary_usecase/app/jewelry_labels.txt` if the Object of
   Interest / internal label lists should reflect the new classes.
