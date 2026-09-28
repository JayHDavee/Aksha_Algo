# --- STEP 2: IMPORT SURVEILLANCE & TOOLS ---
import numpy as np
from kafka import KafkaConsumer
import cv2
import datetime as dt
import os
import logging
import argparse
from surveillance import run_surveillance

def face_logger(cam_name):
    main_dir = os.getenv("AKSHA_PATH")
    logger_path = f"{main_dir}/{cam_name}/log"
    os.makedirs(logger_path, exist_ok=True)

    logging.basicConfig(
        filename=f"{logger_path}/face_rec.log",
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        filemode="a",
    )
    logger = logging.getLogger("face_rec")
    return logger

def load_kafka_config():
    print(f"KAFKA_BOOTSTRAP_SERVERS env: {os.environ.get('KAFKA_BOOTSTRAP_SERVERS')}", flush=True)
    print(f"Running in Docker: {os.path.exists('/.dockerenv')}", flush=True)
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        print("KAFKA_BOOTSTRAP_SERVERS not set in environment, using fallback...", flush=True)
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"
        else:
            KAFKA_SERVER = "localhost:9092"
    else:
        print(f"Using KAFKA_SERVER from environment: {KAFKA_SERVER}", flush=True)

    return KAFKA_SERVER


KAFKA_SERVER = load_kafka_config()

INPUT_TOPIC = "raw_frame"

consumer = KafkaConsumer(
    INPUT_TOPIC,
    bootstrap_servers=KAFKA_SERVER,
    group_id="face_rec_group"
)
print("Kafka consumer created")
partitions = consumer.assignment()

def parse_args():
    parser = argparse.ArgumentParser(description="Aksha Face Recognition Surveillance Pod")

    # parser.add_argument(
    #     "--input_source",
    #     required=True,
    #     help="RTSP URL or Video file path"
    # )

    # parser.add_argument(
    #     "--camera_name",
    #     required=True,
    #     help="Camera name"
    # )

    parser.add_argument(
        "--old_camera_name",
        default=None,
        help="Old camera name (if renamed)"
    )

    parser.add_argument(
        "--update_camera_name",
        default=None,
        help="Updated camera name"
    )

    parser.add_argument(
        "--fps",
        type=int,
        default=10,
        help="Processing FPS"
    )

    return parser.parse_args()

if __name__ == "__main__":
    # Parse the command line arguments
    args = parse_args()
    
    for msg in consumer:
        try:
            headers = {k: v.decode('utf-8') if v else None for k, v in msg.headers}
            camera_name = headers.get('camera_name')
            logger  = face_logger(camera_name)
            frame_bytes = msg.value
            frame = cv2.imdecode(np.frombuffer(frame_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            logger.info(f"Received frame with shape {frame.shape}")
            frame_id = headers.get('frame_id')
            timestamp_str = headers.get('timestamp_str')
            
            # anomaly_detection = bool(headers.get('anomaly_detection'))

            timestamp = dt.datetime.fromisoformat(timestamp_str)
            logger.info(f"Processing frame_id={frame_id} camera={camera_name}")


            # Launch the surveillance loop directly
            # This will run until the camera stream is closed or the process is killed
            run_surveillance(
                input_source=frame,
                cam_name=camera_name,
                old_camera_name=args.old_camera_name,
                update_camera_name=args.update_camera_name,
                logger=logger,
                fps=args.fps
            )
        except Exception as e:
            logger.exception(f"Error processing frame: {e}")
