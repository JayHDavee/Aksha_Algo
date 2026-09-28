"""
Post-Processor Service  —  Aksha Video Analytics Pipeline
==========================================================

Architecture Overview
---------------------
This service is the final stage of the Aksha real-time video analytics pipeline.
It consumes detection/alert payloads produced by the DeepStream pods from the Kafka
topic ``post_processing``, annotates the raw JPEG frame, persists per-frame metadata
to MongoDB, and forwards alert payloads to downstream Kafka topics.

Pipeline data flow
~~~~~~~~~~~~~~~~~~

    DeepStream pods (one pod per camera group)
        │  JSON message: JPEG bytes (base64) + detection/alert metadata
        ▼
    Kafka  ──  topic: post_processing
        │
        ▼
    post_processor                  ←── MongoDB  (camera config, Alerts collection)
        │                           ←── Redis    (per-camera alert state — survives restarts)
        │
        ├──► Kafka  topic: live_update          (annotated JPEG → frontend live view)
        └──► Kafka  topic: notification_service (alert payload → email / push)

Concurrency model
~~~~~~~~~~~~~~~~~
- A single ``asyncio`` event loop drives the Kafka consumer.
- CPU-bound work (frame decode, OpenCV annotation, synchronous MongoDB/Redis I/O) is
  offloaded to the default ``ThreadPoolExecutor`` via ``loop.run_in_executor`` so the
  event loop is never blocked.
- All frames in a batch are detected and post-processed concurrently using
  ``asyncio.gather``.
- One daemon thread drains the HTTP publish queue for live-image POSTs so network
  I/O never stalls the processing pipeline.

Key tuning parameters (see ``process_messages``)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
- ``BATCH_SIZE = max_poll_records = 10``   batch fetch size to drain Kafka backlog faster
- ``COMMIT_INTERVAL = 10``                 commit offsets every N messages
- Non-alert stale threshold: 15 s         frames older than this are dropped without processing
- Alert stale threshold: 60 s             alerts older than this are also dropped (was 120 s)
- ``MONGO_BATCH_SIZE = 10``               meta records are buffered and flushed in bulk
- Raw frame save: throttled to 1/30 s per camera (always saved on alert)

Module dependencies
~~~~~~~~~~~~~~~~~~~
- ``annotate``          (an)   — OpenCV drawing helpers (draw_filter, draw_labels)
- ``notif_filter``             — NotificationService: cooldown / dedup / email dispatch
- ``aiokafka``                 — async Kafka consumer and producers
- ``pymongo``                  — synchronous MongoDB client (run in executor)
- ``redis``                    — synchronous Redis client (run in executor)
- ``cv2`` / ``numpy``          — frame decode, resize, annotation
"""

import json
import asyncio
import time
from typing import List, Dict, Any, Optional
from aiokafka.errors import CommitFailedError
import datetime as dt
from dataclasses import dataclass, asdict, field
import logging
import os
import annotate as an
import sys
import base64
import pymongo
import redis as redis_lib
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
import cv2
import numpy as np
from notif_filter import NotificationService
import requests
import socket
import threading
import queue as _queue

# -------------------- STARTUP: ENV VARS --------------------

def load_kafka_config():
    """
    Resolve the Kafka bootstrap server address from the environment.

    Resolution order
    ----------------
    1. ``KAFKA_BOOTSTRAP_SERVERS`` environment variable (set by docker-compose or k8s).
    2. If running inside a Docker container (``/.dockerenv`` exists) → ``broker:9092``
       (the Compose service name used by the internal Docker network).
    3. Otherwise → ``localhost:9092`` for local development.

    Returns
    -------
    str
        Kafka bootstrap server string, e.g. ``"broker:9092"``.
    """
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
    return KAFKA_SERVER


KAFKA_SERVER = load_kafka_config()
MONGODB_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017')
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT_NUMBER', 6379))

# BGR colors for the PPE alert annotation box, keyed by severity (see ppe_alerts.py SEVERITY_MAP)
PPE_SEVERITY_COLORS = {
    "critical": (0, 0, 255),
    "high": (0, 128, 255),
    "medium": (0, 255, 255),
    "low": (255, 255, 0),
    "none": (0, 255, 0),
}

# k8s Service names can't contain underscores (DNS-1035 label) — the Compose service
# "node_backend" is exposed as "node-backend" when this stack runs on Kubernetes.
DEPLOYMENT_PLATFORM = os.environ.get("DEPLOYMENT_PLATFORM", "docker").strip().lower()
NODE_BACKEND_HOST = "node-backend" if DEPLOYMENT_PLATFORM == "kubernetes" else "node_backend"


# -------------------- DATA MODELS --------------------

@dataclass
class ProcessingResult:
    """
    Output of ``process_detection`` for a single frame.

    Carries the annotated OpenCV image alongside flags that downstream
    ``_handle_result`` needs to decide notification and Kafka publishing.

    Fields
    ------
    check : str
        Alert type that produced the final annotated frame.
        One of: ``"no_alert"`` | ``"my_alert"`` | ``"no_object"`` |
        ``"frame_auto_alert"`` | ``"object_auto_alert"``.
    camera_name : str
        Originating camera identifier.
    result_img : np.ndarray
        BGR OpenCV image annotated with bounding boxes / zone overlays.
    frame_anomaly_validity : bool
        Whether a frame-level anomaly was confirmed as valid for notification.
    object_anomaly_validity : bool
        Whether an object-level anomaly was confirmed as valid for notification.
    prev_spotlight : bool
        ``True`` when the spotlight image should be retained (alert fired),
        ``False`` when it should be cleared (normal frame).
    """
    check: str
    camera_name: str
    result_img: np.ndarray
    frame_anomaly_validity: bool
    object_anomaly_validity: bool
    prev_spotlight: bool

    def to_dict(self):
        """Serialise to a plain dict (uses ``dataclasses.asdict``). The ``result_img`` numpy
        array is included; callers must pop it before sending over the wire."""
        return asdict(self)

@dataclass
class PPEProcessingResult:
    """
    Output of ``process_ppe_detection`` for a single PPE compliance/violation message.

    Unlike ``ProcessingResult``, there is no annotated frame to forward to
    ``live_update`` — the PPE container already publishes its own live view
    directly (see ``ppe_reader.py``). This only carries what ``_handle_ppe_result``
    needs to persist metadata and decide whether to notify.

    Fields
    ------
    camera_name : str
    has_violation : bool
        True when this message represents an actual violation (non-empty
        ``violated`` and severity != "none") rather than a compliant frame.
    alert_dir : str, optional
        Directory the annotated alert image was written to, or ``None`` if
        this frame was compliant (no image is written for compliant frames).
    frame_file : str, optional
        Filename of the saved annotated frame within ``alert_dir``.
    crop_file : str, optional
        Filename of the saved person crop within ``alert_dir/crops``.
    """
    camera_name: str
    has_violation: bool
    alert_dir: Optional[str] = None
    frame_file: Optional[str] = None
    crop_file: Optional[str] = None

@dataclass
class JewelryProcessingResult:
    """
    Output of ``process_jewelry_detection`` for a single jewelry rule event.

    Unlike PPE's continuous compliance stream, every jewelry message already
    represents a genuine fired rule (each rule cooldown-gates itself before
    ever publishing — see jewelry_rules.AlertBus) — so there is no
    ``has_violation`` flag here; an annotated snapshot is always written.

    Fields
    ------
    camera_name : str
    alert_dir : str, optional
        Directory the annotated alert image was written to.
    frame_file : str, optional
        Filename of the saved annotated frame within ``alert_dir``.
    """
    camera_name: str
    alert_dir: Optional[str] = None
    frame_file: Optional[str] = None

@dataclass
class StreamResult:
    """
    Parsed representation of one Kafka message from the ``post_processing`` topic.

    Each message originates from a DeepStream pod and contains:
    - A base64-encoded JPEG frame.
    - Detection bounding-box results from the YOLO/object-detection model.
    - Alert evaluation results computed inside DeepStream.
    - Flags indicating whether a frame-level or object-level anomaly was detected.

    Fields
    ------
    frame_id : str
        Unique frame identifier of the form ``"<camera>@<HH:MM:SS.ffffff>"``.
    frame_bytes : str
        Base64-encoded JPEG bytes of the raw camera frame.
    overlay_str : str
        Optional SVG/JSON overlay descriptor (unused in current path).
    camera_name : str
        Camera identifier that produced this frame.
    alert_results : list
        List of triggered alert names for this frame.
    no_object_status : bool
        ``True`` if a "no-object" alert condition was detected (expected object absent).
    framebase_prediction : bool
        ``True`` if the frame-level anomaly model flagged this frame.
    objectbase_prediction : bool
        ``True`` if the object-level anomaly model flagged this frame.
    detection_results : list
        Raw detection output: list of ``{class, confidence, bbox}`` dicts.
    alert_description : list
        Human-readable descriptions paired with ``alert_results``.
    alert_notification_validity : list
        Per-alert boolean: whether the notification cooldown allows sending.
    noobj_alert_result_config : list
        Alert configuration items for the no-object alert path.
    alert_result_config : list
        Alert configuration items for the my-alert annotation path.
    alert_type : str, optional
        ``"ppe"`` for messages forwarded by ``ppe_alert_consumer.py`` from the
        PPE compliance stream; ``None`` for the standard OD/alert schema above.
        Every field below this point is only populated for PPE messages.
    person_bbox : list, optional
        ``[x, y, w, h]`` bounding box of the person this PPE record covers.
    worn : list
        PPE items detected as worn (e.g. ``["Helmet", "Shoes"]``).
    violated : list
        PPE items detected as violated/missing (e.g. ``["No-Helmet"]``).
    missing : list
        Base PPE item names paired with ``violated`` (e.g. ``["Helmet"]``).
    severity : str, optional
        One of ``"critical" | "high" | "medium" | "low" | "none"``.
    ppe_detections : list
        Raw PPE item detections assigned to this person.
    frame : str, optional
        Base64-encoded JPEG of the full camera frame (PPE schema — distinct
        from ``frame_bytes`` used by the OD schema; also reused, unmodified,
        by the jewelry schema below).
    person_crop : str, optional
        Base64-encoded JPEG cropped to this person's bounding box.
    rule : str, optional
        ``alert_type == "jewelry"`` only. The specific rule that fired (e.g.
        ``"LOITERING"``), forwarded by ``jewelry_alert_consumer.py``. Kept
        separate from ``alert_type`` itself, which is reserved as the pipeline
        dispatch tag (``"jewelry"``), matching PPE's ``"ppe"`` convention.
    zone : str, optional
        Zone/line name the rule fired against, if any (e.g. ``"vault_area"``).
    track_id : int, optional
        Track ID of the person the rule fired for, if any.
    bbox : list, optional
        ``[x1, y1, x2, y2]`` bounding box associated with the event, if any.
    metadata : dict, optional
        Rule-specific extra detail (e.g. dwell seconds, queue length).
    """
    frame_id: Optional[str] = None
    frame_bytes: Optional[str] = None
    overlay_str: Optional[str] = None
    camera_name: Optional[str] = None
    alert_results: List[Any] = field(default_factory=list)
    no_object_status: bool = False
    framebase_prediction: bool = False
    objectbase_prediction: bool = False
    detection_results: List[Any] = field(default_factory=list)
    alert_description: List[Any] = field(default_factory=list)
    alert_notification_validity: List[Any] = field(default_factory=list)
    noobj_alert_result_config: List[Any] = field(default_factory=list)
    alert_result_config: List[Any] = field(default_factory=list)
    alert_type: Optional[str] = None
    person_bbox: Optional[List[Any]] = None
    worn: List[Any] = field(default_factory=list)
    violated: List[Any] = field(default_factory=list)
    missing: List[Any] = field(default_factory=list)
    severity: Optional[str] = None
    ppe_detections: List[Any] = field(default_factory=list)
    frame: Optional[str] = None
    person_crop: Optional[str] = None
    rule: Optional[str] = None
    zone: Optional[str] = None
    track_id: Optional[int] = None
    bbox: Optional[List[Any]] = None
    metadata: Optional[Dict[str, Any]] = None

    @classmethod
    def from_message(cls, message: Dict[str, Any]) -> 'StreamResult':
        """
        Construct a ``StreamResult`` from the deserialized Kafka message dict.

        Only keys present in the dataclass annotation are mapped; extra keys in
        the message payload are silently ignored, making this forward-compatible
        with producer schema changes.

        Parameters
        ----------
        message : dict
            JSON-decoded Kafka message value from the ``post_processing`` topic.

        Returns
        -------
        StreamResult
        """
        return cls(**{k: message.get(k) for k in cls.__annotations__ if k in message})

