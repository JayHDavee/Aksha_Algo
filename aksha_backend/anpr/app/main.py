import os
import cv2
import numpy as np
import json
from kafka import KafkaConsumer, KafkaProducer
from datetime import datetime as dt
from pymongo import MongoClient
import requests
import logging
from logging.handlers import RotatingFileHandler
from anpr import NumberPlateRecognizerONNX

# --- LOGGING SETUP ---
def setup_logger(cam_name):
    log_dir = os.path.join(os.getenv("AKSHA_PATH", "/Aksha"), "log")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, f"{cam_name}_anpr.log")
    logger = logging.getLogger(cam_name+"_anpr")
    if not logger.handlers:
        handler = RotatingFileHandler(log_file, maxBytes=5*1024*1024, backupCount=3)
        formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger

# --- DB setup ---
def get_db():
    mongo_uri = os.getenv("MONGODB_URI", "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false")
    client = MongoClient(mongo_uri)
    db = client.get_database()
    return db

def publish_image(session, cam_name, frame, timestamp_obj):
    try:
        api = "http://node_backend:5000/api/monitor/"
        image_path = f"/tmp/{cam_name}_workday.jpg"
        cv2.imwrite(image_path, frame)
        with open(image_path, "rb") as f:
            files = {"image": f}
            data = {"camera_name": cam_name, "timestamp": timestamp_obj.isoformat(), "image_type":"workday"}
            response = session.post(api, files=files, data=data, timeout=(3,3))
            return response.status_code == 200
    except Exception as e:
        print(f"Error publishing image: {e}")
        return False


# --- MAIN ---
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

print("Initializing ANPR Service...")
print(f"Kafka server: {KAFKA_SERVER}")
print(f"Input topic: {INPUT_TOPIC}")

consumer = KafkaConsumer(
    INPUT_TOPIC,
    bootstrap_servers=KAFKA_SERVER,
    group_id="anpr_group",
    auto_offset_reset='latest'
)

print("Kafka consumer created")

db = get_db()
print("MongoDB connection established")

# Model path - fixed to container path
MODEL_PATH = "/code/anpr.onnx"
print(f"Loading ANPR model from: {MODEL_PATH}")
print(f"Model exists: {os.path.exists(MODEL_PATH)}")

try:
    recognizer = NumberPlateRecognizerONNX(MODEL_PATH)
    print("ANPR recognizer initialized successfully")
except Exception as e:
    print(f"Failed to initialize ANPR recognizer: {e}")
    print("Shutting down...")
    exit(1)

print("Starting to consume messages...")
print("-" * 60)

for msg in consumer:
    try:
        headers = {k: v.decode('utf-8') if v else None for k,v in msg.headers}
        cam_name = headers.get("camera_name","default_cam")
        timestamp_str = headers.get("timestamp_str")
        
        print(f"\n[{dt.now().strftime('%H:%M:%S')}] Processing frame from: {cam_name}")
        
        logger = setup_logger(cam_name)
        frame_bytes = msg.value
        frame = cv2.imdecode(np.frombuffer(frame_bytes,dtype=np.uint8), cv2.IMREAD_COLOR)
        
        if frame is None:
            print("  Error: Could not decode frame")
            logger.error("Could not decode frame")
            continue
            
        timestamp_obj = dt.fromisoformat(timestamp_str)
        
        logger.info(f"Received frame {frame.shape} from camera: {cam_name}")
        print(f"  Frame shape: {frame.shape}")

        detections = recognizer.detect(frame)

        if detections:
            print(f"  Found {len(detections)} license plate(s)")
            logger.info(f"Found {len(detections)} license plate(s)")
            
            for det in detections:
                bbox = det["bbox"]
                score = det["score"]
                ocr_raw = det["ocr_raw"]
                ocr_post = det["ocr_post"]
                
                print(f"  Plate: bbox={bbox}, score={score:.3f}, raw='{ocr_raw}', post='{ocr_post}'")
                logger.info(f"ANPR Detection: bbox={bbox} score={score:.3f} raw='{ocr_raw}' post='{ocr_post}'")
            
            # DB insert
            try:
                collection = db[cam_name+"_anpr"]
                result = collection.insert_one({
                    "Timestamp": timestamp_str,
                    "CameraName": cam_name,
                    "Detections": detections
                })
                print(f"  Saved to MongoDB with ID: {result.inserted_id}")
            except Exception as db_error:
                print(f"  MongoDB error: {db_error}")
                logger.error(f"MongoDB error: {db_error}")

            # Publish image to monitor API
            try:
                import requests
                with requests.Session() as session:
                    success = publish_image(session, cam_name, frame, timestamp_obj)
                    if success:
                        print("  Image published to monitor API")
                    else:
                        print("  Failed to publish image to monitor API")
            except Exception as api_error:
                print(f"  API error: {api_error}")
        else:
            print("  No license plates detected")
            
    except KeyboardInterrupt:
        print("\nShutting down...")
        break
    except Exception as e:
        error_msg = f"Error processing frame: {str(e)}"
        print(f"  {error_msg}")
        
        if 'logger' in locals():
            logger.exception(error_msg)
        else:
            print(f"Logger not available: {e}")

print("ANPR service stopped")
