"""
object_detection_service_gpu — GPU/TRT YOLOv10 Kafka inference worker.

Pipeline:

  ┌────────────────────────────────────────────────────────────────────────────┐
  │  Kafka consumer: raw_frame  (one frame at a time, latest-offset restart)   │
  │                                                                              │
  │    parse payload  → decode frame                                            │
  │      FRAME_PATH_ENABLE=true  → cv2.imread(frame_path)                     │
  │      FRAME_PATH_ENABLE=false → base64 decode from frame_bytes              │
  │                                                                              │
  │    parse headers  → frame_id, camera_name, timestamp_str                   │
  │                                                                              │
  │    od.object_detection()  — YOLOv10 ONNX on GPU                            │
  │      BGR→RGB → letterbox(640×640) → CHW → ORT run → threshold →            │
  │      un-project → xyxy→xywh                                                 │
  │    od.get_labels()         — second NMS pass → [{label,x,y,w,h,conf}, …]  │
  │                                                                              │
  │  Kafka producer: object_detection_results                                   │
  │    payload: {frame_id, frame_bytes, object_detection_results}               │
  │    headers: forwarded unchanged from input message                          │
  └────────────────────────────────────────────────────────────────────────────┘

  Execution provider priority (built at startup from env flags):
    ENABLE_GPU=true + ENABLE_TENSORRT=true  → TensorRT FP16 → CUDA → CPU
    ENABLE_GPU=true                         → CUDA → CPU
    default                                 → CPU only

  Warmup inference runs once after model load to pre-build/load the TRT engine
  before the first Kafka message arrives, avoiding a rebalance timeout.
"""

import numpy as np
import object_detection as od
from kafka import KafkaConsumer, KafkaProducer
import cv2
import datetime as dt
import os
import json
import base64
import logging
import logging.handlers
import gzip
import shutil
import socket
import onnxruntime as ort

# -------------------- STARTUP: ENV VARS --------------------

main_dir = os.environ.get("AKSHA_PATH")
logger_path = f"{main_dir}/log"
os.makedirs(logger_path, exist_ok=True)
_hostname = socket.gethostname()

# FRAME_PATH_ENABLE: when set, payload carries a file path instead of raw JPEG bytes
FRAME_PATH_ENABLE = os.environ.get('frame_path', False)

# -------------------- LOGGER --------------------

def _make_rotating_logger(name, log_file):
    """
    Build a named file logger with midnight rotation and gzip compression.

    Rotated logs are renamed to <filename>.gz so old logs don't accumulate
    as plain text. backupCount=30 keeps one month of compressed history.
    """
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler = logging.handlers.TimedRotatingFileHandler(
        filename=log_file, when='midnight', interval=1, backupCount=30, encoding='utf-8'
    )
    def _rotator(source, dest):
        with open(source, 'rb') as f_in, gzip.open(dest, 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)
        os.remove(source)
    handler.rotator = _rotator
    handler.namer = lambda n: n + ".gz"
    handler.setFormatter(fmt)
    _logger = logging.getLogger(name)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    if not _logger.handlers:
        _logger.addHandler(handler)
    return _logger

logger = _make_rotating_logger(
    f"object_detection_{_hostname}",
    f"{logger_path}/object_detection_{_hostname}.log"
)
logger.info(f"Object detection GPU service starting | host={_hostname} | main_dir={main_dir} | frame_path_enable={FRAME_PATH_ENABLE}")

# -------------------- KAFKA CONFIG --------------------

def load_kafka_config():
    """Resolve the Kafka bootstrap server from env, falling back to docker/local defaults."""
    # Stage: resolve Kafka bootstrap server from env or apply container/local fallback
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
    logger.info(f"Kafka server resolved | KAFKA_SERVER={KAFKA_SERVER}")
    return KAFKA_SERVER

KAFKA_SERVER = load_kafka_config()

INPUT_TOPIC = "raw_frame"
OUTPUT_TOPIC = "object_detection_results"

# -------------------- KAFKA PRODUCER & CONSUMER --------------------

# Stage: producer publishes inference results to object_detection_results topic
producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)
logger.info(f"Kafka producer created | output_topic={OUTPUT_TOPIC}")

# Stage: consumer reads one frame at a time from raw_frame; latest offset skips stale backlog
consumer = KafkaConsumer(
    INPUT_TOPIC,
    bootstrap_servers=KAFKA_SERVER,
    group_id="object_detection_group",
    auto_offset_reset="latest",       # on restart skip old backlog, process fresh frames only
    max_poll_records=1,               # process one frame at a time, no batching
    max_poll_interval_ms=300000,      # 5 min max between polls (covers slow GPU warmup / TRT compile)
    session_timeout_ms=30000,
    heartbeat_interval_ms=10000,
)
logger.info(f"Kafka consumer created | input_topic={INPUT_TOPIC} | group=object_detection_group")

partitions = consumer.assignment()
logger.info(f"Partitions assigned: {partitions}")

# -------------------- GPU / EXECUTION PROVIDER SELECTION --------------------

# Stage: choose ONNX execution provider — TensorRT > CUDA > CPU — based on env flags and availability
enable_gpu = os.environ.get("ENABLE_GPU", "false").lower() == "true"
enable_tensorrt = os.environ.get("ENABLE_TENSORRT", "false").lower() == "true"
trt_cache_path = os.environ.get("TRT_CACHE_PATH", "/Aksha/trt_cache")

available_providers = ort.get_available_providers()
logger.info(
    f"ONNX provider selection | enable_gpu={enable_gpu} | enable_tensorrt={enable_tensorrt} "
    f"| available={available_providers}"
)

