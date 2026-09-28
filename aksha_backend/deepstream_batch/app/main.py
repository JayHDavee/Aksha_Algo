"""
deepstream_batch — optimised multi-camera batch inference service.

Architecture:

  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  CameraSession  ×N  (one GStreamer thread per camera)                        │
  │                                                                               │
  │  RTSP stream                                                                  │
  │    → rtspsrc (TCP, latency 200 ms)                                           │
  │    → nvv4l2decoder  (NVDEC — hardware H.264/H.265 decode, stays on GPU)     │
  │    → nvvideoconvert  (scale to target res, NV12 → RGBA)                     │
  │    → appsink  [rate-limited to target FPS]                                   │
  │                                                                               │
  │    Step 2 — GPUPrefilter  (picks fastest available path)                    │
  │      cv2.cuda absdiff  →  mean pixel diff  (GPU, no download)               │
  │      numpy   absdiff   →  mean pixel diff  (CPU fallback)                   │
  │      SSIM              →  structural similarity  (FAST_PREFILTER=false)     │
  │      threshold > (1 - ssim_thresh)  →  skip frame if static scene           │
  │                                                                               │
  │    Step 3 — AdaptiveSkip                                                     │
  │      burst  (streak ≤ N frames)  →  run OD every frame                      │
  │      sustained motion            →  run OD every Kth frame                  │
  │                                                                               │
  │    → frame_queue  (maxsize=2, drops stale on full)                           │
  └─────────────────────────┬───────────────────────────────────────────────────┘
                             │  N queues  (one per active camera)
  ┌──────────────────────────▼──────────────────────────────────────────────────┐
  │  BatchWorker  (single thread)                                                 │
  │                                                                               │
  │  collect one frame per camera within BATCH_TIMEOUT_MS                        │
  │    → batch_object_detection  [N, 3, 640, 640]                                │
  │         TRT FP16  →  CUDA  →  CPU  (provider priority)                      │
  │    → encode JPEG  (nvjpeg GPU  →  turbojpeg CPU  →  cv2 fallback)           │
  │    → KafkaProducer  linger=50 ms, gzip                                       │
  │         topic: object_detection_results  (OD results + JPEG frame)           │
  │         topic: raw_frame                 (PUBLISH_RAW_FRAME=true only)       │
  │    → write live thumbnails  +  POST /api/monitor/  (node_backend)           │
  └─────────────────────────────────────────────────────────────────────────────┘

  FastAPI (port 8080)
    POST /reload   — re-read rtsplinks.json, reconcile camera sessions
    GET  /health   — liveness probe
    GET  /cameras  — active camera list with RTSP + FPS

  Controller integration:
    deployment_mode="deepstream_batch"
      → controller writes rtsplinks.json with batch_id per camera
      → POST /reload  triggers CameraSession add / remove / restart
    Per-camera config (fps, resolution, ssim_thresh, codec) fetched from MongoDB
"""

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

import threading
import time
import queue as _queue
import json
import os
import logging
import logging.handlers
import gzip
import shutil
import socket
import base64
import datetime as dt
import numpy as np
import cv2
import pymongo
import requests
import onnxruntime as ort

from fastapi import FastAPI
import uvicorn

from kafka import KafkaProducer
from skimage.metrics import structural_similarity   # fallback when FAST_PREFILTER=false
from object_detection import (
    load_object_detection_model, object_detection,
    batch_object_detection, get_labels,
)

try:
    # libturbojpeg — fastest CPU JPEG encoder, ~3x faster than OpenCV imencode
    from turbojpeg import TurboJPEG as _TurboJPEG
    _turbo = _TurboJPEG()
    _HAS_TURBO = True
except ImportError:
    _turbo = None
    _HAS_TURBO = False

try:
    # nvjpeg — GPU JPEG encoder, fastest option when available (Turing/Ampere+)
    import nvjpeg as _nvjpeg_mod
    _nvjpeg_enc = _nvjpeg_mod.NvJpeg()
    _HAS_NVJPEG = True
except Exception:
    _nvjpeg_enc = None
    _HAS_NVJPEG = False

def _encode_jpeg(frame_bgr, quality=75):
    """
    Encode a BGR numpy frame to JPEG bytes using the fastest available encoder.

    Encoder priority: nvjpeg (GPU, Turing/Ampere+) → turbojpeg (CPU, ~3× OpenCV)
    → cv2.imencode (always available, slowest).
    """
    # Priority: nvjpeg (GPU) → turbojpeg (CPU) → OpenCV (stdlib fallback)
    if _HAS_NVJPEG:
        try:
            return _nvjpeg_enc.encode(frame_bgr, quality)
        except Exception:
            pass  # fall through to next encoder on GPU encode failure
    if _HAS_TURBO:
        return _turbo.encode(frame_bgr, quality=quality)
    # OpenCV fallback — always available, slowest option
    _, buf = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()

Gst.init(None)  # initialise GStreamer before any pipeline is built

# ──────────────────────────────────────────────────────────────────────────────
# ENV
# ──────────────────────────────────────────────────────────────────────────────

# Kafka broker address — auto-selects docker service name vs localhost
KAFKA_SERVER     = os.environ.get("KAFKA_BOOTSTRAP_SERVERS",
                       "broker:9092" if os.path.exists("/.dockerenv") else "localhost:9092")
