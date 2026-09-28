"""
ppe_reader.py — RTSP Frame Capture, PPE Inference, and Live Image Publisher
=============================================================================

Mirrors frame_reader.py's RTSP capture + live-image-publishing mechanism,
but replaces the SSIM pre-filter + raw_frame Kafka publish with:
  - PPE (Harness model) inference on every decoded frame (no scene-skip)
  - Annotated (bounding-box) image saved to <AKSHA_PATH>/<camera>/ppe_output/
  - Same live image publish mechanism as frame_reader (workday.jpg/holiday.jpg
    POSTed to node_backend)
  - Person-PPE association + Kafka publish to ppe_results topic (Step 5)
"""

import datetime as dt
import logging
import logging.handlers
import gzip
import shutil
import os
import threading
import json
import base64

import cv2
import numpy as np
from kafka import KafkaProducer

import ppe_detection as pd
import ppe_alerts


# ══════════════════════════════════════════════════════════════════════════
# Kafka configuration
# ══════════════════════════════════════════════════════════════════════════

def load_kafka_config():
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"
        else:
            KAFKA_SERVER = "localhost:9092"
    return KAFKA_SERVER

KAFKA_SERVER = load_kafka_config()
producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)


# ══════════════════════════════════════════════════════════════════════════
# Logger setup — mirrors frame_reader.py's define_logger exactly
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

    logger = logging.getLogger("ppe_reader")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        logger.addHandler(_make_handler(f"{logger_path}/ppe-reader.log"))
    return logger


# ══════════════════════════════════════════════════════════════════════════
# Live image publisher — identical mechanism to frame_reader.py
# ══════════════════════════════════════════════════════════════════════════

def publish_image(live_path, camera_name, image_type, logger):
    """POST a live camera JPEG to the Node.js backend monitor API. Same as frame_reader.py."""
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


# ══════════════════════════════════════════════════════════════════════════
# Draw PPE detections on a frame
# ══════════════════════════════════════════════════════════════════════════