@dataclass
class NotificationParams:
    """
    Input bundle passed to ``NotificationService.send_notification``.

    Aggregates all per-frame context that the notification service needs to
    decide whether a notification should be emitted and what it should contain.

    Fields
    ------
    frame_id : str
        Originating frame identifier (for tracing).
    camera_name : str
        Camera that produced this frame.
    check : str
        Alert type resolved by ``process_detection``.
    timestamp : datetime
        Wall-clock timestamp aligned to the frame's embedded time string.
    frame_anomaly_status : bool
        Raw frame-anomaly flag from the detection model.
    object_anomaly_status : bool
        Raw object-anomaly flag from the detection model.
    no_object_status : bool
        True when a "no-object" condition was raised.
    alert_results : list
        Triggered alert names.
    alert_description : list
        Human-readable descriptions for each triggered alert.
    alert_notification_validity : list
        Cooldown-gate flags per alert (set by DeepStream / upstream).
    alert_result_config : list
        Full alert config rows for the triggered alerts.
    noobj_alert_result_config : list
        Full alert config rows for no-object alerts.
    detection_results : list
        Raw YOLO detection rows for this frame.
    fps : float or None
        Camera FPS from MongoDB config (used for cooldown calculations).
    autoalert_notification_email_service : bool
        Whether automatic e-mail alerts are enabled for this camera.
    camera_configuration : dict
        Full camera config document from MongoDB.
    previous_alert_statuses : dict
        Per-alert state dict loaded from Redis before processing.
    """
    frame_id: str
    camera_name: str
    check: str
    timestamp: dt.datetime
    frame_anomaly_status: bool
    object_anomaly_status: bool
    no_object_status: bool
    alert_results: List[Any] = field(default_factory=list)
    alert_description: List[Any] = field(default_factory=list)
    alert_notification_validity: List[Any] = field(default_factory=list)
    alert_result_config: List[Any] = field(default_factory=list)
    noobj_alert_result_config: List[Any] = field(default_factory=list)
    detection_results: List[Any] = field(default_factory=list)
    fps: float = None
    autoalert_notification_email_service: bool = False
    camera_configuration: Dict[str, Any] = field(default_factory=dict)
    previous_alert_statuses: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_stream_and_processing_results(
        cls,
        stream_result: 'StreamResult',
        processing_result: Dict[str, Any],
        previous_alert_statuses: Dict[str, Any],
        camera_config: Dict[str, Any],
        timestamp: dt.datetime
    ) -> 'NotificationParams':
        """
        Factory that merges ``StreamResult`` + ``ProcessingResult`` + camera config into
        a single ``NotificationParams`` ready for ``NotificationService``.

        Parameters
        ----------
        stream_result : StreamResult
            Parsed Kafka message for this frame.
        processing_result : dict
            ``ProcessingResult.to_dict()`` after popping ``result_img``.
        previous_alert_statuses : dict
            Latest per-alert state from Redis (cooldown counters, last fire times).
        camera_config : dict
            MongoDB camera configuration document.
        timestamp : datetime
            Frame-aligned timestamp string (``"%Y-%m-%d %H:%M:%S.%f"``).

        Returns
        -------
        NotificationParams
        """
        return cls(
            frame_id=stream_result.frame_id,
            camera_name=stream_result.camera_name,
            check=processing_result['check'],
            timestamp=timestamp,
            frame_anomaly_status=processing_result['frame_anomaly_validity'],
            object_anomaly_status=processing_result['object_anomaly_validity'],
            no_object_status=stream_result.no_object_status,
            alert_results=stream_result.alert_results,
            alert_description=stream_result.alert_description,
            alert_notification_validity=stream_result.alert_notification_validity,
            alert_result_config=stream_result.alert_result_config,
            noobj_alert_result_config=stream_result.noobj_alert_result_config,
            detection_results=stream_result.detection_results,
            fps=camera_config.get('FPS'),
            autoalert_notification_email_service=camera_config.get('Email_Auto_Alert', False),
            camera_configuration=camera_config,
            previous_alert_statuses=previous_alert_statuses
        )

