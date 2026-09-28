"""
frame_reader.py  —  RTSP Frame Capture, SSIM Pre-filter, and Kafka Publisher
=============================================================================

Architecture Overview
----------------------

    ┌──────────────────────────────────────────────────────────────────────┐
    │                   FRAME READER PIPELINE                              │
    │                                                                      │
    │  RTSP / local device                                                 │
    │    └── cv2.VideoCapture                                              │
    │          │                                                           │
    │          ▼                                                           │
    │    cap.grab()           ← grabs compressed frame (no decode)        │
    │          │                                                           │
    │          ▼ every skip_rate grabs                                     │
    │    cap.retrieve()       ← decodes selected frame to BGR numpy array  │
    │          │                                                           │
    │          ▼                                                           │
    │    cv2.resize → (output_width × output_height)                       │
    │          │                                                           │
    │          ▼                                                           │
    │    SSIM pre-filter                                                   │
    │    ┌─────────────────────────────────────────────────┐               │
    │    │  ssim(prev_frame, curr_frame)                   │               │
    │    │  ssim > threshold AND not force_detection?      │               │
    │    │    YES → skip (update live image only)          │               │
    │    │    NO  → publish to Kafka                       │               │
    │    └─────────────────────────────────────────────────┘               │
    │          │                                                           │
    │          ▼                                                           │
    │    Kafka produce  →  topic: raw_frame                                │
    │    (payload: frame_bytes OR frame_path + frame_id + metadata)        │
    │          │                                                           │
    │          ▼  (if anomaly_detection enabled)                           │
    │    background_generator                                              │
    │      ├── every 5 min  → generate_daily_background_images()          │
    │      ├── every hour   → update_background_video_frames()            │
    │      └── at midnight  → generate_weekly_background()                │
    └──────────────────────────────────────────────────────────────────────┘

SSIM pre-filter
---------------
Structural Similarity Index (SSIM) is computed between consecutive decoded
frames (grayscale, float32 normalised to [0, 1]).  If the SSIM score exceeds
``prefilter_threshold`` (typically 0.90–0.99), the scene has not changed
significantly and the frame is **not** published to Kafka.

This dramatically reduces Kafka throughput for static scenes (e.g. empty
corridor overnight) without missing genuine activity.

Force-detection override
------------------------
To guarantee the downstream pipeline receives at least one frame every 10 s
(even from a completely static scene), ``force_detection`` is set to ``True``
when 10 s have elapsed since the last Kafka publish.  This ensures the live
view is always refreshed and the system is confirmed alive.

Kafka payload modes
-------------------
Controlled by the ``frame_path_enable`` flag:

  ``frame_path_enable=False`` (default):
    The raw JPEG bytes are base64-encoded and embedded directly in the
    JSON payload.  Simpler, works across machines, but larger messages.

  ``frame_path_enable=True``:
    The frame is saved to ``<AKSHA_PATH>/<camera>/frames-today/<frame_id>.jpg``
    and only the file path is included in the payload.  Reduces Kafka
    message size; requires the consumer to share the same filesystem.
    A background cleanup thread removes frames older than 10 minutes.

Background model update schedule (anomaly_detection only)
----------------------------------------------------------
  Every 5 min  → ``generate_daily_background_images``
                  Computes a per-hour median background from accumulated frames.
  Every 1 hour → ``update_background_video_frames``
                  Appends ~10 sampled frames to the hourly background MP4 video.
  At midnight  → ``generate_weekly_background``
                  Recomputes weekly background JPEGs from all 24 hourly MP4s.

Live image slots
----------------
Two JPEG files (``workday.jpg`` and ``holiday.jpg``) under
``<AKSHA_PATH>/<camera>/live/`` represent the current camera view.  They are
updated on every frame (alert or no-alert) and POSTed to the Node.js backend
via ``publish_image`` in a daemon thread so HTTP latency never stalls capture.

A loading placeholder (``LOADING_IMG.png``) is written at startup before the
first real frame arrives.  An RTSP error placeholder (``RTSP_ISSUE_IMG.png``)
is written when ``cap.grab()`` fails.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import datetime as dt        # timestamps, timedelta for RTSP stale check
import math                  # math.floor for background_skip_frames_local
import logging               # logger type
import logging.handlers      # TimedRotatingFileHandler for rotating logs
import gzip                  # gzip compression for rolled-over log files
import shutil                # copyfileobj for gzip rotate, rmtree (cleanup)
import os                    # env vars, path ops, makedirs
import threading             # daemon threads for publish, cleanup, background gen
import time as _time         # _time.sleep in cleanup thread

# ── Third-party ───────────────────────────────────────────────────────────────
import cv2                                    # video capture, resize, encode, imwrite
import numpy as np                            # float32 frame conversion for SSIM
import base64                                 # base64-encode JPEG bytes for Kafka payload
import json                                   # Kafka value serialiser
import uuid                                   # (imported, available for frame ID if needed)
import requests                               # HTTP POST to Node.js backend live-image API
from skimage.metrics import structural_similarity  # SSIM pre-filter computation
from kafka import KafkaProducer               # synchronous Kafka producer

# ── Internal modules ──────────────────────────────────────────────────────────
from background_generator import (
    generate_daily_background_images,   # every-5-min median background update
    generate_weekly_background,         # midnight weekly background rebuild
    update_background_video_frames      # hourly background MP4 append
)


# k8s Service names can't contain underscores (DNS-1035 label) — the Compose
# service "node_backend" is exposed as "node-backend" when this stack runs on
# Kubernetes.
DEPLOYMENT_PLATFORM = os.environ.get("DEPLOYMENT_PLATFORM", "docker").strip().lower()
NODE_BACKEND_HOST   = "node-backend" if DEPLOYMENT_PLATFORM == "kubernetes" else "node_backend"

# ══════════════════════════════════════════════════════════════════════════════
# Kafka configuration — resolved once at module load
# ══════════════════════════════════════════════════════════════════════════════

def load_kafka_config():
    """
    Resolve the Kafka bootstrap server address.

    Resolution order
    ----------------
    1. ``KAFKA_BOOTSTRAP_SERVERS`` environment variable.
    2. If running in Docker (``/.dockerenv`` exists) → ``broker:9092``
       (Compose internal network service name).
    3. Otherwise → ``localhost:9092`` for local development.

    Returns
    -------
    str
        Kafka bootstrap server string.
    """
    print(f"KAFKA_BOOTSTRAP_SERVERS env: {os.environ.get('KAFKA_BOOTSTRAP_SERVERS')}", flush=True)
    print(f"Running in Docker: {os.path.exists('/.dockerenv')}", flush=True)

    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        print("KAFKA_BOOTSTRAP_SERVERS not set in environment, using fallback...", flush=True)
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"    # Docker Compose internal broker name
        else:
            KAFKA_SERVER = "localhost:9092"  # local dev fallback
    else:
        print(f"Using KAFKA_SERVER from environment: {KAFKA_SERVER}", flush=True)

    return KAFKA_SERVER


# Resolve once at module import — all frames in this process use the same broker
KAFKA_SERVER = load_kafka_config()

# Kafka producer: serialises payload dict to UTF-8 JSON.
# All captured frames are published to the 'raw_frame' topic consumed by DeepStream.
producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)


# ══════════════════════════════════════════════════════════════════════════════
# Stale-frame cleanup thread (frame_path_enable mode only)
# ══════════════════════════════════════════════════════════════════════════════

def _cleanup_frames_today(frame_dir: str, logger, max_age_minutes: int = 10):
    """
    Background daemon thread that periodically deletes old frames from the
    ``frames-today`` directory when ``frame_path_enable=True``.

    Why needed?
    -----------
    When ``frame_path_enable=True``, each processed frame is saved as a JPEG
    to ``<AKSHA_PATH>/<camera>/frames-today/``.  Without cleanup, this
    directory accumulates indefinitely.  This thread deletes files whose
    ``mtime`` is older than ``max_age_minutes`` every 5 minutes.

    The cleanup is best-effort — errors are logged but never crash the thread.
    The loop runs forever (daemon thread, killed when the main process exits).

    Parameters
    ----------
    frame_dir : str
        Path to the ``frames-today`` directory to clean up.
    logger : logging.Logger
        Shared frame-reader logger.
    max_age_minutes : int
        Files older than this many minutes are deleted.  Default: 10.
    """
    while True:
        logger.info(f"Cleanup thread started | dir={frame_dir}")
        try:
            if os.path.exists(frame_dir):
                # Cutoff: any file with mtime before this is stale
                cutoff = dt.datetime.now() - dt.timedelta(minutes=max_age_minutes)
                deleted = 0
                for fname in os.listdir(frame_dir):
                    fpath = os.path.join(frame_dir, fname)
                    if os.path.isfile(fpath):
                        # Convert filesystem mtime epoch to datetime for comparison
                        mtime = dt.datetime.fromtimestamp(os.path.getmtime(fpath))
                        if mtime < cutoff:
                            os.remove(fpath)    # remove the stale frame file
                            deleted += 1
                if deleted:
                    logger.info(f"Cleanup: deleted {deleted} stale frames from {frame_dir}")
        except Exception as e:
            logger.error(f"Frame cleanup error: {e}")
        _time.sleep(300)    # run every 5 minutes (300 s)


# ══════════════════════════════════════════════════════════════════════════════
# Logger setup
# ══════════════════════════════════════════════════════════════════════════════

def define_logger(logger_path):
    """
    Create a rotating gzip-compressed logger for the frame reader.

    Log files are rotated at midnight, kept for 30 days, and compressed with
    gzip on rotation.  The logger name is ``"frame_reader"``.

    Parameters
    ----------
    logger_path : str
        Directory where log files are written.  Created if it does not exist.

    Returns
    -------
    logging.Logger
        Configured logger named ``"frame_reader"``.
    """
    os.makedirs(logger_path, exist_ok=True)   # ensure log directory exists

    # Shared formatter for all handlers in this logger
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

    def _make_handler(log_file):
        """
        Build a TimedRotatingFileHandler that gzip-compresses rolled log files.

        Rotation happens at midnight.  The rotator replaces the default rename
        with an open-compress-delete sequence so rolled files end in ``.gz``.
        """
        handler = logging.handlers.TimedRotatingFileHandler(
            filename=log_file,
            when='midnight',      # rotate at midnight
            interval=1,           # daily
            backupCount=30,       # keep 30 days of compressed logs
            encoding='utf-8'
        )

        def _rotator(source, dest):
            # Compress the rolled-over log file with gzip, then remove the plain copy
            with open(source, 'rb') as f_in, gzip.open(dest, 'wb') as f_out:
                shutil.copyfileobj(f_in, f_out)
            os.remove(source)

        handler.rotator = _rotator
        handler.namer = lambda name: name + ".gz"   # appends .gz to rolled filenames
        handler.setFormatter(fmt)
        return handler

    logger = logging.getLogger("frame_reader")
    logger.setLevel(logging.INFO)
    logger.propagate = False    # prevent double-logging to root logger

    # Only add handler if none are present (idempotent — safe to call multiple times)
    if not logger.handlers:
        logger.addHandler(_make_handler(f"{logger_path}/frame-reader.log"))

    return logger


# ══════════════════════════════════════════════════════════════════════════════
# Live image publisher
# ══════════════════════════════════════════════════════════════════════════════

def publish_image(live_path, camera_name, image_type, logger):
    """
    POST a live camera JPEG to the Node.js backend monitor API.

    Always called from a daemon thread (never from the main grab loop) so
    network latency or timeouts never stall frame capture.

    The API endpoint ``http://node_backend:5000/api/monitor/`` receives the
    image as a multipart form upload along with camera metadata.  A (3, 3)
    second connect/read timeout prevents the thread from hanging indefinitely
    on a slow or unavailable backend.

    Parameters
    ----------
    live_path : str
        Directory containing ``workday.jpg`` and ``holiday.jpg``.
    camera_name : str
        Camera identifier sent as form data to the backend.
    image_type : str
        ``"workday"`` or ``"holiday"`` — selects which JPEG to POST.
    logger : logging.Logger
        Shared frame-reader logger.
    """
    try:
        PUBLISH_API = f'http://{NODE_BACKEND_HOST}:5000/api/monitor/'
        image_path = f"{live_path}/{image_type}.jpg"   # e.g. /Aksha/cam101/live/workday.jpg
        im_name = dt.datetime.now().replace(microsecond=0)
        data = {"camera_name": camera_name, "timestamp": im_name, "image_type": image_type}
        with open(image_path, "rb") as file:
            files = {"image": file}
            # Short (3 s connect, 3 s read) timeout — live view is best-effort
            response = requests.post(PUBLISH_API, files=files, data=data, timeout=(3, 3))
            logger.info(f"Publish live image | camera={camera_name} | type={image_type} | status={response.status_code}")
    except requests.exceptions.Timeout:
        logger.info(msg="Publish Image API request timed out (requests timeout)")
    except Exception as e:
        logger.info(msg=f"Publish Image API error: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# Reference image storage
# ══════════════════════════════════════════════════════════════════════════════

def store_reference_image(frame, reference_img_path, output_size, rtsp_id, logger):
    """
    Resize and save a reference (baseline) JPEG for this RTSP stream.

    The reference image is used by downstream services (insight, anomaly model
    initialisation) as a known-good baseline frame for the camera view.

    Called at two moments:
    - First frame of every capture session (baseline initialisation).
    - Daily at 09:00:00 (fresh daily baseline).

    Parameters
    ----------
    frame : np.ndarray
        Current BGR frame from the stream.
    reference_img_path : str
        Directory where reference images are stored
        (``<AKSHA_PATH>/Reference_images/``).
    output_size : tuple[int, int]
        ``(width, height)`` to resize the frame before saving.
    rtsp_id : str
        RTSP stream identifier used as the filename: ``<rtsp_id>.jpg``.
    logger : logging.Logger
        Shared frame-reader logger.
    """
    try:
        ref_img = cv2.resize(frame, output_size)   # resize to standard output resolution
        cv2.imwrite(f"{reference_img_path}/{rtsp_id}.jpg", ref_img)
        logger.info(f"Reference image stored | rtsp_id={rtsp_id} | path={reference_img_path}")
    except Exception as e:
        print("Reference image storing error", e)
        logger.error(f"Reference image storing error: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# Main frame-reader loop
# ══════════════════════════════════════════════════════════════════════════════

def read_frames(camera_name: str, rtsp_id: str, video_path: str, fps: float, output_size: tuple,
                object_detection: bool, anomaly_detection: bool, prefilter_threshold: float,
                frame_path_enable: bool):
    """
    Capture frames from an RTSP stream and publish them to the Kafka ``raw_frame`` topic.

    This is the main execution loop of the frame reader service.  It runs
    indefinitely, restarting the VideoCapture session whenever the stream drops.

    Pipeline (per grabbed frame)
    ----------------------------
    1. **Grab** — ``cap.grab()`` fetches the next compressed frame without
       decoding (cheap).
    2. **Skip-rate filter** — only every ``skip_rate``-th grabbed frame is
       decoded.  ``skip_rate = round(stream_fps / target_fps)`` so the
       published rate approximates ``fps``.
    3. **Decode** — ``cap.retrieve()`` decodes the selected frame to a BGR
       numpy array.
    4. **Resize** — ``cv2.resize`` to ``output_size``.
    5. **Reference image** — saved on first frame and daily at 09:00:00.
    6. **SSIM pre-filter** — structural similarity vs the previous frame.
       If ``ssim > prefilter_threshold`` AND no force-detection, the frame
       is written to the live slot but **not** published to Kafka.
    7. **Force-detection override** — if 10 s have elapsed without a Kafka
       publish, the SSIM filter is bypassed once to guarantee liveness.
    8. **Kafka publish** — payload contains either embedded JPEG bytes
       (``frame_path_enable=False``) or a filesystem path
       (``frame_path_enable=True``).
    9. **Background update** — if ``anomaly_detection=True``, frames are
       accumulated in ``daily_frames`` and background threads are triggered
       every 5 min / 1 h / midnight.

    Restart behaviour
    -----------------
    When ``cap.grab()`` returns ``False`` (RTSP stream lost), the inner loop
    breaks, ``cap.release()`` is called, and the outer ``while True`` loop
    immediately reopens a new ``VideoCapture``.  This gives automatic
    reconnection without process restart.

    Parameters
    ----------
    camera_name : str
        Camera identifier (also used as the subdirectory name under AKSHA_PATH).
    rtsp_id : str
        RTSP stream identifier for reference-image filenames.
    video_path : str
        RTSP URL string, or a numeric string for a local device index.
    fps : float
        Target frames-per-second to publish to Kafka.
    output_size : tuple[int, int]
        ``(width, height)`` for frame resize before encoding.
    object_detection : bool
        Passed through to downstream consumers via Kafka headers.
    anomaly_detection : bool
        When ``True``, enables the background model accumulation and update
        threads.
    prefilter_threshold : float
        SSIM threshold above which unchanged frames are skipped.
        Typical range: 0.90–0.99.
    frame_path_enable : bool
        ``False`` → embed JPEG bytes in Kafka payload (default).
        ``True``  → save frame to disk and include file path in payload.
    """
    # ── Session-level state initialisation ───────────────────────────────────
    RTSP_Down = False          # tracks whether the stream is currently down
    daily_frames = []          # per-hour frame accumulator for background model
    daily_frames_temp = []     # previous hour's frames (used when current list is sparse)
    aksha_path = os.getenv("AKSHA_PATH")   # root of all per-camera data directories

    daily_bg_update_counter = 0   # audit counter: how many bg updates have run

    # Derived paths for this camera
    logger_path     = aksha_path + "/" + camera_name + "/" + "log"
    live_path       = aksha_path + "/" + camera_name + "/" + "live"
    spotlight_path  = aksha_path + "/" + camera_name + "/" + "spotlight"
    reference_img_path = aksha_path + "/" + "Reference_images"

    logger = define_logger(logger_path)

    # One-shot flags to prevent multiple threads per trigger window
    weekly_thread_executed = False
    hourly_thread_executed = False

    # ── Stage: stale-frame cleanup thread (frame_path_enable mode only) ──────
    # When saving frames to disk, a background daemon thread purges files
    # older than 10 minutes every 5 minutes to prevent disk exhaustion.
    if frame_path_enable:
        frame_dir = f"{aksha_path}/{camera_name}/frames-today"
        cleanup_thread = threading.Thread(
            target=_cleanup_frames_today, args=(frame_dir, logger, 10), daemon=True
        )
        cleanup_thread.start()
        logger.info(f"Frame cleanup thread started | dir={frame_dir} | max_age=10min")

    # ── Stage: write loading placeholder to live image slots ─────────────────
    # Shows a "loading" image in the frontend while the RTSP stream initialises.
    # Published to the Node.js backend via daemon threads to avoid blocking.
    try:
        LOADING_IMG = cv2.imread(os.path.join(os.path.dirname(os.path.abspath(__file__)), "LOADING_IMG.png"))
        cv2.imwrite(f"{live_path}/workday.jpg", LOADING_IMG)
        cv2.imwrite(f"{live_path}/holiday.jpg", LOADING_IMG)
        logger.info(f"Loading placeholder written to live path | camera={camera_name}")
        threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
        threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()
    except Exception as e:
        logger.info(msg=f'Live loading error: {e}')

    # ── Outer restart loop — reconnects VideoCapture on stream drop ───────────
    try:
        while True:
            # Per-session state reset (reinitialised on every VideoCapture restart)
            previous_image_status = False   # True once the first frame has been stored
            reference_image = False          # True once reference image has been saved
            bg_gen_min = 61                  # last minute a background gen thread ran (initialised to invalid)

            # ── Stage: open video capture ─────────────────────────────────────
            # Numeric string → local device index; otherwise → RTSP/file URL
            if video_path.isnumeric():
                cap = cv2.VideoCapture(int(video_path))   # e.g. "0" → webcam
            else:
                cap = cv2.VideoCapture(video_path)        # RTSP URL or file path

            video_fps = cap.get(cv2.CAP_PROP_FPS)   # native stream frame rate
            logger.info(f"Video capture opened | camera={camera_name} | source={video_path} | stream_fps={video_fps:.2f} | target_fps={fps}")

            # background_skip_frames_local: number of grabbed frames per ~1 second
            # Used to accumulate one frame per second into daily_frames
            background_skip_frames_local = math.floor(int(video_fps))
            print("background_skip_frames_local:", background_skip_frames_local)
            logger.info(f"Background skip frames per second | camera={camera_name} | value={background_skip_frames_local}")

            background_count = 0   # counts grabbed frames between background accumulations

            # ── Stage: calculate skip_rate ────────────────────────────────────
            # skip_rate = how many grabbed frames to skip between decodes.
            # Example: stream=25 fps, target=1 fps → skip_rate=25 (decode every 25th)
            # If stream FPS <= target FPS, decode every frame (skip_rate=1).
            if video_fps > fps:
                skip_rate = round(video_fps / fps)
            else:
                skip_rate = 1
            print("Skip rate ...", skip_rate, flush=True)
            logger.info(f"Skip rate calculated | camera={camera_name} | skip_rate={skip_rate} (process 1 in every {skip_rate} grabbed frames)")

            # Frame and FPS counters (reset every 10 s for rate logging)
            frame_no = 0
            incoming_frame_counter = 0    # total grabs since last FPS log
            processed_frame_counter = 0   # decoded frames since last FPS log
            raw_frame_counter = 0          # Kafka publishes since last FPS log
            fps_log_time = dt.datetime.now()

            # Tracks when the last frame was published to Kafka (for force-detection)
            last_forced_detection_time = dt.datetime.now()

            # ── Inner grab loop — runs until stream drops ─────────────────────
            while True:
                try:
                    # ── Stage: grab next frame (compressed, no decode) ────────
                    # cap.grab() is fast — it fetches the next packet from the
                    # RTSP buffer without decoding the pixel data.
                    ret = cap.grab()
                    incoming_frame_counter += 1

                    # ── Stage: FPS diagnostics — log every 10 s ───────────────
                    current_time = dt.datetime.now()
                    time_diff = (current_time - fps_log_time).total_seconds()
                    if time_diff >= 10:
                        incoming_fps  = incoming_frame_counter  / time_diff
                        processed_fps = processed_frame_counter / time_diff
                        raw_frame_fps = raw_frame_counter        / time_diff
                        logger.info(
                            f"camera={camera_name} | Incoming FPS: {incoming_fps:.2f} "
                            f"| Processed FPS: {processed_fps:.2f} "
                            f"| Raw Frame FPS: {raw_frame_fps:.2f} "
                            f"| Skip Rate: {skip_rate}"
                        )
                        # Reset counters for the next 10-second window
                        incoming_frame_counter  = 0
                        processed_frame_counter = 0
                        raw_frame_counter        = 0
                        fps_log_time = current_time

                    # ── Stage: RTSP stream lost ───────────────────────────────
                    # cap.grab() returns False when the stream disconnects.
                    # Write an RTSP error placeholder to the live slot, then
                    # break out of the inner loop to trigger a reconnect.
                    if not ret:
                        print("ret failed", flush=True)
                        logger.warning(f"RTSP grab failed — stream lost | camera={camera_name} | source={video_path}")
                        RTSP_Down = True
                        RTSP_ISSUE_IMG = cv2.imread("RTSP_ISSUE_IMG.png")   # "camera offline" placeholder
                        cv2.imwrite(f"{live_path}/workday.jpg", RTSP_ISSUE_IMG)
                        cv2.imwrite(f"{live_path}/holiday.jpg", RTSP_ISSUE_IMG)
                        try:
                            threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                            threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()
                        except Exception as e:
                            logger.info(msg=f"Handling publish api error : {e}")
                            logger.info(msg=f"Restarting Session")
                        break   # exit inner loop → outer while True will reopen capture

                    frame_no += 1

                    # ── Stage: skip-rate filter ───────────────────────────────
                    # Only decode (retrieve) every skip_rate-th grabbed frame.
                    # Frames in between are intentionally dropped — the grab()
                    # call above still advances the RTSP buffer pointer.
                    if (frame_no % skip_rate == 0):
                        processed_frame_counter += 1
                        frame_no = 0   # reset so modulo stays small

                        # ── Stage: decode grabbed frame to BGR numpy array ────
                        _, frame = cap.retrieve()

                        # Advance background accumulation counter by the equivalent
                        # number of native-fps frames for one target-fps interval
                        background_count += round(video_fps / fps)

                        # Build frame_id: "<camera_name>@<HH:MM:SS.ffffff>"
                        timestamp = dt.datetime.now()
                        frame_id = camera_name + "@" + str(timestamp.time())
                        print(f"[FRAME RECEIVED] frame_id={frame_id} | timestamp={timestamp}", flush=True)
                        logger.info(f"[FRAME RECEIVED] frame_id={frame_id} | timestamp={timestamp} | stream_fps={video_fps} | target_fps={fps}")

                        # ── Stage: resize to configured output resolution ─────
                        # All downstream consumers (DeepStream, post_processor)
                        # expect frames at output_size (default 640×360).
                        frame = cv2.resize(frame, output_size)
                        logger.info(f"Frame resized | frame_id={frame_id} | output_size={output_size}")

                        # ── Stage: RTSP recovery notification ─────────────────
                        # If the stream was previously down and has now recovered,
                        # clear the RTSP_Down flag.
                        if RTSP_Down:
                            logger.info(f"RTSP recovered | camera={camera_name}")
                            RTSP_Down = False

                        # ── Stage: reference image storage ────────────────────
                        # Saved once at session start and again daily at 09:00:00
                        # for use by insight and anomaly initialisation.
                        try:
                            im_name = dt.datetime.now().replace(microsecond=0)
                            if str(im_name.time()) == "09:00:00":
                                # Daily 09:00 refresh of the reference baseline
                                logger.info(f"Daily 09:00 reference image update | camera={camera_name}")
                                store_reference_image(frame, reference_img_path, output_size, rtsp_id, logger)
                                reference_image = True
                            if not reference_image:
                                # First frame of this capture session — save as the initial baseline
                                store_reference_image(frame, reference_img_path, output_size, rtsp_id, logger)
                                reference_image = True
                        except Exception as e:
                            print("error in storing reference image:", e)
                            logger.info(msg=f"error in storing reference image:{e}")

                        # ── Stage: SSIM pre-filter ────────────────────────────
                        # Compute structural similarity between the current frame
                        # and the previous one.  Both converted to grayscale
                        # float32 in [0, 1] for the skimage SSIM implementation.
                        if previous_image_status:
                            ssim, _ = structural_similarity(
                                cv2.cvtColor(previous_image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255,
                                cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255,
                                full=True,
                                data_range=1.0,
                                channel_axis=None
                            )
                            previous_image = frame.copy()   # update baseline for next iteration
                            print(f"ssim val {ssim}")
                            logger.info(f"SSIM computed | frame_id={frame_id} | ssim={ssim:.4f} | threshold={prefilter_threshold}")

                            # ── Stage: JPEG-encode frame for Kafka payload ────
                            # Done here (before the skip branch) so encode happens
                            # once regardless of whether the frame is skipped or sent.
                            _, image_encoded = cv2.imencode('.jpg', frame)
                            frame_bytes = base64.b64encode(image_encoded.tobytes()).decode('utf-8')
                            logger.info(f"Frame encoded to JPEG base64 | frame_id={frame_id}")

                            # Kafka message headers: metadata sent alongside the payload bytes
                            header = [
                                ('frame_id',          str(frame_id).encode('utf-8')),
                                ('timestamp_str',     timestamp.isoformat().encode('utf-8')),
                                ('camera_name',       camera_name.encode('utf-8')),
                                ('content-type',      'image/jpeg'.encode('utf-8')),
                                ('anomaly_detection', str(anomaly_detection).encode("utf-8"))
                            ]

                            # force_detection: True if 10 s have elapsed without a Kafka publish.
                            # Bypasses the SSIM filter once to guarantee the pipeline stays alive
                            # even on completely static scenes (e.g. empty corridor at night).
                            force_detection = (dt.datetime.now() - last_forced_detection_time).total_seconds() >= 10

                            # ── Stage: skip unchanged frame ───────────────────
                            # SSIM above threshold AND no force-detection timeout:
                            # scene has not changed enough to warrant processing.
                            # Update the live image slot only; do not publish to Kafka.
                            if ssim > prefilter_threshold and not force_detection:
                                logger.info(f"[FRAME SKIPPED] Scene unchanged (ssim={ssim:.4f} > threshold={prefilter_threshold}) | frame_id={frame_id}")
                                print("frame skipped — scene unchanged (ssim > threshold)", flush=True)

                                # Still update live image so the frontend shows the current view
                                cv2.imwrite(f'{live_path}/workday.jpg', frame)
                                cv2.imwrite(f'{live_path}/holiday.jpg', frame)
                                try:
                                    threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                                    threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()
                                except Exception as e:
                                    logger.info(msg=f"Handling publish api error : {e}")
                                    logger.info(msg=f"Restarting Session")
                                    break

                                # Clear spotlight images (no alert on this frame)
                                try:
                                    if os.path.exists(f'{spotlight_path}/workday.jpg'):
                                        os.remove(f'{spotlight_path}/workday.jpg')
                                        print('spotlight workday image removed')
                                except Exception as e:
                                    logger.info(msg=f"spotlight workday image file not found {e}")
                                try:
                                    if os.path.exists(f'{spotlight_path}/holiday.jpg'):
                                        os.remove(f'{spotlight_path}/holiday.jpg')
                                        print('spotlight holiday image removed')
                                except Exception as e:
                                    logger.info(msg=f"spotlight holiday image file not found {e}")
                                continue   # skip to next grab

                            # ── Stage: forced detection override ──────────────
                            # 10 s elapsed → reset timer and proceed with Kafka publish
                            # regardless of SSIM score.
                            if force_detection:
                                last_forced_detection_time = dt.datetime.now()
                                logger.info(f"[FORCED DETECTION] 10s elapsed without send | frame_id={frame_id}")

                            # ── Stage: build Kafka payload ────────────────────
                            # Two modes based on frame_path_enable:
                            #   False → embed base64 JPEG bytes (simpler, larger messages)
                            #   True  → save to disk and include file path (smaller messages)
                            payload_sent = {}
                            if frame_path_enable:
                                # Save frame to disk and include path in payload
                                frame_dir = f"{aksha_path}/{camera_name}/frames-today"
                                os.makedirs(frame_dir, exist_ok=True)
                                frame_path = f"{frame_dir}/{frame_id}.jpg"
                                cv2.imwrite(frame_path, frame)
                                logger.info(f"Frame saved to disk | frame_id={frame_id} | path={frame_path}")

                                # Update live image slot
                                cv2.imwrite(f'{live_path}/workday.jpg', frame)
                                cv2.imwrite(f'{live_path}/holiday.jpg', frame)
                                threading.Thread(target=publish_image, args=(live_path, camera_name, "workday", logger), daemon=True).start()
                                threading.Thread(target=publish_image, args=(live_path, camera_name, "holiday", logger), daemon=True).start()

                                # Payload: file path instead of bytes
                                payload_sent = {
                                    "frame_id":    frame_id,
                                    "camera_name": camera_name,
                                    "timestamp":   timestamp.isoformat(),
                                    "frame_path":  frame_path,   # consumer reads from shared filesystem
                                }
                            else:
                                # Payload: base64-encoded JPEG bytes embedded directly
                                payload_sent = {
                                    "frame_id":    frame_id,
                                    "camera_name": camera_name,
                                    "timestamp":   timestamp.isoformat(),
                                    "frame_bytes": frame_bytes   # base64 string
                                }
                                logger.info(f"Frame bytes embedded in payload | frame_id={frame_id}")

                            # ── Stage: publish to Kafka raw_frame topic ───────
                            # DeepStream pods consume from this topic and run
                            # object detection / anomaly inference.
                            producer.send('raw_frame', payload_sent, frame_id.encode('utf-8'), headers=header)
                            print(f"[FRAME SENT] frame_id={frame_id} | topic=raw_frame", flush=True)
                            logger.info(f"[FRAME SENT] frame_id={frame_id} | topic=raw_frame | ssim={ssim:.4f} | force={force_detection}")
                            raw_frame_counter += 1

                            # ── Background model update (anomaly_detection) ───────────────────────
                            if anomaly_detection:
                                background_path = f"{aksha_path}/{camera_name}/background"
                                if not os.path.exists(background_path):
                                    os.makedirs(background_path)

                                # ── Stage: accumulate one 256×256 frame per second ───
                                # background_count tracks grabbed frames since the last
                                # accumulation; background_skip_frames_local ≈ stream FPS
                                if background_count == background_skip_frames_local:
                                    background_count = 0
                                    daily_frames.append(cv2.resize(frame, (256, 256)))
                                    print("frame added to daily_frames list ", len(daily_frames))
                                    logger.info(f"Frame added to daily_frames | camera={camera_name} | total={len(daily_frames)}")

                                # ── Stage: every 5 min → daily background update ──────
                                # bg_gen_min prevents multiple triggers within the same minute
                                if not timestamp.minute % 5:
                                    if timestamp.minute != bg_gen_min:
                                        bg_gen_min = timestamp.minute
                                        dailyBGThread = threading.Thread(
                                            target=generate_daily_background_images,
                                            args=(timestamp, background_path, daily_frames, daily_frames_temp, frame, logger)
                                        )
                                        dailyBGThread.start()
                                        daily_bg_update_counter += 1
                                        print("daily bg thread executed")
                                        logger.info(f"Daily background thread started | camera={camera_name} | update_count={daily_bg_update_counter}")

                                # ── Stage: at midnight → weekly background rebuild ─────
                                # weekly_thread_executed prevents re-triggering during the
                                # same minute (reset at minute 15 below)
                                if timestamp.hour == 0 and timestamp.minute == 0 and not weekly_thread_executed:
                                    weeklyBGThread = threading.Thread(
                                        target=generate_weekly_background, args=(background_path, logger)
                                    )
                                    weeklyBGThread.start()
                                    print("weekly bg thread started")
                                    logger.info(f"Weekly background thread started | camera={camera_name}")
                                    weekly_thread_executed = True

                                # ── Stage: at the top of each hour → hourly video update ─
                                # Appends ~10 sampled daily_frames to the hourly MP4 video,
                                # then clears daily_frames for the next hour.
                                if timestamp.minute == 0 and not hourly_thread_executed:
                                    hourlyBGThread = threading.Thread(
                                        target=update_background_video_frames,
                                        args=(timestamp, background_path, daily_frames, logger)
                                    )
                                    hourlyBGThread.start()
                                    logger.info(f"Hourly background video frame update started | camera={camera_name}")
                                    daily_frames_temp = daily_frames.copy()   # snapshot for next 5-min window
                                    daily_frames.clear()                       # reset accumulator for new hour
                                    logger.info(f"daily_frames reset for new hour | camera={camera_name}")
                                    hourly_thread_executed = True

                                # ── Stage: reset one-shot flags at minute 15 ──────────
                                # Ensures weekly and hourly threads can fire again next cycle
                                if timestamp.minute == 15:
                                    hourly_thread_executed = weekly_thread_executed = False

                        else:
                            # ── Stage: first frame — no previous image yet ────
                            # Store current frame as baseline and continue to next grab.
                            # SSIM cannot be computed without a previous frame.
                            print("no previous image — storing as baseline", flush=True)
                            logger.info(f"First frame of session stored as baseline | camera={camera_name} | frame_id={frame_id}")
                            previous_image = frame.copy()
                            previous_image_status = True
                            continue

                except Exception as e:
                    print(f"error faced {e}")
                    logger.info(msg=f"error faced {e}")

            # Stream dropped — release capture and let outer loop reopen it
            cap.release()
            logger.info(f"Video capture released — restarting session | camera={camera_name}")
            print("Restarting video streaming......")

    except Exception as e:
        print("error reading video path", e)
        logger.info(msg=f"error reading video path {e}")