def draw_detections(frame, detections, colors):
    """Draw bounding boxes + labels for each PPE detection onto frame (in place)."""
    for det in detections:
        x, y, w, h = det["x"], det["y"], det["w"], det["h"]
        label = det["label"]
        conf = det["confidence"]
        color = colors.get(label, (0, 255, 0))
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
        cv2.putText(
            frame, f"{label} {conf:.2f}", (x, max(y - 8, 0)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2
        )
    return frame


# ══════════════════════════════════════════════════════════════════════════
# Main PPE reader loop — mirrors frame_reader.py's read_frames() structure
# ══════════════════════════════════════════════════════════════════════════

def read_ppe_frames(camera_name: str, rtsp_id: str, video_path: str, fps: float, output_size: tuple):
    """
    Capture frames from an RTSP stream, run PPE inference on every decoded
    frame, save annotated images to disk, publish live view to the UI, and
    publish structured per-person PPE alerts to the ppe_results Kafka topic.
    """
    aksha_path = os.getenv("AKSHA_PATH")
    logger_path  = aksha_path + "/" + camera_name + "/" + "log"
    live_path    = aksha_path + "/" + camera_name + "/" + "live"
    output_path  = aksha_path + "/" + camera_name + "/" + "ppe_output"

    os.makedirs(live_path, exist_ok=True)
    os.makedirs(output_path, exist_ok=True)

    logger = define_logger(logger_path)
    logger.info(f"PPE reader starting | camera={camera_name} | rtsp={video_path} | target_fps={fps} | output_size={output_size}")

    # ── Load PPE model once ──────────────────────────────────────────────
    app_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(app_dir, "best.onnx")
    names_path = os.path.join(app_dir, "ppe.names")
    try:
        ppe_service, class_names, colors = pd.load_ppe_detection_model(model_path, names_path)
        logger.info(f"PPE model loaded successfully | classes={len(class_names)}")
    except Exception as e:
        logger.exception(f"Failed to load PPE model: {e}")
        raise

    # ── Loading placeholder ──────────────────────────────────────────────
    try:
        LOADING_IMG = cv2.imread(os.path.join(app_dir, "LOADING_IMG.png"))
        cv2.imwrite(f"{live_path}/workday.jpg", LOADING_IMG)
        cv2.imwrite(f"{live_path}/holiday.jpg", LOADING_IMG)
        threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
        threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()
    except Exception as e:
        logger.info(msg=f"Live loading error: {e}")

    # ── Outer restart loop — reconnects VideoCapture on stream drop ──────
    while True:
        if video_path.isnumeric():
            cap = cv2.VideoCapture(int(video_path))
        else:
            cap = cv2.VideoCapture(video_path)

        video_fps = cap.get(cv2.CAP_PROP_FPS)
        logger.info(f"Video capture opened | camera={camera_name} | source={video_path} | stream_fps={video_fps:.2f} | target_fps={fps}")

        if video_fps > fps:
            skip_rate = round(video_fps / fps)
        else:
            skip_rate = 1
        logger.info(f"Skip rate | camera={camera_name} | skip_rate={skip_rate}")

        frame_no = 0
        incoming_frame_counter = 0
        processed_frame_counter = 0
        fps_log_time = dt.datetime.now()

        # ── Inner grab loop ───────────────────────────────────────────────
        while True:
            try:
                ret = cap.grab()
                incoming_frame_counter += 1

                current_time = dt.datetime.now()
                time_diff = (current_time - fps_log_time).total_seconds()
                if time_diff >= 10:
                    incoming_fps = incoming_frame_counter / time_diff
                    processed_fps = processed_frame_counter / time_diff
                    logger.info(
                        f"camera={camera_name} | Incoming FPS: {incoming_fps:.2f} "
                        f"| Processed FPS: {processed_fps:.2f} | Skip Rate: {skip_rate}"
                    )
                    incoming_frame_counter = 0
                    processed_frame_counter = 0
                    fps_log_time = current_time

                if not ret:
                    logger.warning(f"RTSP grab failed — stream lost | camera={camera_name} | source={video_path}")
                    try:
                        RTSP_ISSUE_IMG = cv2.imread(os.path.join(app_dir, "RTSP_ISSUE_IMG.png"))
                        cv2.imwrite(f"{live_path}/workday.jpg", RTSP_ISSUE_IMG)
                        cv2.imwrite(f"{live_path}/holiday.jpg", RTSP_ISSUE_IMG)
                        threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                        threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()
                    except Exception as e:
                        logger.info(msg=f"Handling publish api error: {e}")
                    break  # exit inner loop → outer while True reopens capture

                frame_no += 1

                if frame_no % skip_rate == 0:
                    processed_frame_counter += 1
                    frame_no = 0

                    _, frame = cap.retrieve()

                    timestamp = dt.datetime.now()
                    frame_id = camera_name + "@" + str(timestamp.time())
                    logger.info(f"[FRAME RECEIVED] frame_id={frame_id} | timestamp={timestamp}")

                    frame = cv2.resize(frame, output_size)

                    # ── Run PPE inference on EVERY decoded frame (ONCE) ──
                    t0 = dt.datetime.now()
                    boxes, confs, class_ids, classes = pd.ppe_detection(frame, ppe_service, class_names, colors)
                    detections = pd.get_labels(boxes, confs, class_ids, classes)
                    elapsed_ms = (dt.datetime.now() - t0).total_seconds() * 1000
                    logger.info(
                        f"PPE inference complete | frame_id={frame_id} | detections={len(detections)} | elapsed_ms={elapsed_ms:.1f}"
                    )

                    # ── Draw boxes on a copy for saving/publishing ───────
                    annotated = draw_detections(frame.copy(), detections, colors)

                    # ── Save annotated frame to output folder ────────────
                    out_file = f"{output_path}/{frame_id.replace(':', '-')}.jpg"
                    cv2.imwrite(out_file, annotated)
                    logger.info(f"Annotated frame saved | frame_id={frame_id} | path={out_file}")

                    # ── Person-PPE association + Kafka publish (Step 5) ──
                    try:
                        person_alerts = ppe_alerts.associate_ppe_to_persons(detections)
                        _, frame_encoded = cv2.imencode('.jpg', frame)
                        frame_b64 = base64.b64encode(frame_encoded.tobytes()).decode('utf-8')
                        for alert in person_alerts:
                            person_crop = ppe_alerts.crop_person(frame, alert["person_bbox"])
                            person_crop_b64 = None
                            if person_crop is not None:
                                _, crop_encoded = cv2.imencode('.jpg', person_crop)
                                person_crop_b64 = base64.b64encode(crop_encoded.tobytes()).decode('utf-8')
                            payload = {
                                "cam_name": camera_name,
                                "person_bbox": alert["person_bbox"],
                                "worn": alert["worn"],
                                "violated": alert["violated"],
                                "missing": alert["missing"],
                                "severity": alert["severity"],
                                "ppe_detections": alert["ppe_detections"],
                                "frame": frame_b64,
                                "person_crop": person_crop_b64,
                            }
                            producer.send("ppe_results", payload)
                            logger.info(
                                f"[PPE RESULT SENT] frame_id={frame_id} | severity={alert['severity']} "
                                f"| violated={alert['violated']}"
                            )
                    except Exception as e:
                        logger.error(f"PPE alert/Kafka publish failed | frame_id={frame_id} | error={e}")

                    # ── Update live image slot + publish to UI ───────────
                    cv2.imwrite(f"{live_path}/workday.jpg", annotated)
                    cv2.imwrite(f"{live_path}/holiday.jpg", annotated)
                    threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                    threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()

            except Exception as e:
                logger.info(msg=f"error faced {e}")

        cap.release()
        logger.info(f"Video capture released — restarting session | camera={camera_name}")