@dataclass
class NotificationResult:
    """
    Return value from ``NotificationService.send_notification``.

    Encapsulates all state that must be written back after a notification decision:
    updated alert validity flags (used to annotate the Kafka header on the next
    pipeline stage), the updated per-alert status dict that is persisted to Redis,
    and the optional notification payload to forward to ``notification_service``.

    Fields
    ------
    frame_anomaly_validity : bool
        Notification-gated version of the frame-anomaly flag.
    object_anomaly_validity : bool
        Notification-gated version of the object-anomaly flag.
    alert_validity : list[bool]
        Per-alert notification gate results (respects cooldown / schedule).
    no_object_validity : list[bool]
        Per-no-object-alert notification gate results.
    previous_alert_statuses : dict
        Updated alert status dict — must be written back to Redis.
    notification_params : dict or None
        Payload to publish to the ``notification_service`` Kafka topic, or ``None``
        if no notification should be emitted this frame.
    """
    frame_anomaly_validity: bool
    object_anomaly_validity: bool
    alert_validity: List[bool]
    no_object_validity: List[bool]
    previous_alert_statuses: Dict[str, Any]
    notification_params: Optional[Dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_notification_response(
        cls,
        frame_anomaly_validity: bool,
        object_anomaly_validity: bool,
        alert_validity: List[bool],
        no_object_validity: List[bool],
        previous_alert_statuses: Dict[str, Any],
        notification_params: Optional[Dict[str, Any]] = {}
    ) -> 'NotificationResult':
        """
        Convenience factory to build a ``NotificationResult`` from the tuple
        returned by ``NotificationService.send_notification``.

        Parameters
        ----------
        frame_anomaly_validity : bool
        object_anomaly_validity : bool
        alert_validity : list[bool]
        no_object_validity : list[bool]
        previous_alert_statuses : dict
            Updated cooldown state to persist to Redis.
        notification_params : dict or None
            Ready-to-publish notification payload, or ``None``.

        Returns
        -------
        NotificationResult
        """
        return cls(
            frame_anomaly_validity=frame_anomaly_validity,
            object_anomaly_validity=object_anomaly_validity,
            alert_validity=alert_validity,
            no_object_validity=no_object_validity,
            previous_alert_statuses=previous_alert_statuses,
            notification_params=notification_params
        )

# -------------------- KAFKA SERVICE --------------------

class KafkaService:
    """
    Central orchestrator for the post-processor pipeline stage.

    Responsibilities
    ----------------
    1. **Kafka I/O** — consume ``post_processing``, produce to ``live_update`` and
       ``notification_service`` using ``aiokafka`` async clients.
    2. **Frame annotation** — decode base64 JPEG bytes, run OpenCV annotation via the
       ``annotate`` module, and write result images to the camera's local file tree.
    3. **Metadata persistence** — buffer detection/alert metadata and flush in batches
       to MongoDB per-camera collections (``meta_<camera_name>``).
    4. **Notification dispatch** — invoke ``NotificationService`` to apply cooldown /
       schedule gates and produce notification payloads.
    5. **State management** — persist per-alert cooldown state in Redis so it survives
       pod restarts and is shared across replicas.
    6. **Live image publish** — POST the latest annotated frame to the Node.js backend
       via a non-blocking background thread.

    Thread safety
    -------------
    The public ``process_detection`` method is CPU-bound and safe to call from the
    thread pool (``run_in_executor``).  ``_meta_buffer`` is protected by
    ``_meta_buffer_lock``.  All other mutable state is accessed only from the
    event loop.
    """

    def __init__(
        self,
        kafka_bootstrap_servers: str,
        mongo_uri: str,
        consumer_topic: str,
        producer_topic: str,
        notification_producer_topic: str,
        consumer_group: str = "post-processor-group",
    ):
        """
        Initialise all service dependencies: logger, Kafka topology config, MongoDB,
        Redis, NotificationService, and the background HTTP publish worker.

        Parameters
        ----------
        kafka_bootstrap_servers : str
            Kafka bootstrap address, e.g. ``"broker:9092"``.
        mongo_uri : str
            MongoDB connection URI, e.g. ``"mongodb://mongo:27017"``.
        consumer_topic : str
            Kafka topic to consume detection payloads from (``"post_processing"``).
        producer_topic : str
            Kafka topic to publish annotated frame bytes to (``"live_update"``).
        notification_producer_topic : str
            Kafka topic to publish alert notification payloads to
            (``"notification_service"``).
        consumer_group : str
            Kafka consumer group ID — shared by all post-processor replicas so
            partitions are distributed across them.
        """
        # ---- Stage: logger setup ----
        def define_logger(logger_path):
            """
            Create a rotating file logger that compresses rolled-over logs with gzip.

            Log files are rotated at midnight, kept for 30 days, and named with the
            pod hostname so logs from multiple replicas do not collide on a shared
            volume.

            Parameters
            ----------
            logger_path : str
                Directory under which log files are written.

            Returns
            -------
            logging.Logger
            """
            import logging.handlers, gzip, shutil, socket
            os.makedirs(logger_path, exist_ok=True)
            _hostname = socket.gethostname()
            log_file = f"{logger_path}/post_processor_{_hostname}.log"
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
            _logger = logging.getLogger(f"post_processor_{_hostname}")
            _logger.setLevel(logging.INFO)
            _logger.propagate = False
            if not _logger.handlers:
                _logger.addHandler(handler)
            return _logger

        self.main_dir = os.environ.get("AKSHA_PATH")
        logger_path = self.main_dir + "/" + "log"
        self.logger = define_logger(logger_path)
        self.logger.info(
            f"KafkaService init | consumer_topic={consumer_topic} | producer_topic={producer_topic} "
            f"| notification_topic={notification_producer_topic} | group={consumer_group} "
            f"| kafka={kafka_bootstrap_servers}"
        )

        # Stage: Kafka topology
        self.bootstrap_servers = kafka_bootstrap_servers
        self.consumer_topic = consumer_topic
        self.notification_topic = notification_producer_topic
        self.producer_topic = producer_topic
        self.consumer_group = consumer_group

        with open("coco.names", "r") as f:
            self.classes = [line.strip() for line in f.readlines()]
        self.logger.info(f"COCO classes loaded | count={len(self.classes)}")

        # In-memory camera config cache: avoids repeated MongoDB round trips.
        # Populated on first access per camera; invalidation is not implemented —
        # a restart is required if camera config changes in MongoDB.
        self.camera_config_dict = {}
        self.known_collections: set = set()
        self._commit_count: int = 0
        self._meta_buffer: list = []
        self._ppe_meta_buffer: list = []
        self._jewelry_meta_buffer: list = []
        self._meta_buffer_lock = threading.Lock()
        # Throttle frame saves for insight — 1 frame per camera per 30s regardless of alerts
        self._last_frame_save: dict = {}
        self._frame_save_interval: float = 30.0

        # Stage: connect to MongoDB
        self.mongo_client = pymongo.MongoClient(mongo_uri)
        self.db = self.mongo_client['Aksha']
        self.collection = self.db['Alerts']
        self.config = self.db["config"]
        self.logger.info(f"MongoDB client created | db=Aksha | uri={mongo_uri}")

        # Stage: connect to Redis for alert status persistence across pod restarts
        self.redis_client = redis_lib.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            decode_responses=True,
            socket_timeout=5,
            retry_on_timeout=True
        )
        self.logger.info(f"Redis client created | host={REDIS_HOST} | port={REDIS_PORT}")

        # Stage: create NotificationService, passing the same logger for consistent log output
        self.notification_service = NotificationService(self.logger)
        self.logger.info("NotificationService created with shared logger")

        self.consumer = None
        self.producer = None
        self.notification_producer = None

        # Single background thread for HTTP publish — process_detection never blocks on it
        self._publish_queue: _queue.Queue = _queue.Queue(maxsize=4)
        _t = threading.Thread(target=self._start_publish_worker, daemon=True)
        _t.start()

    def _flush_meta_buffer(self):
        """
        Flush buffered per-camera metadata records to MongoDB in a single bulk insert.

        Records accumulated in ``_meta_buffer`` are grouped by camera name and written
        using ``insert_many`` with ``ordered=False`` so a single bad document does not
        abort the whole batch.

        This method acquires ``_meta_buffer_lock`` only long enough to drain the list
        into a local copy, then releases the lock before performing any I/O so the
        event-loop thread is not blocked while MongoDB responds.

        Called from the thread pool (``run_in_executor``) every ``MONGO_BATCH_SIZE``
        messages, and once more during the Kafka commit step to ensure no records are
        orphaned at shutdown.
        """
        with self._meta_buffer_lock:
            if not self._meta_buffer:
                return
            to_flush = self._meta_buffer[:]
            self._meta_buffer.clear()
        grouped = {}
        for cam, record in to_flush:
            grouped.setdefault(cam, []).append(record)
        for cam, records in grouped.items():
            try:
                self.db[f"meta_{cam}"].insert_many(records, ordered=False)
                self.logger.info(f"MongoDB batch insert | camera={cam} | count={len(records)}")
            except Exception as e:
                self.logger.error(f"MongoDB batch insert failed | camera={cam}: {e}")

    def _flush_ppe_meta_buffer(self):
        """
        Flush buffered PPE compliance/violation records to MongoDB.

        Mirrors ``_flush_meta_buffer`` but writes to ``meta_ppe_<camera>``
        collections instead of ``meta_<camera>``, keeping the PPE compliance
        stream (every frame, including compliant ones) separate from the
        OD/alert metadata collections.
        """
        with self._meta_buffer_lock:
            if not self._ppe_meta_buffer:
                return
            to_flush = self._ppe_meta_buffer[:]
            self._ppe_meta_buffer.clear()
        grouped = {}
        for cam, record in to_flush:
            grouped.setdefault(cam, []).append(record)
        for cam, records in grouped.items():
            try:
                self.db[f"meta_ppe_{cam}"].insert_many(records, ordered=False)
                self.logger.info(f"PPE MongoDB batch insert | camera={cam} | count={len(records)}")
            except Exception as e:
                self.logger.error(f"PPE MongoDB batch insert failed | camera={cam}: {e}")

    def _flush_jewelry_meta_buffer(self):
        """
        Flush buffered jewelry rule-event records to MongoDB.

        Mirrors ``_flush_ppe_meta_buffer`` but writes to ``meta_jewelry_<camera>``
        collections. Unlike PPE, every buffered record here already represents a
        genuine fired rule (no compliant-frame noise), since jewelry rules
        cooldown-gate at the source before ever publishing.
        """
        with self._meta_buffer_lock:
            if not self._jewelry_meta_buffer:
                return
            to_flush = self._jewelry_meta_buffer[:]
            self._jewelry_meta_buffer.clear()
        grouped = {}
        for cam, record in to_flush:
            grouped.setdefault(cam, []).append(record)
        for cam, records in grouped.items():
            try:
                self.db[f"meta_jewelry_{cam}"].insert_many(records, ordered=False)
                self.logger.info(f"Jewelry MongoDB batch insert | camera={cam} | count={len(records)}")
            except Exception as e:
                self.logger.error(f"Jewelry MongoDB batch insert failed | camera={cam}: {e}")

    @staticmethod
    def _create_default_alert_status():
        """
        Return the default alert status structure used when Redis has no entry for a camera.

        The structure has four top-level keys:

        - ``object_alert``      — overall object-level anomaly alert state.
        - ``frame_alert``       — overall frame-level anomaly alert state.
        - ``detection_alert``   — dict keyed by alert name for detection-based alerts.
        - ``no_object``         — dict keyed by alert name for no-object alerts.

        Each leaf has three fields:
        - ``status``            — whether the alert is currently active.
        - ``count``             — consecutive frames the condition has been true.
        - ``last_alert_time``   — epoch seconds of the most recent notification (0 = never).

        Returns
        -------
        dict
        """
        # OLD: {"status": False, "count": 0}  — missing last_alert_time
        return {
            "object_alert": {"status": False, "count": 0, "last_alert_time": 0},
            "frame_alert": {"status": False, "count": 0, "last_alert_time": 0},
            "detection_alert": {},
            "no_object": {}
        }

    # -------------------- CAMERA CONFIG --------------------

    def fetch_camera_config(self, camera_name: str) -> Optional[Dict[str, Any]]:
        """
        Return the MongoDB configuration document for ``camera_name``.

        The result is cached in ``self.camera_config_dict`` after the first fetch so
        subsequent calls for the same camera return immediately without hitting MongoDB.
        The cache is process-local and not invalidated at runtime; a pod restart is
        required to pick up config changes.

        Parameters
        ----------
        camera_name : str
            The ``Camera_Name`` field value to look up in the ``config`` collection.

        Returns
        -------
        dict or None
            Camera configuration document, or ``None`` if not found or on error.
        """
        # Stage: return from local cache first; only hit MongoDB on first request for this camera
        if camera_name in self.camera_config_dict:
            self.logger.info(f"Camera config cache HIT | camera={camera_name}")
            return self.camera_config_dict[camera_name]

        try:
            self.logger.info(f"Camera config cache MISS — querying MongoDB | camera={camera_name}")
            camera_config = self.config.find_one({"Camera_Name": camera_name})
            if camera_config:
                self.camera_config_dict[camera_name] = camera_config
                self.logger.info(f"Camera config loaded from MongoDB | camera={camera_name}")
                return camera_config
            else:
                self.logger.warning(f"No configuration found in MongoDB | camera={camera_name}")
                return None
        except Exception as e:
            self.logger.error(f"Error fetching camera config from MongoDB: {e}")
            return None

    # -------------------- START / STOP --------------------

    async def start(self):
        """
        Initialise async Kafka clients and enter the main message-processing loop.

        Consumer configuration highlights
        ----------------------------------
        - ``enable_auto_commit=False``        manual commit for at-least-once delivery.
        - ``max_poll_records=10``             batch fetch size (LAG FIX: was 5).
        - ``fetch_max_bytes=5MB``             prevents OOM during backlog spikes.
        - ``max_poll_interval_ms=600000``     allows up to 10 min of processing before
                                              the broker considers the consumer dead.

        Two producers are created:
        - ``producer``                        raw JPEG bytes → ``live_update``.
        - ``notification_producer``           JSON alert payload → ``notification_service``.

        Raises
        ------
        Exception
            Re-raises any startup error after logging; the caller should call
            ``stop()`` for cleanup.
        """
        self.logger.info("Starting Kafka consumer and producers")
        try:
            # Stage: async consumer — manual commit, one record per poll to prevent broker rebalance
            self.consumer = AIOKafkaConsumer(
                self.consumer_topic,
                bootstrap_servers=self.bootstrap_servers,
                group_id=self.consumer_group,
                value_deserializer=lambda m: json.loads(m.decode('utf-8')),
                enable_auto_commit=False,
                # LAG FIX: Increased from 5 → 10. Fetching more records per poll drains
                # the Kafka backlog faster, reducing the queue depth that causes lag.
                max_poll_records=10,
                fetch_max_bytes=5242880,           # 5MB — down from 50MB, prevents OOM during lag spikes
                max_partition_fetch_bytes=1048576, # 1MB per partition cap
                max_poll_interval_ms=600000,
                session_timeout_ms=60000,
                heartbeat_interval_ms=20000,
            )

            # Stage: producer for annotated frame bytes → live_update topic
            self.producer = AIOKafkaProducer(
                bootstrap_servers=self.bootstrap_servers,
            )

            # Stage: producer for notification payloads → notification_service topic
            self.notification_producer = AIOKafkaProducer(
                bootstrap_servers=self.bootstrap_servers,
                value_serializer=lambda v: json.dumps(v).encode('utf-8'),
            )

            await self.consumer.start()
            self.logger.info(f"Kafka consumer started | topic={self.consumer_topic} | group={self.consumer_group}")

            await self.producer.start()
            self.logger.info(f"Kafka producer started | topic={self.producer_topic}")

            await self.notification_producer.start()
            self.logger.info(f"Kafka notification producer started | topic={self.notification_topic}")

            await self.process_messages()

        except Exception as e:
            self.logger.error(f"Failed to start Kafka service: {e}")
            raise

    async def stop(self):
        """
        Gracefully shut down all Kafka clients.

        Stops consumer, frame producer, and notification producer in order.
        Errors during shutdown are logged but not re-raised so the process can
        exit cleanly even if one client fails to stop.
        """
        self.logger.info("Stopping Kafka post-processor service")
        try:
            if self.consumer:
                await self.consumer.stop()
                self.logger.info("Kafka consumer stopped")
            if self.producer:
                await self.producer.stop()
                self.logger.info("Kafka producer stopped")
            if self.notification_producer:
                await self.notification_producer.stop()
                self.logger.info("Kafka notification producer stopped")
        except Exception as e:
            self.logger.error(f"Error stopping Kafka service: {e}")

    # -------------------- ALERT STATUS INIT --------------------

    def set_alert_statuses(self, camera_name: str):
        """
        Initialise per-alert status tracking for a camera in Redis if not already present.

        The Redis key ``alert_status:<camera_name>`` stores the full alert state dict
        (see ``_create_default_alert_status``) serialised as JSON with a 24-hour TTL.

        If the key already exists (e.g. from a previous pod run or another replica),
        the existing state is preserved so cooldown counters are not reset on restart.

        Alert entries are seeded from the MongoDB ``Alerts`` collection:
        - Alerts with ``No_Object_Status=False``  → added under ``"detection_alert"``.
        - Alerts with ``No_Object_Status=True``   → added under ``"no_object"``.

        This method is called from the thread pool as part of the per-frame pipeline
        (via ``asyncio.gather`` alongside ``fetch_camera_config``).

        Parameters
        ----------
        camera_name : str
            Camera identifier to initialise alert status for.
        """
        redis_key = f"alert_status:{camera_name}"
        try:
            if self.redis_client.exists(redis_key):
                self.logger.info(f"Alert status Redis HIT | camera={camera_name}")
                return
        except Exception as e:
            self.logger.warning(f"Redis check failed | camera={camera_name}: {e}")

        self.logger.info(f"Initialising alert status dict | camera={camera_name}")
        status = self._create_default_alert_status()
        alert_configs = self.collection.find({"Camera_Name": camera_name})
        for config in alert_configs:
            # OLD: {"status": False, "count": 0}  — missing last_alert_time
            if not config["No_Object_Status"]:
                status["no_object"][config["Alert_Name"]] = {"status": False, "count": 0, "last_alert_time": 0}
            else:
                status["detection_alert"][config["Alert_Name"]] = {"status": False, "count": 0, "last_alert_time": 0}
        try:
            self.redis_client.setex(redis_key, 86400, json.dumps(status))
            self.logger.info(
                f"Alert status stored in Redis | camera={camera_name} "
                f"| detection_alerts={list(status['detection_alert'].keys())} "
                f"| no_object_alerts={list(status['no_object'].keys())}"
            )
        except Exception as e:
            self.logger.warning(f"Redis write failed | camera={camera_name}: {e}")

    # -------------------- PUBLISH LIVE IMAGE --------------------

    def _start_publish_worker(self):
        """
        Background daemon thread that drains the HTTP publish queue.

        Continuously dequeues ``(live_path, camera_name, image_type)`` tuples and
        POSTs the corresponding JPEG file to the Node.js backend monitor endpoint
        (``http://node_backend:5000/api/monitor/``).

        Design rationale
        ----------------
        HTTP POSTs can take up to ~500 ms (connect + send + response). Running them
        synchronously inside ``process_detection`` would add that latency to every
        frame.  By offloading to this worker thread, the processing pipeline is
        completely decoupled from HTTP response times.

        The queue is capped at 4 items.  ``publish_image`` uses ``put_nowait`` and
        silently drops the publish request when the queue is full — this is
        intentional: live-view freshness is best-effort and should never backpressure
        the processing loop.

        A ``None`` sentinel on the queue signals the worker to exit cleanly.
        """
        q = self._publish_queue
        while True:
            item = q.get()
            if item is None:
                break
            live_path, camera_name, image_type = item
            try:
                image_path = f"{live_path}/{image_type}.jpg"
                im_name = dt.datetime.now().replace(microsecond=0)
                data = {"camera_name": camera_name, "timestamp": im_name, "image_type": image_type}
                with open(image_path, "rb") as file:
                    response = requests.post(
                        f'http://{NODE_BACKEND_HOST}:5000/api/monitor/',
                        files={"image": file}, data=data, timeout=(0.5, 0.5)
                    )
                    self.logger.info(f"Publish live image | camera={camera_name} | type={image_type} | status={response.status_code}")
            except requests.exceptions.Timeout:
                self.logger.info("Publish Image API timed out")
            except Exception as e:
                self.logger.info(f"Publish Image API error: {e}")

    def publish_image(self, live_path, camera_name, image_type):
        """
        Non-blocking enqueue of a live-image publish request.

        Places a ``(live_path, camera_name, image_type)`` tuple on the internal
        bounded queue for the background HTTP worker thread.  If the queue is full
        (worker busy with a slow POST), the request is silently dropped — live-view
        staleness is acceptable; blocking the caller is not.

        Parameters
        ----------
        live_path : str
            Filesystem path to the camera's ``live/`` directory.
        camera_name : str
            Camera identifier (sent as form field to the backend).
        image_type : str
            ``"workday"`` or ``"holiday"`` — selects which JPEG to POST.
        """
        try:
            self._publish_queue.put_nowait((live_path, camera_name, image_type))
        except _queue.Full:
            pass  # drop if worker busy — never blocks

    # -------------------- PROCESS DETECTION (SYNC) --------------------

    def process_detection(self, stream_result: StreamResult) -> ProcessingResult:
        """
        Decode, annotate, and persist a single camera frame.

        This is the CPU-intensive step of the pipeline.  It runs in the default
        ``ThreadPoolExecutor`` (via ``run_in_executor``) so it never blocks the event
        loop.  Multiple frames from the same batch are executed concurrently.

        Processing steps
        ----------------
        1. **Decode** — base64-decode the JPEG payload and convert to a BGR numpy array
           using OpenCV; resize to 640×360.
        2. **Path resolution** — derive the date folder, rounded timestamp filename,
           and alert/frame/spotlight directory paths.
        3. **Throttled raw-frame save** — write the raw (un-annotated) frame to
           ``<camera>/frame/<date>/`` for insight heatmap generation.  Saved at most
           once every 30 s per camera unless an alert or no-object condition is active.
        4. **Annotation branch** (mutually exclusive):
           - ``no_object``    — expected object absent; draw area-of-interest overlay
                                via ``an.draw_filter``; save alert JPEG; update live +
                                spotlight images.
           - ``my_alert``     — user-defined alert fired; draw zone + object overlays;
                                save alert JPEG; update live + spotlight images; optionally
                                POST to Node backend if ``Display_Alert`` is set.
           - ``no_alert``     — no alert; draw detection labels via ``an.draw_labels``;
                                clear spotlight images; update live images.
        5. **Priority selection** — pick the highest-priority non-null annotated frame as
           the final ``result_img``.  Priority order (high → low):
           ``no_object > my_alert > object_auto_alert > frame_auto_alert > no_alert``.

        Parameters
        ----------
        stream_result : StreamResult
            Parsed Kafka message for the frame to process.

        Returns
        -------
        ProcessingResult or None
            ``None`` is returned (and the error logged) if an unhandled exception
            occurs — callers must check for ``None`` before using the result.
        """
        self.logger.info(
            f"[PROCESS DETECTION] frame_id={stream_result.frame_id} | camera={stream_result.camera_name} "
            f"| alerts={stream_result.alert_results} | no_object_status={stream_result.no_object_status}"
        )
        try:
            check = "no_alert"
            frame_anomaly_validity = False
            object_anomaly_validity = False
            prev_spotlight = False
            live_path = self.main_dir + "/" + stream_result.camera_name + "/" + "live"
            spotlight_path = self.main_dir + "/" + stream_result.camera_name + "/" + "spotlight"

            # Stage: decode JPEG bytes from payload into BGR numpy array
            frame_bytes = base64.b64decode(stream_result.frame_bytes.encode("utf-8"))
            frameBuffer = np.frombuffer(frame_bytes, dtype=np.uint8)
            frame = cv2.imdecode(frameBuffer, cv2.IMREAD_COLOR)
            frame = cv2.resize(frame, (640, 360))
            result_img = frame.copy()
            self.logger.info(f"Frame decoded | frame_id={stream_result.frame_id} | shape={frame.shape}")

            # Stage: build file paths for original frame and alert image storage
            date_str = dt.datetime.now().strftime("%Y-%m-%d")
            time_str = stream_result.frame_id.split('@')[1]
            folder_name = date_str
            time_obj = dt.datetime.strptime(time_str, "%H:%M:%S.%f")
            rounded_time_str = time_obj.strftime("%H:%M:%S.") + f"{int(time_obj.microsecond / 10000):02d}"
            file_name = f"{date_str} {rounded_time_str}.jpg"
            self.logger.info(f"File name resolved | file_name={file_name} | camera={stream_result.camera_name}")

            camera_config_data = self.fetch_camera_config(stream_result.camera_name)

            # Stage: save raw frame for insight heatmap (throttled to 1/30s per camera)
            # + always save on alert so frame/ has data for heatmap generation
            _now = time.monotonic()
            _cam = stream_result.camera_name
            _should_save = (
                stream_result.alert_results
                or stream_result.no_object_status
                or (_now - self._last_frame_save.get(_cam, 0)) >= self._frame_save_interval
            )
            if _should_save:
                frame_dir = f"{self.main_dir}/{_cam}/frame/{folder_name}"
                os.makedirs(frame_dir, exist_ok=True)
                cv2.imwrite(os.path.join(frame_dir, file_name), frame)
                self._last_frame_save[_cam] = _now
                self.logger.info(f"Raw frame saved | path={frame_dir}/{file_name}")

            annotated_frames = {
                "no_alert": {"check": check, "frame": frame.copy()},
                "frame_auto_alert": {"check": None, "frame": None},
                "object_auto_alert": {"check": None, "frame": None},
                "my_alert": {"check": None, "frame": None},
                "no_object": {"check": None, "frame": None},
            }

            # Stage: no-object alert — annotate with area-of-interest overlay
            if stream_result.no_object_status:
                self.logger.info(f"Alert type: no_object | camera={stream_result.camera_name}")
                annotated_frames["no_object"]["check"] = "no_object"
                no_object_frame = frame.copy()
                try:
                    if stream_result.alert_result_config:
                        no_object_frame, _, _ = an.draw_filter(
                            stream_result.alert_result_config, no_object_frame, check, self.logger)
                    else:
                        try:
                            no_object_frame, _, _ = an.draw_filter(
                                stream_result.noobj_alert_result_config, no_object_frame, check, self.logger)
                        except Exception as e:
                            self.logger.info(f"No detection draw_filter failed: {e}")

                    alert_name = file_name[:-4] + "_alert.jpg"
                    alert_dir = f"{self.main_dir}/{stream_result.camera_name}/alerts/{folder_name}"
                    os.makedirs(alert_dir, exist_ok=True)
                    cv2.imwrite(os.path.join(alert_dir, alert_name), no_object_frame)
                    self.logger.info(f"No-object alert image saved | path={alert_dir}/{alert_name}")
                    annotated_frames["no_object"]["frame"] = no_object_frame
                    cv2.imwrite(f'{spotlight_path}/workday.jpg', no_object_frame)
                    cv2.imwrite(f'{spotlight_path}/holiday.jpg', no_object_frame)
                    cv2.imwrite(f'{live_path}/workday.jpg', no_object_frame)
                    cv2.imwrite(f'{live_path}/holiday.jpg', no_object_frame)
                    self.logger.info(f"No-object frame written to live and spotlight | camera={stream_result.camera_name}")
                except Exception as e:
                    self.logger.info(f"No Object Alert draw_filter() failed: {e}")

            # Stage: my_alert — annotate with user-defined alert zones and objects
            elif len(stream_result.alert_result_config) > 0:
                self.logger.info(
                    f"Alert type: my_alert | camera={stream_result.camera_name} "
                    f"| alerts={stream_result.alert_results}"
                )
                annotated_frames["my_alert"]["check"] = "my_alert"
                prev_spotlight = True
                my_alert_frame = frame.copy()
                try:
                    my_alert_frame, _, _ = an.draw_filter(
                        stream_result.alert_result_config, my_alert_frame, check, self.logger)

                    alert_name = file_name[:-4] + "_alert.jpg"
                    alert_dir = f"{self.main_dir}/{stream_result.camera_name}/alerts/{folder_name}"
                    os.makedirs(alert_dir, exist_ok=True)
                    cv2.imwrite(os.path.join(alert_dir, alert_name), my_alert_frame)
                    self.logger.info(f"My-alert image saved | path={alert_dir}/{alert_name}")
                    annotated_frames["my_alert"]["frame"] = my_alert_frame
                    cv2.imwrite(f'{spotlight_path}/workday.jpg', my_alert_frame)
                    cv2.imwrite(f'{spotlight_path}/holiday.jpg', my_alert_frame)
                    cv2.imwrite(f'{live_path}/workday.jpg', my_alert_frame)
                    cv2.imwrite(f'{live_path}/holiday.jpg', my_alert_frame)
                    self.logger.info(f"My-alert frame written to live and spotlight | camera={stream_result.camera_name}")

                    if camera_config_data and camera_config_data.get('Display_Alert'):
                        self.publish_image(live_path, stream_result.camera_name, "workday")
                        self.publish_image(live_path, stream_result.camera_name, "holiday")
                except Exception as e:
                    self.logger.info(f"Alert draw_filter() failed: {e}")

            else:
                # Stage: no alert — draw detection labels and update live image only
                self.logger.info(f"Alert type: no_alert | camera={stream_result.camera_name} | drawing detection labels")
                result_img = an.draw_labels(frame, stream_result.detection_results, self.classes, self.logger)
                annotated_frames["no_alert"]["frame"] = result_img
                try:
                    if os.path.exists(f'{spotlight_path}/workday.jpg'):
                        os.remove(f'{spotlight_path}/workday.jpg')
                        self.logger.info(f"Spotlight workday removed | camera={stream_result.camera_name}")
                except Exception as e:
                    self.logger.info(f"No workday spotlight to remove: {e}")
                try:
                    if os.path.exists(f'{spotlight_path}/holiday.jpg'):
                        os.remove(f'{spotlight_path}/holiday.jpg')
                        self.logger.info(f"Spotlight holiday removed | camera={stream_result.camera_name}")
                except Exception as e:
                    self.logger.info(f"No holiday spotlight to remove: {e}")
                cv2.imwrite(f'{live_path}/workday.jpg', result_img)
                cv2.imwrite(f'{live_path}/holiday.jpg', result_img)
                self.publish_image(live_path, stream_result.camera_name, "workday")
                self.publish_image(live_path, stream_result.camera_name, "holiday")

            # Stage: select highest-priority annotated frame as the final result
            result_img = None
            for priority_check in ["no_object", "my_alert", "object_auto_alert", "frame_auto_alert", "no_alert"]:
                if annotated_frames[priority_check]["frame"] is not None:
                    result_img = annotated_frames[priority_check]["frame"]
                    check = annotated_frames[priority_check]["check"]
                    break

            self.logger.info(
                f"Processing result | frame_id={stream_result.frame_id} | camera={stream_result.camera_name} "
                f"| final_check={check} | prev_spotlight={prev_spotlight}"
            )
            return ProcessingResult(
                check=check,
                camera_name=stream_result.camera_name,
                result_img=result_img,
                frame_anomaly_validity=frame_anomaly_validity,
                object_anomaly_validity=object_anomaly_validity,
                prev_spotlight=prev_spotlight
            )

        except Exception as e:
            self.logger.error(f"Error in process_detection | frame_id={stream_result.frame_id}: {e}")
            return None

    # -------------------- PROCESS PPE DETECTION (SYNC) --------------------

    def process_ppe_detection(self, stream_result: StreamResult) -> Optional[PPEProcessingResult]:
        """
        Decode and, for genuine violations, annotate + persist a single PPE message.

        Counterpart to ``process_detection`` for the PPE compliance stream
        (``alert_type == "ppe"``). Runs in the thread pool like ``process_detection``.

        Per colleague decision (see ``ppe_alert_consumer.py``), every PPE frame is
        forwarded regardless of severity — this is a continuous compliance stream,
        not a violation-only filter. To avoid writing an image to disk for every
        compliant frame, this method only decodes+annotates+saves when the frame
        represents an actual violation (non-empty ``violated`` and severity != "none").
        Compliant frames still get a MongoDB metadata record via ``_handle_ppe_result``.

        Parameters
        ----------
        stream_result : StreamResult
            Parsed Kafka message with ``alert_type == "ppe"``.

        Returns
        -------
        PPEProcessingResult or None
            ``None`` is returned (and the error logged) on unhandled exception.
        """
        self.logger.info(
            f"[PROCESS PPE DETECTION] camera={stream_result.camera_name} | severity={stream_result.severity} "
            f"| violated={stream_result.violated}"
        )
        try:
            camera_name = stream_result.camera_name
            has_violation = bool(stream_result.violated) and stream_result.severity not in (None, "none")

            alert_dir = None
            frame_file = None
            crop_file = None

            if has_violation and stream_result.frame:
                frame_bytes = base64.b64decode(stream_result.frame.encode("utf-8"))
                frame_buffer = np.frombuffer(frame_bytes, dtype=np.uint8)
                frame_img = cv2.imdecode(frame_buffer, cv2.IMREAD_COLOR)

                color = PPE_SEVERITY_COLORS.get(stream_result.severity, (0, 255, 0))
                bbox = stream_result.person_bbox
                if frame_img is not None and bbox and len(bbox) == 4:
                    x, y, w, h = (int(v) for v in bbox)
                    cv2.rectangle(frame_img, (x, y), (x + w, y + h), color, 2)
                    label = f"{stream_result.severity.upper()}: missing {', '.join(stream_result.missing or [])}"
                    cv2.putText(frame_img, label, (x, max(y - 8, 0)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

                date_str = dt.datetime.now().strftime("%Y-%m-%d")
                time_str = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-4]
                alert_dir = f"{self.main_dir}/{camera_name}/alerts/{date_str}"
                os.makedirs(alert_dir, exist_ok=True)
                frame_file = f"{time_str}_alert.jpg"
                cv2.imwrite(os.path.join(alert_dir, frame_file), frame_img)
                self.logger.info(f"PPE alert image saved | path={alert_dir}/{frame_file}")
        

            return PPEProcessingResult(
                camera_name=camera_name,
                has_violation=has_violation,
                alert_dir=alert_dir,
                frame_file=frame_file,
                crop_file=None,
            )

        except Exception as e:
            self.logger.error(f"Error in process_ppe_detection | camera={stream_result.camera_name}: {e}")
            return None

    def process_jewelry_detection(self, stream_result: StreamResult) -> Optional[JewelryProcessingResult]:
        """
        Decode and annotate a single jewelry rule-engine event.

        Counterpart to ``process_ppe_detection`` for the jewelry stream
        (``alert_type == "jewelry"``). Runs in the thread pool like
        ``process_detection``/``process_ppe_detection``.

        Unlike PPE, jewelry_alert_consumer.py only ever forwards messages for
        rules that already fired past their own source-side cooldown (see
        jewelry_rules.AlertBus) — there is no compliant/non-event frame to
        filter out here, so an annotated snapshot is always written.

        Parameters
        ----------
        stream_result : StreamResult
            Parsed Kafka message with ``alert_type == "jewelry"``.

        Returns
        -------
        JewelryProcessingResult or None
            ``None`` is returned (and the error logged) on unhandled exception.
        """
        self.logger.info(
            f"[PROCESS JEWELRY DETECTION] camera={stream_result.camera_name} | rule={stream_result.rule} "
            f"| severity={stream_result.severity}"
        )
        try:
            camera_name = stream_result.camera_name
            alert_dir = None
            frame_file = None

            if stream_result.frame:
                frame_bytes = base64.b64decode(stream_result.frame.encode("utf-8"))
                frame_buffer = np.frombuffer(frame_bytes, dtype=np.uint8)
                frame_img = cv2.imdecode(frame_buffer, cv2.IMREAD_COLOR)

                color = PPE_SEVERITY_COLORS.get((stream_result.severity or "").lower(), (0, 255, 0))
                bbox = stream_result.bbox
                if frame_img is not None and bbox and len(bbox) == 4:
                    x1, y1, x2, y2 = (int(v) for v in bbox)
                    cv2.rectangle(frame_img, (x1, y1), (x2, y2), color, 2)
                    label = f"{(stream_result.severity or '').upper()}: {stream_result.rule}"
                    cv2.putText(frame_img, label, (x1, max(y1 - 8, 0)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

                date_str = dt.datetime.now().strftime("%Y-%m-%d")
                time_str = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-4]
                alert_dir = f"{self.main_dir}/{camera_name}/alerts/{date_str}"
                os.makedirs(alert_dir, exist_ok=True)
                frame_file = f"{time_str}_alert.jpg"
                cv2.imwrite(os.path.join(alert_dir, frame_file), frame_img)
                self.logger.info(f"Jewelry alert image saved | path={alert_dir}/{frame_file}")

            return JewelryProcessingResult(
                camera_name=camera_name,
                alert_dir=alert_dir,
                frame_file=frame_file,
            )

        except Exception as e:
            self.logger.error(f"Error in process_jewelry_detection | camera={stream_result.camera_name}: {e}")
            return None

    # -------------------- MAIN CONSUMER LOOP (OLD — sequential, kept for reference) --------------------

    # async def process_messages(self):
    #     """Consume post_processing topic, annotate frames, store metadata, trigger notifications."""
    #     loop = asyncio.get_event_loop()
    #     COMMIT_INTERVAL = 10
    #     MONGO_BATCH_SIZE = 10
    #     self.logger.info(
    #         f"Entering message processing loop | pipeline: {self.consumer_topic} → post_processor → {self.producer_topic} + {self.notification_topic} "
    #         f"| commit_every={COMMIT_INTERVAL}"
    #     )
    #     try:
    #         async for message in self.consumer:
    #             try:
    #                 self.logger.info(
    #                     f"[FRAME RECEIVED] topic={message.topic} | partition={message.partition} "
    #                     f"| offset={message.offset}"
    #                 )
    #                 stream_result = StreamResult.from_message(message.value)
    #                 try:
    #                     frame_time = dt.datetime.strptime(stream_result.frame_id.split('@')[1], "%H:%M:%S.%f")
    #                     frame_dt = dt.datetime.now().replace(
    #                         hour=frame_time.hour, minute=frame_time.minute,
    #                         second=frame_time.second, microsecond=frame_time.microsecond
    #                     )
    #                     age_seconds = (dt.datetime.now() - frame_dt).total_seconds()
    #                     if age_seconds > 30:
    #                         is_alert = bool(stream_result.alert_results or stream_result.no_object_status)
    #                         if is_alert and age_seconds <= 120:
    #                             self.logger.info(f"[STALE ALERT] processing | frame_id={stream_result.frame_id} | age={age_seconds:.1f}s")
    #                         else:
    #                             self.logger.info(f"[STALE DROP] frame_id={stream_result.frame_id} | age={age_seconds:.1f}s — skipped")
    #                             self._commit_count += 1
    #                             if self._commit_count >= COMMIT_INTERVAL:
    #                                 await self.consumer.commit()
    #                                 self._commit_count = 0
    #                             continue
    #                 except Exception as e:
    #                     self.logger.warning(f"Staleness check failed | frame_id={stream_result.frame_id}: {e}")
    #                 proc_result = await loop.run_in_executor(None, self.process_detection, stream_result)
    #                 if proc_result is None:
    #                     continue
    #                 _, image_encoded = cv2.imencode('.jpg', proc_result.result_img)
    #                 frame_bytes = image_encoded.tobytes()
    #                 proc_result = proc_result.to_dict()
    #                 if proc_result:
    #                     proc_result.pop('result_img')
    #                     processed_dict = {key: str(value).encode("utf-8") for key, value in proc_result.items()}
    #                     header = list(processed_dict.items())
    #                     await self.producer.send(self.producer_topic, frame_bytes, str(stream_result.frame_id).encode("utf-8"), headers=header)
    #                     date_str = dt.datetime.now().strftime("%Y-%m-%d")
    #                     time_str = stream_result.frame_id.split('@')[1]
    #                     time_obj = dt.datetime.strptime(time_str, "%H:%M:%S.%f")
    #                     rounded_time_str = time_obj.strftime("%H:%M:%S.") + f"{int(time_obj.microsecond / 10000):02d}"
    #                     timestamp = dt.datetime.strptime(f"{date_str} {rounded_time_str}", "%Y-%m-%d %H:%M:%S.%f")
    #                     result_meta = {"Timestamp": timestamp, "Results": stream_result.detection_results,
    #                                    "No_Object_Status": stream_result.no_object_status,
    #                                    "Frame_Anomaly": stream_result.framebase_prediction,
    #                                    "Object_Anomaly": stream_result.objectbase_prediction,
    #                                    "Alerts": stream_result.alert_results}
    #                     collection_name = f"meta_{stream_result.camera_name}"
    #                     if collection_name not in self.known_collections:
    #                         existing = await loop.run_in_executor(None, self.db.list_collection_names)
    #                         self.known_collections.update(existing)
    #                         if collection_name not in self.known_collections:
    #                             try:
    #                                 await loop.run_in_executor(None, self.db.create_collection, collection_name)
    #                                 self.known_collections.add(collection_name)
    #                             except Exception as e:
    #                                 self.known_collections.add(collection_name)
    #                     if (stream_result.detection_results or stream_result.framebase_prediction
    #                             or stream_result.objectbase_prediction or stream_result.no_object_status):
    #                         self._meta_buffer.append((stream_result.camera_name, result_meta))
    #                     camera_config_data = {}
    #                     try:
    #                         camera_config_data, _ = await asyncio.gather(
    #                             loop.run_in_executor(None, self.fetch_camera_config, stream_result.camera_name),
    #                             loop.run_in_executor(None, self.set_alert_statuses, stream_result.camera_name),
    #                         )
    #                     except Exception as e:
    #                         self.logger.error(f"Error in concurrent config/alert-status fetch: {e}")
    #                     redis_key = f"alert_status:{stream_result.camera_name}"
    #                     try:
    #                         cached = await loop.run_in_executor(None, self.redis_client.get, redis_key)
    #                         previous_statuses = json.loads(cached) if cached else self._create_default_alert_status()
    #                     except Exception as e:
    #                         previous_statuses = self._create_default_alert_status()
    #                     notification_result = NotificationResult(frame_anomaly_validity=False, object_anomaly_validity=False,
    #                                                              alert_validity=[], no_object_validity=[],
    #                                                              previous_alert_statuses=previous_statuses, notification_params=None)
    #                     notification_data = NotificationParams.from_stream_and_processing_results(
    #                         stream_result=stream_result, processing_result=proc_result,
    #                         previous_alert_statuses=previous_statuses, camera_config=camera_config_data,
    #                         timestamp=timestamp.strftime('%Y-%m-%d %H:%M:%S.%f'))
    #                     try:
    #                         flush_task = (loop.run_in_executor(None, self._flush_meta_buffer)
    #                                       if len(self._meta_buffer) >= MONGO_BATCH_SIZE else asyncio.sleep(0))
    #                         _, notif_result = await asyncio.gather(
    #                             flush_task,
    #                             loop.run_in_executor(None, self.notification_service.send_notification, notification_data),
    #                         )
    #                         frame_anomaly, object_anomaly, alert_valid, noobj_valid, prev_statuses, notif_params = notif_result
    #                         notification_result = NotificationResult.from_notification_response(
    #                             frame_anomaly_validity=frame_anomaly, object_anomaly_validity=object_anomaly,
    #                             alert_validity=alert_valid, no_object_validity=noobj_valid,
    #                             previous_alert_statuses=prev_statuses, notification_params=notif_params)
    #                         if notification_result.notification_params:
    #                             await self.notification_producer.send(self.notification_topic,
    #                                 value=notification_result.notification_params,
    #                                 key=stream_result.camera_name.encode("utf-8"))
    #                     except Exception as e:
    #                         self.logger.error(f"Notification service error | frame_id={stream_result.frame_id}: {e}")
    #                     try:
    #                         await loop.run_in_executor(None, self.redis_client.setex,
    #                             f"alert_status:{stream_result.camera_name}", 86400,
    #                             json.dumps(notification_result.previous_alert_statuses))
    #                     except Exception as e:
    #                         self.logger.warning(f"Redis write failed | camera={stream_result.camera_name}: {e}")
    #                     self.camera_config_dict[stream_result.camera_name].update({
    #                         'frame_anomaly_validity': notification_result.frame_anomaly_validity,
    #                         'object_anomaly_validity': notification_result.object_anomaly_validity,
    #                         'alert_validity': notification_result.alert_validity,
    #                         'no_object_validity': notification_result.no_object_validity})
    #                 self._commit_count += 1
    #                 if self._commit_count >= COMMIT_INTERVAL:
    #                     await loop.run_in_executor(None, self._flush_meta_buffer)
    #                     await self.consumer.commit()
    #                     self._commit_count = 0
    #             except Exception as e:
    #                 self.logger.error(f"Error processing message: {e}")
    #     except Exception as e:
    #         self.logger.error(f"Error in message processing loop: {e}")
    #         raise

    # -------------------- PER-FRAME POST-PROCESSING (NEW) --------------------

    async def _handle_result(self, stream_result: StreamResult, proc_result: ProcessingResult, loop, MONGO_BATCH_SIZE: int):
        """
        Encode the annotated frame, publish it to Kafka, persist metadata, and
        trigger notifications for a single successfully processed frame.

        This coroutine is the async counterpart to the sync ``process_detection``
        step.  It is called concurrently for all frames in a batch via
        ``asyncio.gather``.

        Processing stages
        -----------------
        1. **Kafka publish** — JPEG-encode ``proc_result.result_img`` and send it to
           ``live_update`` with frame metadata as Kafka headers.
        2. **Timestamp alignment** — parse the time component of ``frame_id`` and
           build a ``datetime`` object that matches the alert image filename written
           by ``process_detection`` (important for frontend image lookup).
        3. **MongoDB collection bootstrap** — ensure ``meta_<camera>`` collection
           exists (checked once per collection per process lifetime via
           ``known_collections`` cache).
        4. **Meta buffer** — append a detection/alert summary record to the in-memory
           buffer.  Only appended when there is something meaningful to record
           (detections, anomalies, or no-object flag).
        5. **Concurrent config + alert-status init** — fetch camera config from MongoDB
           and initialise Redis alert status in parallel.
        6. **Redis read** — load the latest per-alert cooldown state for the camera.
        7. **Concurrent flush + notification** — run ``_flush_meta_buffer`` (if the
           buffer has reached ``MONGO_BATCH_SIZE``) and ``NotificationService`` in
           parallel.  If a notification payload is produced, publish it to the
           ``notification_service`` Kafka topic.
        8. **Redis write** — persist the updated alert status dict (with incremented
           cooldown counters) back to Redis with a 24-hour TTL.
        9. **Config cache update** — write notification gate flags back into the local
           camera config cache for use by subsequent frames in the same process.

        Parameters
        ----------
        stream_result : StreamResult
            Original parsed Kafka message for this frame.
        proc_result : ProcessingResult
            Annotated frame and alert flags from ``process_detection``.
        loop : asyncio.AbstractEventLoop
            The running event loop (passed in to avoid ``get_event_loop`` overhead).
        MONGO_BATCH_SIZE : int
            Number of buffered records that triggers a MongoDB batch flush.
        """
        try:
            _, image_encoded = cv2.imencode('.jpg', proc_result.result_img)
            frame_bytes = image_encoded.tobytes()
            proc_dict = proc_result.to_dict()
            proc_dict.pop('result_img')

            # Stage: send annotated frame bytes to live_update topic
            processed_dict = {k: str(v).encode("utf-8") for k, v in proc_dict.items()}
            await self.producer.send(
                self.producer_topic, frame_bytes,
                str(stream_result.frame_id).encode("utf-8"),
                headers=list(processed_dict.items())
            )
            self.logger.info(
                f"[Result] frame_id={stream_result.frame_id} | camera={stream_result.camera_name} "
                f"| check={proc_dict.get('check')} | sent_to={self.producer_topic}"
            )

            # Stage: build timestamps for MongoDB record and image file lookup.
            # Must use frame_id time so the timestamp matches the saved alert image filename.
            date_str = dt.datetime.now().strftime("%Y-%m-%d")
            time_str = stream_result.frame_id.split('@')[1]
            time_obj = dt.datetime.strptime(time_str, "%H:%M:%S.%f")
            rounded_time_str = time_obj.strftime("%H:%M:%S.") + f"{int(time_obj.microsecond / 10000):02d}"
            timestamp = dt.datetime.strptime(f"{date_str} {rounded_time_str}", "%Y-%m-%d %H:%M:%S.%f")

            # Stage: ensure per-camera meta collection exists (cached after first check)
            collection_name = f"meta_{stream_result.camera_name}"
            if collection_name not in self.known_collections:
                existing = await loop.run_in_executor(None, self.db.list_collection_names)
                self.known_collections.update(existing)
                if collection_name not in self.known_collections:
                    try:
                        await loop.run_in_executor(None, self.db.create_collection, collection_name)
                        self.known_collections.add(collection_name)
                    except Exception as e:
                        self.logger.warning(f"Collection creation failed or already exists: {e}")
                        self.known_collections.add(collection_name)

            # Stage: buffer meta record — flushed in batch to reduce MongoDB round trips
            if (stream_result.detection_results or stream_result.framebase_prediction
                    or stream_result.objectbase_prediction or stream_result.no_object_status):
                result_meta = {
                    "Timestamp": timestamp,
                    "Results": stream_result.detection_results,
                    "No_Object_Status": stream_result.no_object_status,
                    "Frame_Anomaly": stream_result.framebase_prediction,
                    "Object_Anomaly": stream_result.objectbase_prediction,
                    "Alerts": stream_result.alert_results
                }
                with self._meta_buffer_lock:
                    self._meta_buffer.append((stream_result.camera_name, result_meta))
                self.logger.info(f"Meta buffered | camera={stream_result.camera_name}")

            # Stage: concurrent — fetch camera config + init alert statuses together
            camera_config_data = {}
            try:
                camera_config_data, _ = await asyncio.gather(
                    loop.run_in_executor(None, self.fetch_camera_config, stream_result.camera_name),
                    loop.run_in_executor(None, self.set_alert_statuses, stream_result.camera_name),
                )
            except Exception as e:
                self.logger.error(f"Config/alert-status fetch error: {e}")

            # Stage: read previous alert statuses from Redis
            try:
                cached = await loop.run_in_executor(None, self.redis_client.get, f"alert_status:{stream_result.camera_name}")
                previous_statuses = json.loads(cached) if cached else self._create_default_alert_status()
            except Exception as e:
                self.logger.warning(f"Redis read failed | camera={stream_result.camera_name}: {e}")
                previous_statuses = self._create_default_alert_status()

            notification_result = NotificationResult(
                frame_anomaly_validity=False, object_anomaly_validity=False,
                alert_validity=[], no_object_validity=[],
                previous_alert_statuses=previous_statuses, notification_params=None
            )
            notification_data = NotificationParams.from_stream_and_processing_results(
                stream_result=stream_result, processing_result=proc_dict,
                previous_alert_statuses=previous_statuses, camera_config=camera_config_data,
                timestamp=timestamp.strftime('%Y-%m-%d %H:%M:%S.%f')
            )

            # Stage: concurrent — MongoDB batch flush + notification service together
            try:
                with self._meta_buffer_lock:
                    should_flush = len(self._meta_buffer) >= MONGO_BATCH_SIZE
                flush_task = (
                    loop.run_in_executor(None, self._flush_meta_buffer)
                    if should_flush else asyncio.sleep(0)
                )
                _, notif_result = await asyncio.gather(
                    flush_task,
                    loop.run_in_executor(None, self.notification_service.send_notification, notification_data),
                )
                frame_anomaly, object_anomaly, alert_valid, noobj_valid, prev_statuses, notif_params = notif_result
                notification_result = NotificationResult.from_notification_response(
                    frame_anomaly_validity=frame_anomaly, object_anomaly_validity=object_anomaly,
                    alert_validity=alert_valid, no_object_validity=noobj_valid,
                    previous_alert_statuses=prev_statuses, notification_params=notif_params
                )
                if notification_result.notification_params:
                    await self.notification_producer.send(
                        self.notification_topic,
                        value=notification_result.notification_params,
                        key=stream_result.camera_name.encode("utf-8")
                    )
                    self.logger.info(
                        f"Notification sent | frame_id={stream_result.frame_id} "
                        f"| camera={stream_result.camera_name} | topic={self.notification_topic} "
                        f"| type={notification_result.notification_params.get('Type')}"
                    )
                else:
                    self.logger.info(f"Notification suppressed | frame_id={stream_result.frame_id} | camera={stream_result.camera_name}")
            except Exception as e:
                self.logger.error(f"Notification service error | frame_id={stream_result.frame_id}: {e}")

            # Stage: update per-camera alert state in Redis
            try:
                await loop.run_in_executor(
                    None, self.redis_client.setex,
                    f"alert_status:{stream_result.camera_name}", 86400,
                    json.dumps(notification_result.previous_alert_statuses),
                )
            except Exception as e:
                self.logger.warning(f"Redis write failed | camera={stream_result.camera_name}: {e}")

            if stream_result.camera_name in self.camera_config_dict:
                self.camera_config_dict[stream_result.camera_name].update({
                    'frame_anomaly_validity': notification_result.frame_anomaly_validity,
                    'object_anomaly_validity': notification_result.object_anomaly_validity,
                    'alert_validity': notification_result.alert_validity,
                    'no_object_validity': notification_result.no_object_validity
                })
            self.logger.info(f"Frame complete | frame_id={stream_result.frame_id} | camera={stream_result.camera_name}")

        except Exception as e:
            self.logger.error(f"_handle_result error | frame_id={stream_result.frame_id}: {e}")

    # -------------------- PER-FRAME POST-PROCESSING — PPE --------------------

    async def _handle_ppe_result(self, stream_result: StreamResult, proc_result: PPEProcessingResult, loop, MONGO_BATCH_SIZE: int):
        """
        Persist a PPE compliance/violation record and, for genuine violations,
        trigger the existing notification pipeline.

        Counterpart to ``_handle_result`` for the PPE stream. There is no
        ``live_update`` publish here — the PPE container publishes its own live
        view directly (see ``ppe_reader.py``) — so this only covers MongoDB
        persistence and notification dispatch.

        Parameters
        ----------
        stream_result : StreamResult
            Original parsed Kafka message (``alert_type == "ppe"``).
        proc_result : PPEProcessingResult
            Output of ``process_ppe_detection``.
        loop : asyncio.AbstractEventLoop
        MONGO_BATCH_SIZE : int
            Buffered-record threshold that triggers a MongoDB batch flush.
        """
        try:
            camera_name = stream_result.camera_name
            timestamp = dt.datetime.now()

            # Stage: ensure per-camera PPE meta collection exists (cached after first check)
            collection_name = f"meta_ppe_{camera_name}"
            if collection_name not in self.known_collections:
                existing = await loop.run_in_executor(None, self.db.list_collection_names)
                self.known_collections.update(existing)
                if collection_name not in self.known_collections:
                    try:
                        await loop.run_in_executor(None, self.db.create_collection, collection_name)
                        self.known_collections.add(collection_name)
                    except Exception as e:
                        self.logger.warning(f"PPE collection creation failed or already exists: {e}")
                        self.known_collections.add(collection_name)

            # Stage: buffer this frame's PPE record — every frame, compliant or not
            result_meta = {
                "Timestamp": timestamp,
                "PersonBBox": stream_result.person_bbox,
                "Worn": stream_result.worn,
                "Violated": stream_result.violated,
                "Missing": stream_result.missing,
                "Severity": stream_result.severity,
                "PPEDetections": stream_result.ppe_detections,
                "AlertImage": f"{proc_result.alert_dir}/{proc_result.frame_file}" if proc_result.frame_file else None,
            }
            with self._meta_buffer_lock:
                self._ppe_meta_buffer.append((camera_name, result_meta))
                should_flush = len(self._ppe_meta_buffer) >= MONGO_BATCH_SIZE
            self.logger.info(f"PPE meta buffered | camera={camera_name} | violation={proc_result.has_violation}")

                        # Stage: dual-write into shared alerts collection for the dashboard,
            # only on genuine violations (compliant frames stay in meta_ppe_* only)
            if proc_result.has_violation:
                try:
                    alerts_doc = {
                        "cam_name": camera_name,
                        "alert_type": "PPE_VIOLATION",
                        "severity": stream_result.severity,
                        "metadata": {
                            "worn_ppe": stream_result.worn,
                            "violated_ppe": stream_result.violated,
                            "missing_ppe": stream_result.missing,
                            "person_bbox": stream_result.person_bbox,
                            "ppe_detections": stream_result.ppe_detections,
                        },
                        "frame_path": f"{proc_result.alert_dir}/{proc_result.frame_file}" if proc_result.frame_file else None,
                        "person_crop_path": None,
                        "timestamp": timestamp,
                        "status": "NEW",
                        "acknowledged_by": None,
                        "acknowledged_at": None,
                        "resolved_at": None,
                    }
                    await loop.run_in_executor(None, self.db["alerts"].insert_one, alerts_doc)
                    self.logger.info(f"PPE alert dual-written to alerts collection | camera={camera_name}")
                    try:
                        await loop.run_in_executor(
                            None, self.redis_client.publish,
                            "ppe_live_alerts", json.dumps(alerts_doc, default=str),
                        )
                    except Exception as e:
                        self.logger.error(f"Failed to publish PPE alert to Redis | camera={camera_name}: {e}")
                except Exception as e:
                    self.logger.error(f"Failed to write PPE alert to alerts collection | camera={camera_name}: {e}")


            # Stage: cooldown-gated notification, only meaningful for actual violations
            notification_params = {}
            if proc_result.has_violation:
                try:
                    cached = await loop.run_in_executor(None, self.redis_client.get, f"alert_status:{camera_name}")
                    previous_statuses = json.loads(cached) if cached else self._create_default_alert_status()
                except Exception as e:
                    self.logger.warning(f"Redis read failed | camera={camera_name}: {e}")
                    previous_statuses = self._create_default_alert_status()

                flush_task = (
                    loop.run_in_executor(None, self._flush_ppe_meta_buffer)
                    if should_flush else asyncio.sleep(0)
                )
                _, (previous_statuses, notification_params) = await asyncio.gather(
                    flush_task,
                    loop.run_in_executor(
                        None, self.notification_service.send_ppe_notification,
                        camera_name, stream_result.violated, stream_result.missing,
                        stream_result.severity,
                        (proc_result.frame_file[:-len("_alert.jpg")] if proc_result and proc_result.frame_file else timestamp.strftime('%Y-%m-%d %H:%M:%S.%f')),
                        previous_statuses,
                    ),
                )

                if notification_params:
                    await self.notification_producer.send(
                        self.notification_topic, value=notification_params,
                        key=camera_name.encode("utf-8"),
                    )
                    self.logger.info(
                        f"PPE notification sent | camera={camera_name} | severity={stream_result.severity} "
                        f"| topic={self.notification_topic}"
                    )

                try:
                    await loop.run_in_executor(
                        None, self.redis_client.setex,
                        f"alert_status:{camera_name}", 86400, json.dumps(previous_statuses),
                    )
                except Exception as e:
                    self.logger.warning(f"Redis write failed | camera={camera_name}: {e}")
            elif should_flush:
                await loop.run_in_executor(None, self._flush_ppe_meta_buffer)

            self.logger.info(f"PPE frame complete | camera={camera_name} | violation={proc_result.has_violation}")

        except Exception as e:
            self.logger.error(f"_handle_ppe_result error | camera={stream_result.camera_name}: {e}")

    async def _handle_jewelry_result(self, stream_result: StreamResult, proc_result: JewelryProcessingResult, loop, MONGO_BATCH_SIZE: int):
        """
        Persist a jewelry rule-event record, dual-write it to the shared
        ``alerts`` collection, and trigger the notification pipeline.

        Counterpart to ``_handle_ppe_result`` for the jewelry stream. Simpler
        than PPE's version — every message here is already a genuine fired
        rule (no compliant-frame case to branch on), so there's no
        ``has_violation`` gate: the alert write and notification attempt
        always run.

        Parameters
        ----------
        stream_result : StreamResult
            Original parsed Kafka message (``alert_type == "jewelry"``).
        proc_result : JewelryProcessingResult
            Output of ``process_jewelry_detection``.
        loop : asyncio.AbstractEventLoop
        MONGO_BATCH_SIZE : int
            Buffered-record threshold that triggers a MongoDB batch flush.
        """
        try:
            camera_name = stream_result.camera_name
            rule = stream_result.rule
            timestamp = dt.datetime.now()

            # Stage: ensure per-camera jewelry meta collection exists (cached after first check)
            collection_name = f"meta_jewelry_{camera_name}"
            if collection_name not in self.known_collections:
                existing = await loop.run_in_executor(None, self.db.list_collection_names)
                self.known_collections.update(existing)
                if collection_name not in self.known_collections:
                    try:
                        await loop.run_in_executor(None, self.db.create_collection, collection_name)
                        self.known_collections.add(collection_name)
                    except Exception as e:
                        self.logger.warning(f"Jewelry collection creation failed or already exists: {e}")
                        self.known_collections.add(collection_name)

            # Stage: buffer this event's record
            frame_path = f"{proc_result.alert_dir}/{proc_result.frame_file}" if proc_result and proc_result.frame_file else None
            result_meta = {
                "Timestamp": timestamp,
                "Rule": rule,
                "Zone": stream_result.zone,
                "TrackId": stream_result.track_id,
                "BBox": stream_result.bbox,
                "Severity": stream_result.severity,
                "Metadata": stream_result.metadata,
                "AlertImage": frame_path,
            }
            with self._meta_buffer_lock:
                self._jewelry_meta_buffer.append((camera_name, result_meta))
                should_flush = len(self._jewelry_meta_buffer) >= MONGO_BATCH_SIZE
            self.logger.info(f"Jewelry meta buffered | camera={camera_name} | rule={rule}")

            # Stage: dual-write into shared alerts collection for the dashboard
            try:
                alerts_doc = {
                    "cam_name": camera_name,
                    "alert_type": f"JEWELRY_{rule}" if rule else "JEWELRY_UNKNOWN",
                    "severity": stream_result.severity,
                    "metadata": {
                        "rule": rule,
                        "zone": stream_result.zone,
                        "track_id": stream_result.track_id,
                        "bbox": stream_result.bbox,
                        **(stream_result.metadata or {}),
                    },
                    "frame_path": frame_path,
                    "person_crop_path": None,
                    "timestamp": timestamp,
                    "status": "NEW",
                    "acknowledged_by": None,
                    "acknowledged_at": None,
                    "resolved_at": None,
                }
                await loop.run_in_executor(None, self.db["alerts"].insert_one, alerts_doc)
                self.logger.info(f"Jewelry alert dual-written to alerts collection | camera={camera_name} | rule={rule}")
            except Exception as e:
                self.logger.error(f"Failed to write jewelry alert to alerts collection | camera={camera_name}: {e}")

            # Stage: cooldown-gated notification (dedup insurance — see postfilter.jewelry_status_check)
            try:
                cached = await loop.run_in_executor(None, self.redis_client.get, f"alert_status:{camera_name}")
                previous_statuses = json.loads(cached) if cached else self._create_default_alert_status()
            except Exception as e:
                self.logger.warning(f"Redis read failed | camera={camera_name}: {e}")
                previous_statuses = self._create_default_alert_status()

            flush_task = (
                loop.run_in_executor(None, self._flush_jewelry_meta_buffer)
                if should_flush else asyncio.sleep(0)
            )
            _, (previous_statuses, notification_params) = await asyncio.gather(
                flush_task,
                loop.run_in_executor(
                    None, self.notification_service.send_jewelry_notification,
                    camera_name, rule, stream_result.zone, stream_result.severity,
                    timestamp.strftime('%Y-%m-%d %H:%M:%S.%f'),
                    previous_statuses,
                ),
            )

            if notification_params:
                await self.notification_producer.send(
                    self.notification_topic, value=notification_params,
                    key=camera_name.encode("utf-8"),
                )
                self.logger.info(
                    f"Jewelry notification sent | camera={camera_name} | rule={rule} "
                    f"| topic={self.notification_topic}"
                )

            try:
                await loop.run_in_executor(
                    None, self.redis_client.setex,
                    f"alert_status:{camera_name}", 86400, json.dumps(previous_statuses),
                )
            except Exception as e:
                self.logger.warning(f"Redis write failed | camera={camera_name}: {e}")

            self.logger.info(f"Jewelry event complete | camera={camera_name} | rule={rule}")

        except Exception as e:
            self.logger.error(f"_handle_jewelry_result error | camera={stream_result.camera_name}: {e}")

    # -------------------- MAIN CONSUMER LOOP (NEW — batch concurrent) --------------------

    async def process_messages(self):
        """
        Main Kafka consumer loop — batch-fetches messages and processes them concurrently.

        This is the entry point for the processing pipeline, called from ``start()``.
        It runs forever until a fatal exception escapes (which causes the service to
        restart via the Docker / k8s restart policy).

        Batch processing design
        -----------------------
        Each iteration of the outer ``while True`` loop:

        1. **Fetch** — ``consumer.getmany`` returns up to ``BATCH_SIZE`` messages
           from all assigned partitions with a 1-second poll timeout.
        2. **Parse + staleness filter** — each message is parsed into a ``StreamResult``
           and checked against age thresholds derived from its embedded timestamp:
           - Non-alert frames older than **15 s** are dropped (stale, not actionable).
           - Alert frames up to **60 s** old are still processed (allow for brief lag).
           - Frames beyond 60 s are always dropped regardless of alert status.
        3. **Concurrent detection** — all surviving ``StreamResult`` objects are passed
           to ``process_detection`` via ``asyncio.gather`` + ``run_in_executor`` so
           frame decoding and annotation run in parallel across the thread pool.
        4. **Concurrent post-processing** — for each successfully annotated frame,
           ``_handle_result`` is called concurrently to publish to Kafka, write to
           MongoDB, and trigger notifications.
        5. **Commit** — Kafka offsets are committed every ``COMMIT_INTERVAL`` messages.
           A final ``_flush_meta_buffer`` is also run at commit time to drain any
           remaining buffered MongoDB records.

        Lag-fix annotations
        -------------------
        Each tuning parameter carries a ``# LAG FIX:`` comment explaining the change
        from the previous value and why it reduces end-to-end processing lag.

        Exception handling
        ------------------
        - ``CommitFailedError`` after a consumer group rebalance is caught and logged;
          the loop continues from the next batch.
        - All other unhandled exceptions are re-raised after logging, causing the
          ``asyncio.run(main())`` entry point to exit and the process to restart.
        """
        loop = asyncio.get_event_loop()
        # LAG FIX: Reduced from 50 → 10. Committing more frequently keeps in-flight
        # work small so a slow frame does not hold up offset advancement for 50 messages.
        COMMIT_INTERVAL = 10
        MONGO_BATCH_SIZE = 10
        # LAG FIX: Increased from 5 → 10 to match max_poll_records. Processing a larger
        # batch per iteration drains the Kafka backlog faster and reduces end-to-end lag.
        BATCH_SIZE = 10
        self.logger.info(
            f"Entering message processing loop | pipeline: {self.consumer_topic} → post_processor → {self.producer_topic} + {self.notification_topic} "
            f"| commit_every={COMMIT_INTERVAL} | batch_size={BATCH_SIZE}"
        )

        try:
            while True:
                try:
                    batch = await self.consumer.getmany(timeout_ms=1000, max_records=BATCH_SIZE)
                except Exception as e:
                    self.logger.error(f"Consumer getmany error: {e}")
                    continue

                all_messages = [msg for msgs in batch.values() for msg in msgs]
                if not all_messages:
                    continue

                # Stage: parse + staleness filter the whole batch before touching the executor
                to_process = []
                for message in all_messages:
                    try:
                        stream_result = StreamResult.from_message(message.value)
                        self.logger.info(
                            f"[FRAME RECEIVED] topic={message.topic} | partition={message.partition} "
                            f"| offset={message.offset} | frame_id={stream_result.frame_id} | camera={stream_result.camera_name}"
                        )
                        if stream_result.alert_type == "ppe":
                            # PPE messages carry no frame_id — they're a continuous compliance
                            # stream (see ppe_alert_consumer.py), not subject to the OD
                            # frame_id-based staleness filter below.
                            to_process.append(stream_result)
                            continue
                        try:
                            frame_time = dt.datetime.strptime(stream_result.frame_id.split('@')[1], "%H:%M:%S.%f")
                            frame_dt = dt.datetime.now().replace(
                                hour=frame_time.hour, minute=frame_time.minute,
                                second=frame_time.second, microsecond=frame_time.microsecond
                            )
                            age_seconds = (dt.datetime.now() - frame_dt).total_seconds()
                            # LAG FIX: Lowered non-alert drop threshold from 30s to 15s.
                            # Non-alert frames older than 15s are stale and not worth processing —
                            # dropping them earlier frees the executor for fresh frames and
                            # prevents a growing backlog from adding lag to real alerts.
                            if age_seconds > 15:
                                is_alert = bool(stream_result.alert_results or stream_result.no_object_status)
                                # LAG FIX: Lowered stale-alert processing window from 120s to 60s.
                                # Previously alerts up to 2 minutes old were still being processed,
                                # which caused observed notification lag of 1-2 mins. Cutting to 60s
                                # means we still catch genuinely delayed alerts but discard anything
                                # too old to be actionable.
                                if is_alert and age_seconds <= 60:
                                    self.logger.info(
                                        f"[STALE ALERT] processing | frame_id={stream_result.frame_id} "
                                        f"| camera={stream_result.camera_name} | age={age_seconds:.1f}s"
                                    )
                                else:
                                    self.logger.info(
                                        f"[STALE DROP] frame_id={stream_result.frame_id} "
                                        f"| camera={stream_result.camera_name} | age={age_seconds:.1f}s — skipped"
                                    )
                                    self._commit_count += 1
                                    continue
                        except Exception as e:
                            self.logger.warning(f"Staleness check failed | frame_id={stream_result.frame_id}: {e}")
                        to_process.append(stream_result)
                    except Exception as e:
                        self.logger.error(f"Message parse error: {e}")

                if not to_process:
                    self._commit_count += len(all_messages)
                    if self._commit_count >= COMMIT_INTERVAL:
                        await self.consumer.commit()
                        self._commit_count = 0
                    continue

                # Stage: split the batch — OD/alert frames vs. the PPE compliance stream vs.
                # the jewelry rule-event stream — each has its own decode/annotate/notify
                # pipeline (see process_ppe_detection / process_jewelry_detection). Every
                # stream tagged with a known alert_type is excluded from od_batch — anything
                # else (alert_type is None) is the standard OD/alert schema.
                od_batch = [sr for sr in to_process if sr.alert_type not in ("ppe", "jewelry")]
                ppe_batch = [sr for sr in to_process if sr.alert_type == "ppe"]
                jewelry_batch = [sr for sr in to_process if sr.alert_type == "jewelry"]

                # Stage: run all process_detection / process_ppe_detection / process_jewelry_detection calls concurrently
                self.logger.info(f"[DETECT BATCH] START | od={len(od_batch)} | ppe={len(ppe_batch)} | jewelry={len(jewelry_batch)}")
                proc_results, ppe_proc_results, jewelry_proc_results = await asyncio.gather(
                    asyncio.gather(
                        *[loop.run_in_executor(None, self.process_detection, sr) for sr in od_batch],
                        return_exceptions=True
                    ),
                    asyncio.gather(
                        *[loop.run_in_executor(None, self.process_ppe_detection, sr) for sr in ppe_batch],
                        return_exceptions=True
                    ),
                    asyncio.gather(
                        *[loop.run_in_executor(None, self.process_jewelry_detection, sr) for sr in jewelry_batch],
                        return_exceptions=True
                    ),
                )
                self.logger.info(f"[DETECT BATCH] DONE | od={len(od_batch)} | ppe={len(ppe_batch)} | jewelry={len(jewelry_batch)}")

                # Stage: run all per-frame post-processing concurrently
                handle_tasks = []
                for sr, pr in zip(od_batch, proc_results):
                    if isinstance(pr, Exception) or pr is None:
                        self.logger.error(f"process_detection failed | frame_id={sr.frame_id}: {pr}")
                        continue
                    handle_tasks.append(self._handle_result(sr, pr, loop, MONGO_BATCH_SIZE))
                for sr, pr in zip(ppe_batch, ppe_proc_results):
                    if isinstance(pr, Exception) or pr is None:
                        self.logger.error(f"process_ppe_detection failed | camera={sr.camera_name}: {pr}")
                        continue
                    handle_tasks.append(self._handle_ppe_result(sr, pr, loop, MONGO_BATCH_SIZE))
                for sr, pr in zip(jewelry_batch, jewelry_proc_results):
                    if isinstance(pr, Exception) or pr is None:
                        self.logger.error(f"process_jewelry_detection failed | camera={sr.camera_name}: {pr}")
                        continue
                    handle_tasks.append(self._handle_jewelry_result(sr, pr, loop, MONGO_BATCH_SIZE))

                if handle_tasks:
                    await asyncio.gather(*handle_tasks, return_exceptions=True)

                # Stage: commit Kafka offsets every COMMIT_INTERVAL messages
                self._commit_count += len(all_messages)
                if self._commit_count >= COMMIT_INTERVAL:
                    await loop.run_in_executor(None, self._flush_meta_buffer)
                    await loop.run_in_executor(None, self._flush_ppe_meta_buffer)
                    await loop.run_in_executor(None, self._flush_jewelry_meta_buffer)
                    try:
                        await self.consumer.commit()
                        self.logger.info(f"Kafka offsets committed | count={self._commit_count}")
                    except CommitFailedError:
                        self.logger.warning("CommitFailedError after rebalance — resetting and continuing")
                    self._commit_count = 0

        except CommitFailedError:
            self.logger.warning("CommitFailedError in outer loop — restarting processing loop")
        except Exception as e:
            self.logger.error(f"Error in message processing loop: {e}")
            raise

# -------------------- ENTRYPOINT --------------------

if __name__ == "__main__":
    async def main():
        """
        Application entry point.

        Constructs a ``KafkaService`` wired to the production Kafka/MongoDB/Redis
        addresses resolved at module load time, starts the consumer loop, and ensures
        a graceful shutdown (``stop()``) is attempted on any fatal exception.

        Topic wiring
        ------------
        - Consumer: ``post_processing``       (detection payloads from DeepStream)
        - Producer: ``live_update``           (annotated frames → frontend)
        - Notification producer: ``notification_service`` (alert payloads → email/push)
        """
        service = KafkaService(
            kafka_bootstrap_servers=KAFKA_SERVER,
            mongo_uri=MONGODB_URI,
            consumer_topic="post_processing",
            producer_topic="live_update",
            notification_producer_topic="notification_service",
        )
        try:
            await service.start()
        except Exception as e:
            await service.stop()

    asyncio.run(main())
