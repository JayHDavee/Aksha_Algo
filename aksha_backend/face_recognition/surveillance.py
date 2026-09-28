import cv2
import os
import time
import datetime as dt
import logging
import numpy as np
import requests
from logging.handlers import RotatingFileHandler
from face_recognition import process_single_frame_for_api
from db import load_database

SAVE_ROOT = os.environ.get("AKSHA_PATH")
UNKNOWN_FRAME_THRESHOLD = 5

def ensure_directory(base_dir, ts, logger):
    try:
        date_str = ts.strftime("%Y-%m-%d")
        live_path = os.path.join(base_dir, "live")
        alert_date_path = os.path.join(base_dir, "alerts", date_str)
        unauth_date_path = os.path.join(base_dir, "unauthorised", date_str)

        os.makedirs(live_path, exist_ok=True)
        os.makedirs(alert_date_path, exist_ok=True)
        os.makedirs(unauth_date_path, exist_ok=True)

        logger.info("Directory structure ensured")
    except Exception as e:
        logger.error(f"Directory creation error: {e}")

    return live_path, alert_date_path, unauth_date_path

def log_to_db(collection, timestamp, detection_results, is_alert, cam_name, logger):
    if collection is None:
        return
    try:
        result_meta = {
            "Timestamp": timestamp,
            "CameraName": cam_name,
            "FaceRecognitionResults": detection_results,
            "AlertTriggered": is_alert,
        }
        collection.insert_one(result_meta)
        logger.info(f"Database entry saved @ {timestamp}")
    except Exception as e:
        logger.error(f"MongoDB error: {e}")

def publish_image(session, live_path_dir, update_camera_name, timestamp_obj, logger):
    try:
        api = "http://node_backend:5000/api/monitor/"
        image_path = os.path.join(live_path_dir, "workday.jpg")

        data = {
            "camera_name": update_camera_name,
            "timestamp": timestamp_obj.isoformat(),
            "image_type": "workday"
        }

        with open(image_path, "rb") as fh:
            response = session.post(
                api,
                files={"image": fh},
                data=data,
                timeout=(3, 3)
            )

        logger.info(f"Monitor API published (status={response.status_code})")
    except Exception as exc:
        logger.error(f"Publish image API error: {exc}")

def run_surveillance(input_source, cam_name, old_camera_name, update_camera_name, logger, fps=5):
    logger.info(f"Starting surveillance for camera: {cam_name}")

    is_single_frame = isinstance(input_source, np.ndarray)
    unknown_counter = 0
    base_dir = os.path.join(SAVE_ROOT, cam_name)

    def get_collection():
        try:
            collection_facemeta = load_database(cam_name)
            if collection_facemeta is None:
                conn = pymongo.MongoClient(config.DATABASE_CONNECTION, directConnection=True)
                DATABASE = conn["Aksha"]
                collection_facemeta = DATABASE[f"facemeta_{cam_name}"]
            logger.info("Database connection ready")
            return collection_facemeta
        except Exception as e:
            logger.error(f"DB init error: {e}")
            return None

    while True:
        cap = None

        if not is_single_frame:
            cap = cv2.VideoCapture(input_source)
            if not cap.isOpened():
                logger.warning("RTSP not reachable, retrying in 5s...")
                time.sleep(5)
                continue

            stream_fps = cap.get(cv2.CAP_PROP_FPS) or 25
            skip_rate = max(1, int(stream_fps / fps))
            logger.info(f"Stream opened | Target FPS={fps}, Skip={skip_rate}")

        with requests.Session() as session:
            try:
                keep_running = True
                while keep_running:
                    if is_single_frame:
                        frame = input_source
                        keep_running = False
                    else:
                        if not cap.grab():
                            break

                        frame_id = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
                        if frame_id % skip_rate != 0:
                            continue

                        ret, frame = cap.retrieve()
                        if not ret:
                            break

                    now = dt.datetime.now()

                    live_dir, alert_dir, unauth_dir = ensure_directory(base_dir, now, logger)
                    live_image_path = os.path.join(live_dir, "workday.jpg")

                    detections = process_single_frame_for_api(frame)
                    display_frame = frame.copy()

                    has_unknown = False
                    alert_triggered = False

                    for face in detections:
                        label = face.get("label", "Unknown")
                        score = face.get("Score", 0)
                        box = face.get("box")

                        is_known = label.upper() not in ["UNKNOWN", "ERROR"]
                        color = (0, 255, 0) if is_known else (0, 0, 255)

                        if not is_known:
                            has_unknown = True
                        else:
                            alert_triggered = True

                        if box and len(box) == 4:
                            x1, y1, x2, y2 = map(int, box)
                            cv2.rectangle(display_frame, (x1, y1), (x2, y2), color, 2)
                            cv2.putText(
                                display_frame,
                                f"{label} ({score}%)",
                                (x1, y1 - 10),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.5,
                                color,
                                2
                            )

                    if has_unknown:
                        unknown_counter += 1
                    else:
                        unknown_counter = 0

                    cv2.imwrite(live_image_path, display_frame)

                    if unknown_counter >= UNKNOWN_FRAME_THRESHOLD:
                        unauth_path = os.path.join(
                            unauth_dir,
                            f"unauth_{now.strftime('%H%M%S')}.jpg"
                        )
                        cv2.imwrite(unauth_path, display_frame)
                        logger.warning(f"Unauthorised image saved: {unauth_path}")

                    if alert_triggered:
                        alert_path = os.path.join(
                            alert_dir,
                            f"{now.strftime('%Y-%m-%d_%H-%M-%S')}_alert.jpg"
                        )
                        cv2.imwrite(alert_path, display_frame)

                    publish_image(session, live_dir, cam_name, now, logger)
                    collection = get_collection()
                    log_to_db(
                        collection,
                        now.strftime("%Y-%m-%d %H:%M:%S"),
                        detections,
                        alert_triggered,
                        cam_name,
                        logger
                    )

                if is_single_frame:
                    break

            except Exception as e:
                logger.error(f"Surveillance error: {e}")
                if is_single_frame:
                    break
            finally:
                if cap:
                    cap.release()
                if not is_single_frame:
                    time.sleep(2)
