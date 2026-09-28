"""
jewelry_reader.py — RTSP Frame Capture, Detection+Tracking, and Rule Engine
=============================================================================

Mirrors ppe_reader.py's RTSP capture + live-image-publishing mechanism, but
replaces PPE inference with YOLO detection + ByteTrack tracking and runs every
armed jewelry rule (see jewelry_rules.py) against the resulting FrameContext.
Rules publish directly to Kafka via jewelry_rules.AlertBus — there is no
separate "association" step like ppe_alerts.py, since jewelry alerts are
zone/timer/tracking driven rather than a single per-frame classification.
"""

import datetime as dt
import logging
import logging.handlers
import gzip
import shutil
import os
import threading
import time

import cv2

import jewelry_detection as jd
import jewelry_rules as jr
from jewelry_zones import build_geometry, iou


# ══════════════════════════════════════════════════════════════════════════
# Logger setup — mirrors ppe_reader.py's define_logger exactly
# ══════════════════════════════════════════════════════════════════════════

def define_logger(logger_path):
    os.makedirs(logger_path, exist_ok=True)
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

    def _make_handler(log_file):
        handler = logging.handlers.TimedRotatingFileHandler(
            filename=log_file, when='midnight', interval=1, backupCount=30, encoding='utf-8'
        )

        def _rotator(source, dest):
            with open(source, 'rb') as f_in, gzip.open(dest, 'wb') as f_out:
                shutil.copyfileobj(f_in, f_out)
            os.remove(source)
        handler.rotator = _rotator
        handler.namer = lambda name: name + ".gz"
        handler.setFormatter(fmt)
        return handler

    logger = logging.getLogger("jewelry_reader")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        logger.addHandler(_make_handler(f"{logger_path}/jewelry-reader.log"))
    return logger


# ══════════════════════════════════════════════════════════════════════════
# Live image publisher — identical mechanism to ppe_reader.py / frame_reader.py
# ══════════════════════════════════════════════════════════════════════════

def publish_image(live_path, camera_name, image_type, logger):
    try:
        import requests
        PUBLISH_API = 'http://node_backend:5000/api/monitor/'
        image_path = f"{live_path}/{image_type}.jpg"
        im_name = dt.datetime.now().replace(microsecond=0)
        data = {"camera_name": camera_name, "timestamp": im_name, "image_type": image_type}
        with open(image_path, "rb") as file:
            files = {"image": file}
            response = requests.post(PUBLISH_API, files=files, data=data, timeout=(3, 3))
            logger.info(f"Publish live image | camera={camera_name} | type={image_type} | status={response.status_code}")
    except Exception as e:
        logger.info(msg=f"Publish Image API error: {e}")