MONGODB_URI      = os.environ.get("MONGODB_URI",      "mongodb://localhost:27017")
# Root path for live images, reference images, alerts, and log files
AKSHA_PATH       = os.environ.get("AKSHA_PATH",       "/Aksha")
# k8s Service names can't contain underscores (DNS-1035 label) — the Compose service
# "node_backend" is exposed as "node-backend" when this stack runs on Kubernetes.
DEPLOYMENT_PLATFORM = os.environ.get("DEPLOYMENT_PLATFORM", "docker").strip().lower()
NODE_BACKEND_HOST   = "node-backend" if DEPLOYMENT_PLATFORM == "kubernetes" else "node_backend"
OUTPUT_TOPIC     = "object_detection_results"   # Kafka topic for OD results + JPEG frames
RAW_FRAME_TOPIC  = "raw_frame"                  # Kafka topic for raw frames (anomaly pipeline)
PUBLISH_RAW_FRAME  = os.environ.get("PUBLISH_RAW_FRAME",  "false").lower() == "true"
ENABLE_GPU         = os.environ.get("ENABLE_GPU",         "true").lower()  == "true"
ENABLE_TRT         = os.environ.get("ENABLE_TENSORRT",    "true").lower()  == "true"
# FP16 uses Tensor Cores (Turing/Ampere+). Set false for Pascal (GTX 10xx).
ENABLE_TRT_FP16    = os.environ.get("ENABLE_TRT_FP16",    "true").lower()  == "true"
# TRT engine cache — avoids recompiling the TRT engine on every container restart
TRT_CACHE          = os.environ.get("TRT_CACHE_PATH",     "/Aksha/trt_cache")
# How long the batch worker waits for frames before running a partial batch (ms)
BATCH_TIMEOUT_MS   = int(os.environ.get("BATCH_TIMEOUT_MS",   33))
PUBLISH_LIVE_IMAGE = os.environ.get("PUBLISH_LIVE_IMAGE", "true").lower()  == "true"
# Which batch pod this instance handles — controller sets batch_id per camera in rtsplinks.json
BATCH_ID           = int(os.environ.get("BATCH_ID", 1))
# FAST_PREFILTER: full-res GPU/numpy pixel diff (1ms) replacing SSIM (22ms).
FAST_PREFILTER     = os.environ.get("FAST_PREFILTER", "true").lower() == "true"
# ADAPTIVE_SKIP: run OD on every frame for new motion burst; every Nth frame for sustained motion.
ADAPTIVE_SKIP_RATIO   = int(os.environ.get("ADAPTIVE_SKIP_RATIO",   2))
ADAPTIVE_BURST_FRAMES = int(os.environ.get("ADAPTIVE_BURST_FRAMES", 3))

try:
    # Check if the OpenCV build includes CUDA support — used to pick GPU vs CPU prefilter path
    _HAS_CUDA_CV = cv2.cuda.getCudaEnabledDeviceCount() > 0
except (cv2.error, AttributeError):
    _HAS_CUDA_CV = False  # opencv-python (non-cuda build) raises AttributeError

# ──────────────────────────────────────────────────────────────────────────────
# LOGGER
# ──────────────────────────────────────────────────────────────────────────────

_hostname = socket.gethostname()
_log_path = os.path.join(AKSHA_PATH, "log")
os.makedirs(_log_path, exist_ok=True)

def _make_logger():
    """Build a rotating file logger that gzip-compresses rolled logs on midnight rotation."""
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    h   = logging.handlers.TimedRotatingFileHandler(
        filename=f"{_log_path}/deepstream_batch_{_hostname}_b{BATCH_ID}.log",
        when='midnight', interval=1, backupCount=30, encoding='utf-8')
    def _rot(src, dst):
        with open(src, 'rb') as fi, gzip.open(dst, 'wb') as fo:
            shutil.copyfileobj(fi, fo)
        os.remove(src)
    h.rotator = _rot
    h.namer   = lambda n: n + ".gz"
    h.setFormatter(fmt)
    log = logging.getLogger(f"ds_batch_{_hostname}_b{BATCH_ID}")
    log.setLevel(logging.INFO)
    log.propagate = False
    if not log.handlers:
        log.addHandler(h)
    return log

logger = _make_logger()
logger.info(
    f"DeepStream batch service starting | kafka={KAFKA_SERVER} | "
    f"mongo={MONGODB_URI} | batch_id={BATCH_ID} | "
    f"fast_prefilter={FAST_PREFILTER} | cuda_cv={_HAS_CUDA_CV} | "
    f"turbojpeg={_HAS_TURBO} | "
    f"adaptive_skip={ADAPTIVE_SKIP_RATIO} burst={ADAPTIVE_BURST_FRAMES}"
)

# ──────────────────────────────────────────────────────────────────────────────
# STEP 3 — ADAPTIVE FRAME SKIP
# Module-level singleton. Tracks per-camera motion streak.
# New burst (streak ≤ burst_frames) → run OD every frame.
# Sustained motion (streak > burst_frames) → run OD every skip_ratio frames.
# ──────────────────────────────────────────────────────────────────────────────