if enable_gpu and enable_tensorrt and "TensorrtExecutionProvider" in available_providers:
    os.makedirs(trt_cache_path, exist_ok=True)
    providers = [
        (
            "TensorrtExecutionProvider",
            {
                "trt_fp16_enable": True,
                "trt_engine_cache_enable": True,
                "trt_engine_cache_path": trt_cache_path,
                "trt_max_workspace_size": 1 << 30,        # 1 GB — still valid, used by older TRT
                "trt_builder_optimization_level": 3,       # TRT 8.6+ replacement for workspace hint
            },
        ),
        (
            "CUDAExecutionProvider",
            {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"},
        ),
        "CPUExecutionProvider",
    ]
    logger.info(f"Execution provider: TensorRT (fp16=True, cache={trt_cache_path}) → CUDA fallback → CPU fallback")
elif enable_gpu and "CUDAExecutionProvider" in available_providers:
    providers = [
        (
            "CUDAExecutionProvider",
            {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"},
        ),
        "CPUExecutionProvider",
    ]
    logger.info("Execution provider: CUDA → CPU fallback")
else:
    providers = ["CPUExecutionProvider"]
    logger.info("Execution provider: CPU only (GPU not requested or CUDA not available)")

# -------------------- MODEL LOAD & WARMUP --------------------

# Stage: load YOLOv10 ONNX model with selected providers; all frames share this session
try:
    logger.info(f"Loading object detection model | model=yolov10.onnx | labels=coco.names | providers={[p if isinstance(p, str) else p[0] for p in providers]}")
    object_detection_service, class_names, colors = od.load_object_detection_model(
        "yolov10.onnx", "coco.names", providers=providers
    )
    logger.info(f"Object detection model loaded successfully | classes={len(class_names)}")

    # Stage: warmup inference — triggers TensorRT engine build/load before first real frame.
    # Without this the first Kafka message blocks for minutes (TRT compile) and risks
    # exceeding max_poll_interval_ms, causing a consumer group rebalance.
    logger.info("Running warmup inference to pre-build/load TensorRT engine (may take several minutes on first run)")
    _dummy = np.zeros((640, 640, 3), dtype=np.uint8)
    od.object_detection(_dummy, object_detection_service, class_names, colors)
    logger.info("Warmup inference complete — engine ready, entering consumer loop")

except Exception as e:
    logger.exception(f"Error while loading the object detection model: {e}")

# -------------------- CONSUMER LOOP --------------------

logger.info("Entering Kafka consumer loop — waiting for frames on raw_frame topic")

for msg in consumer:
    try:
        # Stage: frame received from Kafka — log partition/offset for traceability
        logger.info(
            f"[FRAME RECEIVED] topic={msg.topic} | partition={msg.partition} | offset={msg.offset}"
        )

        # Stage: parse JSON payload from Kafka message value
        payload = json.loads(msg.value.decode('utf-8'))
        frame_bytes = payload.get('frame_bytes')

        # Stage: load frame — either from disk path or from base64-encoded bytes in payload
        if FRAME_PATH_ENABLE:
            frame_path = payload.get("frame_path")
            if not frame_path or not os.path.exists(frame_path):
                logger.error(f"Frame path invalid or not found | frame_path={frame_path}")
                continue

            frame = cv2.imread(frame_path)
            if frame is None:
                logger.error(f"cv2.imread returned None | frame_path={frame_path}")
                continue
            logger.info(f"Frame loaded from disk | frame_path={frame_path} | shape={frame.shape}")
        else:
            if not frame_bytes:
                logger.error(f"frame_bytes missing from payload | frame_id={payload.get('frame_id')}")
                continue

            frame = cv2.imdecode(
                np.frombuffer(base64.b64decode(frame_bytes), dtype=np.uint8),
                cv2.IMREAD_COLOR
            )
            logger.info(f"Frame decoded from base64 bytes | shape={frame.shape}")

        if frame is None:
            logger.error(f"Frame decode returned None | frame_id={payload.get('frame_id')}")
            continue

        # Stage: parse Kafka message headers (frame_id, timestamp, camera_name)
        headers = {k: v.decode('utf-8') if v else None for k, v in msg.headers}
        frame_id = headers.get('frame_id')
        timestamp_str = headers.get('timestamp_str')
        camera_name = headers.get('camera_name')
        anomaly_detection = bool(headers.get('anomaly_detection'))

        timestamp = dt.datetime.fromisoformat(timestamp_str)
        logger.info(
            f"Headers parsed | frame_id={frame_id} | camera={camera_name} "
            f"| timestamp={timestamp} | anomaly_detection={anomaly_detection}"
        )

        # Stage: run YOLOv10 GPU inference on the decoded frame
        logger.info(f"Running GPU object detection | frame_id={frame_id} | camera={camera_name}")
        t0 = dt.datetime.now()
        boxes, confs, class_ids, classes = od.object_detection(
            frame, object_detection_service, class_names, colors
        )
        object_detection_results = od.get_labels(boxes, confs, class_ids, classes)
        elapsed_ms = (dt.datetime.now() - t0).total_seconds() * 1000
        logger.info(
            f"Inference complete | frame_id={frame_id} | objects_detected={len(object_detection_results)} "
            f"| elapsed_ms={elapsed_ms:.1f}"
        )

        # Stage: build combined payload and publish to object_detection_results topic
        combined_message = {
            'frame_id': frame_id,
            'frame_bytes': frame_bytes,
            'object_detection_results': object_detection_results,
        }
        producer.send(
            topic=OUTPUT_TOPIC,
            value=combined_message,
            key=frame_id.encode('utf-8'),
            headers=msg.headers
        )
        logger.info(
            f"[FRAME SENT] frame_id={frame_id} | camera={camera_name} "
            f"| topic={OUTPUT_TOPIC} | objects={len(object_detection_results)}"
        )

    except Exception as e:
        logger.exception(f"Error processing frame: {e}")