def draw_detections(frame, dets, person_role_ids):
    for d in dets:
        x1, y1, x2, y2 = [int(v) for v in d.box]
        is_person = d.cls_id in person_role_ids
        color = (56, 168, 255) if is_person else (255, 255, 255)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"{d.cls_name} {d.conf:.2f}"
        if d.track_id >= 0:
            label = f"ID{d.track_id} " + label
        cv2.putText(frame, label, (x1 + 3, max(y1 - 6, 12)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)
    return frame


# ══════════════════════════════════════════════════════════════════════════
# Main jewelry reader loop — mirrors ppe_reader.py's read_ppe_frames() structure
# ══════════════════════════════════════════════════════════════════════════

def read_jewelry_frames(camera_name: str, rtsp_id: str, video_path: str, fps: float, output_size: tuple):
    aksha_path = os.getenv("AKSHA_PATH")
    logger_path = aksha_path + "/" + camera_name + "/" + "log"
    live_path = aksha_path + "/" + camera_name + "/" + "live"

    os.makedirs(live_path, exist_ok=True)

    logger = define_logger(logger_path)
    logger.info(f"Jewelry reader starting | camera={camera_name} | rtsp={video_path} | target_fps={fps} | output_size={output_size}")

    # ── Load model once ──────────────────────────────────────────────────
    app_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(app_dir, "yolov10.onnx")
    try:
        model, class_names, name_to_id = jd.load_model(model_path)
        device = jd.resolve_device()
        logger.info(f"Jewelry detection model loaded | classes={len(class_names)} | device={device}")
    except Exception as e:
        logger.exception(f"Failed to load jewelry detection model: {e}")
        raise

    role_ids = jr.resolve_role_ids(jr.CFG, name_to_id)
    for role, ids in role_ids.items():
        tag = "OK  " if ids else "MISS"
        logger.info(f"[{tag}] role={role} -> class_ids={sorted(ids) if ids else 'none (rule idles)'}")
    person_role_ids = role_ids.get("person", set())

    # ── Zones/lines + rule engine (one "default" layout for now — no
    #    per-camera zone editor exists yet in the dashboard) ─────────────
    producer = jr.load_kafka_producer()
    bus = jr.AlertBus(jr.CFG, camera_name, producer, logger)
    fallback_tracker = jd.GreedyIoUTracker(iou_fn=iou)

    zones, lines = build_geometry("default", output_size[0], output_size[1])
    rules = jr.arm_rules(bus, jr.CFG, zones, lines, role_ids)
    logger.info(f"Jewelry rule engine armed | camera={camera_name} | rules={[type(r).__name__ for r in rules]}")

    prev_t = time.time()
    fps_window = []
    last_frame_at = time.time()

    # ── Outer restart loop — reconnects VideoCapture on stream drop ──────
    while True:
        if video_path.isnumeric():
            cap = cv2.VideoCapture(int(video_path))
        else:
            cap = cv2.VideoCapture(video_path)

        video_fps = cap.get(cv2.CAP_PROP_FPS)
        logger.info(f"Video capture opened | camera={camera_name} | source={video_path} | stream_fps={video_fps:.2f} | target_fps={fps}")

        skip_rate = round(video_fps / fps) if video_fps > fps else 1
        frame_no = 0
        incoming_frame_counter = 0
        processed_frame_counter = 0
        fps_log_time = dt.datetime.now()

        while True:
            try:
                ret = cap.grab()
                incoming_frame_counter += 1

                current_time = dt.datetime.now()
                time_diff = (current_time - fps_log_time).total_seconds()
                if time_diff >= 10:
                    logger.info(
                        f"camera={camera_name} | Incoming FPS: {incoming_frame_counter / time_diff:.2f} "
                        f"| Processed FPS: {processed_frame_counter / time_diff:.2f} | Skip Rate: {skip_rate}"
                    )
                    incoming_frame_counter = 0
                    processed_frame_counter = 0
                    fps_log_time = current_time

                if not ret:
                    logger.warning(f"RTSP grab failed — stream lost | camera={camera_name} | source={video_path}")
                    gap = time.time() - last_frame_at
                    if gap > jr.CFG["offline_timeout_s"]:
                        now = dt.datetime.now()
                        bus.emit("CAMERA_OFFLINE", t_now=time.time(), wall_time=now,
                                 frame_idx=0, subject="stream",
                                 metadata={"reason": "no frames", "gap_seconds": round(gap, 1)})
                    break  # exit inner loop -> outer while True reopens capture

                last_frame_at = time.time()
                frame_no += 1

                if frame_no % skip_rate == 0:
                    processed_frame_counter += 1
                    frame_no = 0

                    _, frame = cap.retrieve()
                    frame = cv2.resize(frame, output_size)

                    timestamp = dt.datetime.now()
                    frame_id = camera_name + "@" + str(timestamp.time())

                    t_now = time.time()
                    dt_seconds = t_now - prev_t
                    prev_t = t_now

                    t0 = time.time()
                    dets = jd.detect_and_track(
                        model, frame, class_names, person_role_ids, fallback_tracker,
                        jr.CFG["conf_threshold"], jr.CFG["iou_threshold"], jr.CFG["imgsz"], device,
                    )
                    infer_ms = (time.time() - t0) * 1000
                    persons = [d for d in dets if d.cls_id in person_role_ids]

                    ctx = jr.FrameContext(frame=frame, frame_idx=processed_frame_counter,
                                           t_now=t_now, wall_time=timestamp,
                                           dets=dets, persons=persons, dt=max(dt_seconds, 1e-3))

                    for rule in rules:
                        try:
                            rule.update(ctx)
                        except Exception as e:
                            logger.error(f"Rule {type(rule).__name__} failed | camera={camera_name} | error={e}")

                    logger.info(
                        f"[FRAME] frame_id={frame_id} | dets={len(dets)} | persons={len(persons)} "
                        f"| infer_ms={infer_ms:.1f}"
                    )

                    fps_window.append(1.0 / max(1e-6, time.time() - t0))
                    if len(fps_window) >= 30:
                        mean_fps = sum(fps_window) / len(fps_window)
                        fps_window = []
                        if mean_fps < jr.CFG["min_healthy_fps"]:
                            bus.emit("CAMERA_OFFLINE", t_now=t_now, wall_time=timestamp,
                                     frame_idx=processed_frame_counter, subject="low_fps",
                                     metadata={"reason": "low fps", "fps": round(mean_fps, 2)})

                    # ── Update live image slot + publish to UI ───────────
                    annotated = draw_detections(frame.copy(), dets, person_role_ids)
                    cv2.imwrite(f"{live_path}/workday.jpg", annotated)
                    cv2.imwrite(f"{live_path}/holiday.jpg", annotated)
                    threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                    threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()

            except Exception as e:
                logger.info(msg=f"error faced {e}")

        cap.release()
        logger.info(f"Video capture released — restarting session | camera={camera_name}")