class _AdaptiveSkip:
    def __init__(self, skip_ratio: int = 2, burst_frames: int = 3):
        self._skip_ratio   = skip_ratio   # run OD every Nth frame during sustained motion
        self._burst_frames = burst_frames  # number of frames to treat as a fresh burst
        self._streak:  dict[str, int] = {}  # consecutive motion frames per camera
        self._counter: dict[str, int] = {}  # frame counter during sustained motion per camera

    def should_run_od(self, camera_name: str, motion: bool) -> bool:
        if not motion:
            # No motion — reset both streak and counter so next motion starts a fresh burst
            self._streak[camera_name]  = 0
            self._counter[camera_name] = 0
            return False

        # Increment consecutive motion streak for this camera
        streak = self._streak.get(camera_name, 0) + 1
        self._streak[camera_name] = streak

        if streak <= self._burst_frames:
            # Fresh burst — run OD on every frame to catch fast-moving objects
            return True

        # Sustained motion — throttle OD to every skip_ratio-th frame to save GPU
        count = self._counter.get(camera_name, 0) + 1
        self._counter[camera_name] = count
        return (count % self._skip_ratio) == 0

    def reset(self, camera_name: str):
        # Called on forced frames and reconnects to restart burst counting
        self._streak.pop(camera_name, None)
        self._counter.pop(camera_name, None)

_adaptive_skip = _AdaptiveSkip(
    skip_ratio=ADAPTIVE_SKIP_RATIO,
    burst_frames=ADAPTIVE_BURST_FRAMES,
)

# ──────────────────────────────────────────────────────────────────────────────
# LIVE IMAGE PUBLISHER  (_LivePublisher)
# Single background thread — replaces thread-per-call pattern.
# Coalesces concurrent submits; always sends most recent frame per camera.
# ──────────────────────────────────────────────────────────────────────────────

class _LivePublisher:
    def __init__(self):
        # Pending dict keyed by "camera:image_type" — newer submits overwrite older ones,
        # so the worker always sends the most recent frame, never a stale one
        self._pending: dict[str, tuple] = {}
        self._lock  = threading.Lock()
        self._event = threading.Event()  # signals the worker thread that work is ready
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def submit(self, path, camera_name, image_type):
        if not PUBLISH_LIVE_IMAGE:
            return
        with self._lock:
            # Overwrite any pending entry for the same camera+type — keeps only the latest frame
            self._pending[f"{camera_name}:{image_type}"] = (path, camera_name, image_type)
        self._event.set()  # wake the background worker

    def _run(self):
        while True:
            self._event.wait()   # block until at least one submit arrives
            self._event.clear()
            with self._lock:
                # Drain all pending items in one lock acquisition
                batch = list(self._pending.values())
                self._pending.clear()
            for path, camera_name, image_type in batch:
                try:
                    data = {"camera_name": camera_name,
                            "timestamp":   dt.datetime.now().replace(microsecond=0),
                            "image_type":  image_type}
                    with open(f"{path}/{image_type}.jpg", "rb") as f:
                        # Short connect+read timeout — node_backend is local; don't stall the thread
                        requests.post(f"http://{NODE_BACKEND_HOST}:5000/api/monitor/",
                                      files={"image": f}, data=data, timeout=(1.0, 1.0))
                except Exception as e:
                    logger.debug(f"publish_live_image error | camera={camera_name}: {e}")

_live_publisher = _LivePublisher()

def publish_live_image(path, camera_name, image_type):
    _live_publisher.submit(path, camera_name, image_type)

# ──────────────────────────────────────────────────────────────────────────────
# STEP 1 — KAFKA PRODUCER with linger + lz4 compression
# kafka-python params: linger_ms (not linger.ms), compression_type (not compression.type)
# ──────────────────────────────────────────────────────────────────────────────

producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    linger_ms=50,               # buffer 50ms before send — batches alert bursts together
    batch_size=131072,          # 128KB batch buffer per partition
    compression_type='gzip',    # gzip is stdlib — no extra package needed
    acks=1,                     # leader ack only — sufficient for detection events
    value_serializer=lambda v: json.dumps(v).encode('utf-8'),
)
logger.info(f"Kafka producer ready | topic={OUTPUT_TOPIC} | linger_ms=50 gzip")

# ──────────────────────────────────────────────────────────────────────────────
# MONGODB
# ──────────────────────────────────────────────────────────────────────────────

_mongo  = pymongo.MongoClient(MONGODB_URI)
_config = _mongo["Aksha"]["config"]

def fetch_camera_config(camera_name: str) -> dict:
    """Return the MongoDB config document for *camera_name*, or {} on any failure."""
    try:
        return _config.find_one({"Camera_Name": camera_name}) or {}
    except Exception as e:
        logger.warning(f"MongoDB config fetch failed | camera={camera_name}: {e}")
        return {}

# ──────────────────────────────────────────────────────────────────────────────
# INFERENCE SETUP
# ──────────────────────────────────────────────────────────────────────────────

# Bump this string whenever the ONNX model or its patching logic changes.
# ORT's TRT cache key ignores non-TRT op attributes (e.g. TopK axis), so a
# stale cache can silently load the old broken graph for fallback CUDA ops.
_TRT_CACHE_VERSION = "patched-version"

available = ort.get_available_providers()
if ENABLE_GPU and ENABLE_TRT and "TensorrtExecutionProvider" in available:
    os.makedirs(TRT_CACHE, exist_ok=True)
    _ver_file = os.path.join(TRT_CACHE, ".cache_version")
    _cached_ver = open(_ver_file).read().strip() if os.path.exists(_ver_file) else ""
    if _cached_ver != _TRT_CACHE_VERSION:
        import glob as _glob
        _removed = 0
        for _ef in _glob.glob(os.path.join(TRT_CACHE, "*.engine")) + \
                   _glob.glob(os.path.join(TRT_CACHE, "*.profile")):
            os.remove(_ef)
            _removed += 1
        with open(_ver_file, "w") as _f:
            _f.write(_TRT_CACHE_VERSION)
        logger.info(f"TRT cache cleared | {_removed} stale files removed | version → {_TRT_CACHE_VERSION}")
    providers = [
        ("TensorrtExecutionProvider", {
            "trt_fp16_enable": ENABLE_TRT_FP16,
            "trt_engine_cache_enable": True,
            "trt_engine_cache_path": TRT_CACHE,
            "trt_max_workspace_size": 1 << 30,
        }),
        ("CUDAExecutionProvider", {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"}),
        "CPUExecutionProvider",
    ]
    logger.info("Inference: TensorRT FP16 → CUDA → CPU")
elif ENABLE_GPU and "CUDAExecutionProvider" in available:
    providers = [
        ("CUDAExecutionProvider", {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"}),
        "CPUExecutionProvider",
    ]
    logger.info("Inference: CUDA → CPU")
else:
    providers = ["CPUExecutionProvider"]
    logger.info("Inference: CPU only")

_app_dir    = os.path.dirname(__file__)
_model_path = os.path.join(_app_dir, "yolov10.onnx")
logger.info("Using yolov10.onnx (static model)")

_names_path = os.path.join(_app_dir, "coco.names")

logger.info(f"Loading model: {os.path.basename(_model_path)}")
ort_session, class_names, colors = load_object_detection_model(_model_path, _names_path, providers=providers)
object_detection(np.zeros((640, 640, 3), dtype=np.uint8), ort_session, class_names, colors)
logger.info("Model warmup complete")

# ──────────────────────────────────────────────────────────────────────────────
# CAMERA SESSION
# ──────────────────────────────────────────────────────────────────────────────

class CameraSession:
    """
    One GStreamer NVDEC pipeline per camera.
    Frames that pass GPUPrefilter + AdaptiveSkip are queued for BatchWorker.
    """

    def __init__(self, camera_name: str, rtsp_url: str, config: dict, rtsp_id: str = None):
        """
        Initialise per-camera state; does not start the GStreamer thread.
        Call start() after construction to begin decoding.
        """
        self.camera_name  = camera_name
        self.rtsp_url     = rtsp_url
        self.width        = int(config.get("Output_Width",  640))   # decode resolution width
        self.height       = int(config.get("Output_Height", 360))   # decode resolution height
        self.target_fps   = float(config.get("FPS", 1.0))           # desired processing rate
        self.ssim_thresh  = float(config.get("SSIM_Thresh", 0.95))  # motion sensitivity threshold
        # rtsp_id identifies this camera in Reference_images; falls back to camera_name if not set
        self.rtsp_id      = rtsp_id if rtsp_id is not None else config.get("RTSP_ID", camera_name)
        self.codec        = config.get("RTSP_Codec", "h264")
        # Minimum seconds between processed frames = 1 / FPS
        self.min_interval = 1.0 / self.target_fps

        # maxsize=2: allows one frame in flight while BatchWorker processes the previous one;
        # the put_nowait/get_nowait pattern drops stale frames rather than blocking the pipeline
        self.frame_queue  = _queue.Queue(maxsize=2)
        self._stop_event  = threading.Event()
        self._thread      = threading.Thread(target=self._run, daemon=True)

        self.live_path = os.path.join(AKSHA_PATH, camera_name, "live")
        self.ref_path  = os.path.join(AKSHA_PATH, "Reference_images")
        # Create all required output directories on startup
        for p in [self.live_path, self.ref_path,
                  os.path.join(AKSHA_PATH, camera_name, "spotlight"),
                  os.path.join(AKSHA_PATH, camera_name, "alerts"),
                  os.path.join(AKSHA_PATH, camera_name, "frame")]:
            os.makedirs(p, exist_ok=True)

        # Prefilter state — holds the previous frame for motion comparison
        self.prev_frame       = None   # CPU numpy array (SSIM / numpy-diff path)
        self._prev_gpu        = None   # cv2.cuda_GpuMat (GPU-diff path, Step 2)
        self.last_proc        = 0.0    # monotonic time of last processed frame
        self.last_force       = 0.0    # monotonic time of last forced OD frame
        self._last_live_write = 0.0    # monotonic time of last live thumbnail write
        self._ref_date        = None   # date of last reference image write

        logger.info(f"CameraSession created | camera={camera_name} | fps={self.target_fps}")

    def start(self):  self._thread.start()
    def stop(self):
        self._stop_event.set()
        _adaptive_skip.reset(self.camera_name)
        logger.info(f"CameraSession stop requested | camera={self.camera_name}")

    def _build_pipeline(self) -> Gst.Pipeline:
        """
        Assemble and return a parsed GStreamer pipeline for this camera.

        Chain: rtspsrc (TCP) → depay/parse → nvv4l2decoder (NVDEC, on-GPU) →
               nvvideoconvert (scale + NV12) → nvvideoconvert (RGBA) → appsink
        """
        # Select depayloader and parser elements based on stream codec
        depay = "rtph264depay" if self.codec == "h264" else "rtph265depay"
        parse = "h264parse"    if self.codec == "h264" else "h265parse"
        s = (
            # rtspsrc: pull RTSP stream; latency=200ms buffer, TCP avoids UDP packet loss
            f"rtspsrc location=\"{self.rtsp_url}\" latency=200 protocols=tcp retry=5 "
            # depay+parse: unpack RTP packets and parse bitstream headers
            f"! {depay} ! {parse} ! nvv4l2decoder "
            # nvv4l2decoder: hardware H.264/H.265 decode on Jetson/NVDEC — stays on GPU memory
            f"! nvvideoconvert "
            # First nvvideoconvert: scale to target resolution while still in GPU (NVMM) memory
            f"! video/x-raw(memory:NVMM),format=NV12,width={self.width},height={self.height} "
            # Second nvvideoconvert: convert NV12 → RGBA so numpy can read it as 4-channel array
            f"! nvvideoconvert ! video/x-raw,format=RGBA "
            # appsink: pull frames manually; max-buffers=2 + drop=true discards stale frames
            f"! appsink name=appsink0 emit-signals=false sync=false max-buffers=2 drop=true"
        )
        pipeline = Gst.parse_launch(s)
        if not pipeline:
            raise RuntimeError(f"Pipeline parse failed | camera={self.camera_name}")
        return pipeline

    def _motion_check(self, cpu_frame, gpu_frame, frame_id: str, force: bool) -> bool:
        """
        Return True if the frame has changed enough to warrant object detection.

        Three paths tried in order of speed:
          1. GPU absdiff via cv2.cuda  — no CPU download needed (FAST_PREFILTER + cuda build)
          2. Numpy mean-absolute-diff  — CPU fallback when cv2.cuda is unavailable
          3. SSIM                      — original method; only used when FAST_PREFILTER=false

        *force* bypasses the threshold and always returns True, ensuring OD runs
        at least every FORCE_INTERVAL seconds even on a static scene.
        """
        # STEP 2 — full GPU path keeps the diff decision on-device; only downloads
        # to CPU when the frame actually needs to go to OD or live-write.
        # First frame — store reference, always process
        if self._prev_gpu is None and self.prev_frame is None:
            if gpu_frame is not None:
                self._prev_gpu = gpu_frame.clone()
            else:
                self.prev_frame = cpu_frame.copy()
            return True

        if FAST_PREFILTER and _HAS_CUDA_CV and gpu_frame is not None:
            # ── Full GPU path — no CPU involvement ──────────────────────────
            diff = cv2.cuda.absdiff(gpu_frame, self._prev_gpu)
            gray = cv2.cuda.cvtColor(diff, cv2.COLOR_RGB2GRAY)
            # L1 norm / total pixels / 255 → mean per-pixel change in [0,1]
            score = cv2.cuda.norm(gray, cv2.NORM_L1) / (self.height * self.width * 255.0)
            self._prev_gpu = gpu_frame.clone()
            if score < (1.0 - self.ssim_thresh) and not force:
                logger.debug(f"[STATIC SCENE] diff={score:.4f} | prefilter=GPU | frame_id={frame_id}")
                return False

        elif FAST_PREFILTER and cpu_frame is not None:
            # ── Numpy fallback (no cv2.cuda) ─────────────────────────────────
            diff  = np.abs(cpu_frame.astype(np.float32) - self.prev_frame.astype(np.float32))
            score = np.mean(diff) / 255.0
            self.prev_frame = cpu_frame.copy()
            if score < (1.0 - self.ssim_thresh) and not force:
                logger.debug(f"[STATIC SCENE] diff={score:.4f} | prefilter=CPU | frame_id={frame_id}")
                return False

        else:
            # ── Original SSIM (FAST_PREFILTER=false) ─────────────────────────
            frame = cpu_frame if cpu_frame is not None else gpu_frame.download()
            g_cur  = cv2.cvtColor(frame,           cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
            g_prev = cv2.cvtColor(self.prev_frame, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
            ssim, _ = structural_similarity(g_prev, g_cur, full=True, data_range=1.0, channel_axis=None)
            self.prev_frame = frame.copy()
            if ssim > self.ssim_thresh and not force:
                logger.debug(f"[STATIC SCENE] ssim={ssim:.4f} | prefilter=SSIM | frame_id={frame_id}")
                return False

        return True

    def _write_live(self, frame_bgr):
        """Write workday/holiday thumbnails and push to node_backend."""
        data = _encode_jpeg(frame_bgr)
        for name in ("workday", "holiday"):
            with open(f"{self.live_path}/{name}.jpg", "wb") as f:
                f.write(data)
            publish_live_image(self.live_path, self.camera_name, name)

    def _run(self):
        """
        Main GStreamer decode loop — runs until stop() is called.

        Lifecycle per iteration:
          1. Build pipeline and attach bus watcher.
          2. Pull frames from appsink; rate-limit to target FPS.
          3. Run prefilter (Step 2) and adaptive skip (Step 3).
          4. Queue frames that pass both gates for BatchWorker.
          5. On EOS/error: tear down pipeline, show RTSP issue image,
             reset prefilter state, then retry after 5 s.
        """
        rtsp_issue = cv2.imread(os.path.join(os.path.dirname(__file__), "RTSP_ISSUE_IMG.png"))
        loading    = cv2.imread(os.path.join(os.path.dirname(__file__), "LOADING_IMG.png"))

        while not self._stop_event.is_set():
            try:
                if loading is not None:
                    cv2.imwrite(f"{self.live_path}/workday.jpg", loading)
                    cv2.imwrite(f"{self.live_path}/holiday.jpg", loading)

                pipeline = self._build_pipeline()
                appsink  = pipeline.get_by_name("appsink0")
                loop     = GLib.MainLoop()
                bus      = pipeline.get_bus()
                bus.add_signal_watch()
                restart  = threading.Event()

                def _on_bus(b, msg):
                    if msg.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
                        err = msg.parse_error()[0].message if msg.type == Gst.MessageType.ERROR else "EOS"
                        logger.warning(f"GStreamer {Gst.message_type_get_name(msg.type)} | camera={self.camera_name} | {err}")
                        restart.set()
                        loop.quit()
                    return True

                bus.connect("message", _on_bus)
                threading.Thread(target=loop.run, daemon=True).start()
                pipeline.set_state(Gst.State.PLAYING)
                logger.info(f"Pipeline PLAYING | camera={self.camera_name}")

                FORCE_INTERVAL    = 10.0
                NO_FRAME_TIMEOUT  = 30.0  # restart pipeline if no frames arrive for this many seconds
                last_frame_time   = time.monotonic()

                while not self._stop_event.is_set() and not restart.is_set():
                    # Block up to 1s for the next decoded frame; returns None on timeout
                    sample = appsink.emit('try-pull-sample', Gst.SECOND)
                    if sample is None:
                        if time.monotonic() - last_frame_time > NO_FRAME_TIMEOUT:
                            logger.warning(f"No frames for {NO_FRAME_TIMEOUT:.0f}s | camera={self.camera_name} | restarting pipeline")
                            restart.set()
                        continue

                    last_frame_time = time.monotonic()  # reset watchdog on each received frame
                    now = time.monotonic()
                    # Rate-limit: skip this frame if we processed one too recently
                    if now - self.last_proc < self.min_interval:
                        continue
                    self.last_proc = now

                    buf     = sample.get_buffer()
                    ok, mi  = buf.map(Gst.MapFlags.READ)
                    if not ok:
                        continue

                    # ── STEP 2: zero-copy buffer extract + single GPU upload ──
                    try:
                        # Interpret the raw RGBA buffer as a numpy array — no copy yet
                        arr = np.frombuffer(mi.data, dtype=np.uint8).reshape(
                            self.height, self.width, 4)
                        if _HAS_CUDA_CV and FAST_PREFILTER:
                            # Upload RGB slice to GPU while buffer is still mapped — no extra CPU copy
                            gpu_frame = cv2.cuda_GpuMat()
                            gpu_frame.upload(arr[:, :, :3])  # drop alpha channel
                            cpu_frame = None
                        else:
                            # Must .copy() before unmap — frombuffer is a zero-copy view
                            cpu_frame = arr[:, :, :3].copy()
                            gpu_frame = None
                    finally:
                        buf.unmap(mi)   # release GStreamer buffer immediately after extract

                    ts       = dt.datetime.now()
                    # Unique frame ID used as Kafka message key and for tracing
                    frame_id = f"{self.camera_name}@{ts.strftime('%H:%M:%S.%f')}"
                    # Force OD every FORCE_INTERVAL seconds regardless of motion result
                    force    = (now - self.last_force) >= FORCE_INTERVAL

                    # Daily reference image (written once per day + 09:00 daily refresh)
                    today = ts.date()
                    if self._ref_date != today or (ts.hour == 9 and ts.minute == 0):
                        try:
                            ref = cpu_frame if cpu_frame is not None else gpu_frame.download()
                            cv2.imwrite(f"{self.ref_path}/{self.rtsp_id}.jpg",
                                        cv2.cvtColor(ref, cv2.COLOR_RGB2BGR))
                        except Exception:
                            pass
                        self._ref_date = today

                    # ── STEP 2: motion check — stays on GPU, no .download() needed ──
                    motion = self._motion_check(cpu_frame, gpu_frame, frame_id, force)

                    if not motion:
                        # Static scene — update live thumbnail at FPS rate but skip OD
                        now_t = time.monotonic()
                        if now_t - self._last_live_write >= self.min_interval:
                            f = cpu_frame if cpu_frame is not None else gpu_frame.download()
                            self._write_live(cv2.cvtColor(f, cv2.COLOR_RGB2BGR))
                            self._last_live_write = now_t
                        continue

                    # ── STEP 3: adaptive skip — throttle OD during sustained background motion ──
                    if not force and not _adaptive_skip.should_run_od(self.camera_name, True):
                        # Motion detected but adaptive skip says skip OD this frame
                        now_t = time.monotonic()
                        if now_t - self._last_live_write >= self.min_interval:
                            f = cpu_frame if cpu_frame is not None else gpu_frame.download()
                            self._write_live(cv2.cvtColor(f, cv2.COLOR_RGB2BGR))
                            self._last_live_write = now_t
                        continue

                    if force:
                        self.last_force = now
                        # Treat forced frame as a new motion burst so next frames run OD eagerly
                        _adaptive_skip.reset(self.camera_name)

                    # Download to CPU once — only when the frame actually goes to OD
                    frame = cpu_frame if cpu_frame is not None else gpu_frame.download()

                    # Non-blocking put — if queue is full, drop the oldest frame and insert the new one
                    # This ensures the pipeline thread never stalls waiting for BatchWorker
                    try:
                        self.frame_queue.put_nowait((frame_id, frame, ts))
                    except _queue.Full:
                        try:
                            self.frame_queue.get_nowait()  # discard oldest stale frame
                        except _queue.Empty:
                            pass
                        self.frame_queue.put_nowait((frame_id, frame, ts))

                # Stop GLib loop first so no more bus messages dispatch while we tear down
                loop.quit()
                bus.remove_signal_watch()
                # Wait for all elements to reach NULL — prevents "dispose in PLAYING state" criticals
                pipeline.set_state(Gst.State.NULL)
                pipeline.get_state(Gst.CLOCK_TIME_NONE)

            except Exception as e:
                logger.exception(f"Pipeline session error | camera={self.camera_name}: {e}")

            if not self._stop_event.is_set():
                if rtsp_issue is not None:
                    cv2.imwrite(f"{self.live_path}/workday.jpg", rtsp_issue)
                # Reset prefilter state on reconnect so first frame after reconnect always processes
                self._prev_gpu  = None
                self.prev_frame = None
                logger.warning(f"Reconnecting in 5s | camera={self.camera_name}")
                time.sleep(5)

        logger.info(f"CameraSession thread exiting | camera={self.camera_name}")


# ──────────────────────────────────────────────────────────────────────────────
# BATCH INFERENCE SERVICE
# ──────────────────────────────────────────────────────────────────────────────

class BatchInferenceService:
    """Manages N CameraSession pipelines and one BatchWorker thread."""

    def __init__(self):
        self._lock             = threading.RLock()
        self._cameras: dict[str, CameraSession] = {}
        self._running          = True
        self._worker           = threading.Thread(target=self._batch_worker, daemon=True)
        self._live_write_times: dict[str, float] = {}

    def start(self):
        """Spawn the BatchWorker thread.  Call exactly once after construction."""
        self._worker.start()
        logger.info("BatchInferenceService started")

    def reload(self):
        """Re-read rtsplinks.json and start/stop camera sessions to match."""
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"reload: cannot read rtsplinks.json: {e}")
            return

        desired = {
            info["cam_name"]: {
                "rtsp_url": rtsp_url,
                "rtsp_id":  str(info.get("rtsp_id", info["cam_name"])),
            }
            for rtsp_url, info in data.items()
            if info.get("running_status") and info.get("cam_name")
            and int(info.get("batch_id", 1)) == BATCH_ID
        }

        with self._lock:
            current = set(self._cameras.keys())
            wanted  = set(desired.keys())

            for cam in current - wanted:
                self._cameras[cam].stop()
                del self._cameras[cam]
                logger.info(f"Camera removed | camera={cam}")

            for cam in wanted:
                cam_data   = desired[cam]
                new_cfg    = fetch_camera_config(cam)
                new_fps    = float(new_cfg.get("FPS", 1.0))
                new_rtsp   = cam_data["rtsp_url"]
                new_width  = int(new_cfg.get("Output_Width",  640))
                new_height = int(new_cfg.get("Output_Height", 360))
                new_ssim   = float(new_cfg.get("SSIM_Thresh", 0.95))
                new_codec  = new_cfg.get("RTSP_Codec", "h264")

                if cam in self._cameras:
                    existing = self._cameras[cam]
                    if (existing.target_fps   == new_fps    and existing.rtsp_url == new_rtsp
                            and existing.width     == new_width and existing.height    == new_height
                            and existing.ssim_thresh == new_ssim and existing.codec    == new_codec):
                        continue  # no change — keep running
                    logger.info(
                        f"Camera config changed — restarting | camera={cam} "
                        f"| fps {existing.target_fps}→{new_fps}"
                    )
                    existing.stop()
                    del self._cameras[cam]

                sess = CameraSession(cam, new_rtsp, new_cfg, rtsp_id=cam_data["rtsp_id"])
                sess.start()
                self._cameras[cam] = sess
                logger.info(f"Camera added | camera={cam} | fps={new_fps} | rtsp={new_rtsp}")

        logger.info(f"Reload complete | active={list(self._cameras.keys())}")

    def _batch_worker(self):
        timeout = BATCH_TIMEOUT_MS / 1000.0
        logger.info(f"BatchWorker started | timeout={BATCH_TIMEOUT_MS}ms")

        while self._running:
            # Set a deadline so we don't wait forever if some cameras have no frames ready
            deadline  = time.monotonic() + timeout
            collected: list[tuple] = []

            # Snapshot the active sessions under lock to avoid holding lock during queue waits
            with self._lock:
                sessions = list(self._cameras.values())

            # Try to pull one frame from each active camera within the deadline window
            for sess in sessions:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break  # deadline expired — run the batch with whatever was collected
                try:
                    frame_id, frame, ts = sess.frame_queue.get(timeout=max(remaining, 0.005))
                    collected.append((sess.camera_name, frame_id, frame, ts, sess.min_interval))
                except _queue.Empty:
                    pass  # camera had no frame ready this cycle — skip it

            if not collected:
                # No frames available: if no sessions exist, sleep briefly to avoid busy-loop
                if not sessions:
                    time.sleep(0.05)
                continue

            # Extract just the pixel arrays for inference
            frames = [c[2] for c in collected]
            t0 = time.monotonic()
            try:
                # Run all N frames through YOLOv10 in a single GPU call (or sequential if static model)
                batch_results = batch_object_detection(frames, ort_session, class_names, colors)
            except Exception as e:
                logger.error(f"Batch inference failed: {e}")
                continue

            logger.info(
                f"Batch inference | cameras={[c[0] for c in collected]} "
                f"| batch_size={len(frames)} | ms={(time.monotonic()-t0)*1000:.1f}"
            )

            # Publish results to Kafka and update live thumbnails per camera
            for (cam_name, frame_id, frame, ts, cam_min_interval), results in zip(collected, batch_results):
                try:
                    bgr        = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    jpeg_bytes = _encode_jpeg(bgr)

                    # Kafka payload: JPEG frame + OD results, consumed by the results processor
                    payload = {
                        'frame_id':                 frame_id,
                        'frame_bytes':              base64.b64encode(jpeg_bytes).decode('utf-8'),
                        'object_detection_results': results,
                    }
                    # Kafka headers allow consumers to route/filter without deserialising the body
                    headers = [
                        ('frame_id',      frame_id.encode('utf-8')),
                        ('timestamp_str', ts.isoformat().encode('utf-8')),
                        ('camera_name',   cam_name.encode('utf-8')),
                        ('content-type',  b'image/jpeg'),
                    ]
                    producer.send(OUTPUT_TOPIC, value=payload,
                                  key=frame_id.encode('utf-8'), headers=headers)
                    logger.info(
                        f"[FRAME SENT] frame_id={frame_id} | camera={cam_name} | objects={len(results)}")

                    if PUBLISH_RAW_FRAME:
                        # Raw frame topic feeds the anomaly detection pipeline (no OD results)
                        raw_payload = {
                            "frame_id":    frame_id,
                            "camera_name": cam_name,
                            "timestamp":   ts.isoformat(),
                            "frame_bytes": base64.b64encode(jpeg_bytes).decode('utf-8'),
                        }
                        raw_headers = [
                            ('frame_id',          frame_id.encode('utf-8')),
                            ('timestamp_str',     ts.isoformat().encode('utf-8')),
                            ('camera_name',       cam_name.encode('utf-8')),
                            ('content-type',      b'image/jpeg'),
                            ('anomaly_detection', b'False'),  # signal to consumer: no AD done yet
                        ]
                        producer.send(RAW_FRAME_TOPIC, value=raw_payload,
                                      key=frame_id.encode('utf-8'), headers=raw_headers)
                        logger.info(f"[RAW FRAME SENT] frame_id={frame_id} | camera={cam_name}")

                    live  = os.path.join(AKSHA_PATH, cam_name, "live")
                    now_t = time.monotonic()
                    # Throttle live thumbnail writes to camera FPS — bgr already computed above
                    if now_t - self._live_write_times.get(cam_name, 0.0) >= cam_min_interval:
                        data = _encode_jpeg(bgr)
                        for name in ("workday", "holiday"):
                            with open(f"{live}/{name}.jpg", "wb") as f:
                                f.write(data)
                            publish_live_image(live, cam_name, name)
                        self._live_write_times[cam_name] = now_t

                except Exception as e:
                    logger.error(f"Publish failed | camera={cam_name} | frame_id={frame_id}: {e}")

    def cameras_status(self) -> dict:
        """Return a {cam_name: {rtsp, fps}} snapshot for all currently active sessions."""
        with self._lock:
            return {cam: {"rtsp": s.rtsp_url, "fps": s.target_fps}
                    for cam, s in self._cameras.items()}


# ──────────────────────────────────────────────────────────────────────────────
# FASTAPI
# ──────────────────────────────────────────────────────────────────────────────

app     = FastAPI()
service = BatchInferenceService()

@app.on_event("startup")
def on_startup():
    service.start()
    service.reload()
    logger.info("FastAPI startup complete")

@app.post("/reload")
def reload():
    """Re-read rtsplinks.json and reconcile running camera sessions (add/remove/restart)."""
    service.reload()
    return {"ok": True, "active_cameras": list(service.cameras_status().keys())}

@app.get("/health")
def health():
    """Liveness probe — returns batch_id and current camera status."""
    return {"ok": True, "batch_id": BATCH_ID, "cameras": service.cameras_status()}

@app.get("/cameras")
def cameras():
    """List active cameras and their RTSP URL + target FPS."""
    return {"batch_id": BATCH_ID, "cameras": service.cameras_status()}


# ──────────────────────────────────────────────────────────────────────────────
# ENTRYPOINT
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(os.path.join(AKSHA_PATH, "log"), exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DS_POD_PORT", 8080)))
