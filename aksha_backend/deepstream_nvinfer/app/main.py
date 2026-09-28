"""
deepstream_nvinfer — DeepStream 8.0 + NvInfer TRT FP16 pipeline (rebuild-on-reload).

Architecture (same pattern as deepstream_batch_optimized)
=========================================================
Per camera (all built at once, pipeline rebuilt on each reload):
  nvurisrcbin → tee
    ├─ Branch A: queue(leaky) → nvstreammux → nvinfer(TRT FP16) → fakesink
    │                              ↑ pad probe: tensor metadata → detections
    └─ Branch B: queue(leaky) → nvvideoconvert → capsfilter(RGBA,WxH) → appsink_N
                   ↑ per-camera pull thread: motion gate → JPEG → Kafka

POST /reload: stop old pipeline, RTSP-check, build fresh pipeline, start.
GET  /health: 503 while TRT engine compiling, 200 once ready.
"""

import faulthandler
faulthandler.enable()

import concurrent.futures
from urllib.parse import urlparse

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

import pyds
import ctypes
import threading
import time
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

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from typing import Optional
from pydantic import BaseModel
import uvicorn
from kafka import KafkaProducer
from object_detection import get_labels

try:
    from turbojpeg import TurboJPEG as _TurboJPEG
    _turbo = _TurboJPEG()
    _HAS_TURBO = True
except ImportError:
    _turbo = None
    _HAS_TURBO = False

Gst.init(None)

try:
    _HAS_CUDA_CV = cv2.cuda.getCudaEnabledDeviceCount() > 0
except (cv2.error, AttributeError):
    _HAS_CUDA_CV = False

# ─────────────────────────────────────────────────────────────────────────────
# ENV
# ─────────────────────────────────────────────────────────────────────────────

KAFKA_SERVER       = os.environ.get("KAFKA_BOOTSTRAP_SERVERS",
                         "broker:9092" if os.path.exists("/.dockerenv") else "localhost:9092")
MONGODB_URI        = os.environ.get("MONGODB_URI",      "mongodb://localhost:27017")
AKSHA_PATH         = os.environ.get("AKSHA_PATH",       "/Aksha")
# k8s Service names can't contain underscores (DNS-1035 label) — the Compose service
# "node_backend" is exposed as "node-backend" when this stack runs on Kubernetes.
DEPLOYMENT_PLATFORM = os.environ.get("DEPLOYMENT_PLATFORM", "docker").strip().lower()
NODE_BACKEND_HOST   = "node-backend" if DEPLOYMENT_PLATFORM == "kubernetes" else "node_backend"
OUTPUT_TOPIC       = "object_detection_results"
RAW_FRAME_TOPIC    = "raw_frame"
PUBLISH_LIVE_IMAGE  = os.environ.get("PUBLISH_LIVE_IMAGE",  "true").lower()  == "true"
PUBLISH_RAW_FRAME   = os.environ.get("PUBLISH_RAW_FRAME",   "false").lower() == "true"
BATCH_ID           = int(os.environ.get("BATCH_ID", 1))

# nvstreammux: max cameras this instance will ever handle (sets TRT engine batch dim)
MAX_CAMERAS        = int(os.environ.get("MAX_CAMERAS", 10))

# nvstreammux push timeout in microseconds (env var in ms)
BATCH_TIMEOUT_US   = int(os.environ.get("BATCH_TIMEOUT_MS", 300)) * 1000

CONF_THRESHOLD        = float(os.environ.get("CONF_THRESHOLD",      0.35))
ADAPTIVE_SKIP_RATIO   = int(os.environ.get("ADAPTIVE_SKIP_RATIO",   2))
ADAPTIVE_BURST_FRAMES = int(os.environ.get("ADAPTIVE_BURST_FRAMES", 3))
SOURCE_FPS            = int(os.environ.get("SOURCE_FPS",            25))
INFER_INTERVAL        = int(os.environ.get("INFER_INTERVAL",        0))

NETWORK_W      = 640
NETWORK_H      = 640
FORCE_INTERVAL = 10.0
_PULL_TIMEOUT_NS = 10_000_000   # 10 ms — avoids busy-poll, negligible latency at ≤25fps
# If every camera is still stalled this long after the stall-monitor first noticed
# (despite in-process restart attempts), assume the GStreamer/NVDEC teardown is
# wedged and self-exit so the container's `restart: always` policy forces a clean restart.
_HARD_RESTART_ESCALATION_TIMEOUT = 240.0

_app_dir        = os.path.dirname(__file__)
_names_path     = os.path.join(_app_dir, "coco.names")
DS_CONFIG_PATH  = os.path.join(_app_dir, "ds_config", "config_infer_primary_yolov10.txt")
# DS 8.0 auto-generates engine filename from ONNX name — must match model-engine-file in config
TRT_ENGINE_PATH = os.path.join(AKSHA_PATH, "trt_cache", "yolov10.onnx_b10_gpu0_fp16.engine")
_LOADING_IMG    = os.path.join(_app_dir, "LOADING_IMG.png")
_RTSP_ISSUE_IMG = os.path.join(_app_dir, "RTSP_ISSUE_IMG.png")

_ONNX_SRC  = os.path.join(_app_dir, "yolov10.onnx")
_ONNX_DEST = os.path.join(AKSHA_PATH, "trt_cache", "yolov10.onnx")
os.makedirs(os.path.join(AKSHA_PATH, "trt_cache"), exist_ok=True)
if not os.path.exists(_ONNX_DEST):
    shutil.copy2(_ONNX_SRC, _ONNX_DEST)

with open(_names_path) as f:
    class_names = [l.strip() for l in f]

# ─────────────────────────────────────────────────────────────────────────────
# LOGGER
# ─────────────────────────────────────────────────────────────────────────────

_hostname = socket.gethostname()
_log_path = os.path.join(AKSHA_PATH, "log")
os.makedirs(_log_path, exist_ok=True)

def _make_logger():
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    h   = logging.handlers.TimedRotatingFileHandler(
        filename=f"{_log_path}/deepstream_nvinfer_{_hostname}_b{BATCH_ID}.log",
        when='midnight', interval=1, backupCount=30, encoding='utf-8')
    def _rot(src, dst):
        with open(src, 'rb') as fi, gzip.open(dst, 'wb') as fo:
            shutil.copyfileobj(fi, fo)
        os.remove(src)
    h.rotator = _rot
    h.namer   = lambda n: n + ".gz"
    h.setFormatter(fmt)
    log = logging.getLogger(f"ds_nvinfer_{_hostname}_b{BATCH_ID}")
    log.setLevel(logging.INFO)
    log.propagate = False
    if not log.handlers:
        log.addHandler(h)
    return log

logger = _make_logger()
logger.info(
    f"DeepStream NvInfer starting | kafka={KAFKA_SERVER} | "
    f"batch_id={BATCH_ID} | max_cameras={MAX_CAMERAS} | "
    f"cuda_cv={_HAS_CUDA_CV} | turbo={_HAS_TURBO}"
)

# ─────────────────────────────────────────────────────────────────────────────
# JPEG ENCODER
# ─────────────────────────────────────────────────────────────────────────────

def _encode_jpeg(frame_bgr, quality=75):
    if _HAS_TURBO:
        try:
            return _turbo.encode(frame_bgr, quality=quality)
        except Exception:
            pass
    _, buf = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()

# ─────────────────────────────────────────────────────────────────────────────
# ADAPTIVE FRAME SKIP
# ─────────────────────────────────────────────────────────────────────────────

class _AdaptiveSkip:
    def __init__(self, skip_ratio=2, burst_frames=3):
        self._skip_ratio   = skip_ratio
        self._burst_frames = burst_frames
        self._streak:  dict[str, int] = {}
        self._counter: dict[str, int] = {}
        self._lock = threading.Lock()

    def should_run_od(self, camera_name, motion) -> bool:
        with self._lock:
            if not motion:
                self._streak[camera_name]  = 0
                self._counter[camera_name] = 0
                return False
            streak = self._streak.get(camera_name, 0) + 1
            self._streak[camera_name] = streak
            if streak <= self._burst_frames:
                return True
            count = self._counter.get(camera_name, 0) + 1
            self._counter[camera_name] = count
            return (count % self._skip_ratio) == 0

_adaptive_skip = _AdaptiveSkip(ADAPTIVE_SKIP_RATIO, ADAPTIVE_BURST_FRAMES)

# ─────────────────────────────────────────────────────────────────────────────
# LIVE IMAGE PUBLISHER
# ─────────────────────────────────────────────────────────────────────────────

class _LivePublisher:
    def __init__(self):
        self._pending: dict[str, tuple] = {}
        self._lock  = threading.Lock()
        self._event = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, path, camera_name, image_type):
        if not PUBLISH_LIVE_IMAGE:
            return
        with self._lock:
            self._pending[f"{camera_name}:{image_type}"] = (path, camera_name, image_type)
        self._event.set()

    def _run(self):
        while True:
            self._event.wait()
            self._event.clear()
            with self._lock:
                batch = list(self._pending.values())
                self._pending.clear()
            for path, camera_name, image_type in batch:
                try:
                    data = {"camera_name": camera_name,
                            "timestamp":   dt.datetime.now().replace(microsecond=0),
                            "image_type":  image_type}
                    with open(f"{path}/{image_type}.jpg", "rb") as fh:
                        requests.post(f"http://{NODE_BACKEND_HOST}:5000/api/monitor/",
                                      files={"image": fh}, data=data, timeout=(1.0, 1.0))
                except Exception as e:
                    logger.debug(f"live_image error | camera={camera_name}: {e}")

_live_publisher = _LivePublisher()

# ─────────────────────────────────────────────────────────────────────────────
# KAFKA PRODUCER
# ─────────────────────────────────────────────────────────────────────────────

producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    linger_ms=50,
    batch_size=131072,
    compression_type='gzip',
    acks=1,
    value_serializer=lambda v: json.dumps(v).encode('utf-8'),
)
logger.info(f"Kafka producer ready | topic={OUTPUT_TOPIC}")

# ─────────────────────────────────────────────────────────────────────────────
# MONGODB
# ─────────────────────────────────────────────────────────────────────────────

_mongo  = pymongo.MongoClient(MONGODB_URI)
_config = _mongo["Aksha"]["config"]

def fetch_camera_config(camera_name):
    try:
        return _config.find_one({"Camera_Name": camera_name}) or {}
    except Exception as e:
        logger.warning(f"MongoDB fetch failed | camera={camera_name}: {e}")
        return {}

# ─────────────────────────────────────────────────────────────────────────────
# RTSP REACHABILITY
# ─────────────────────────────────────────────────────────────────────────────

def _rtsp_reachable(url: str, timeout: float = 3.0) -> bool:
    try:
        p = urlparse(url)
        with socket.create_connection((p.hostname, p.port or 554), timeout=timeout):
            return True
    except Exception:
        return False

# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class DeepStreamNvInferService:
    """
    Manages one shared GStreamer pipeline with N camera branches and per-camera pull workers.

    Pipeline layout per camera (built in _build_pipeline, rebuilt on each reload):
      nvurisrcbin → tee
        ├─ Branch A: queue(leaky) → nvstreammux → nvinfer(TRT FP16) → fakesink
        │                              ↑ probe: tensor metadata → _latest_detections
        └─ Branch B: queue(leaky) → nvvideoconvert(RGBA,w,h) → appsink_i
                       ↑ per-camera pull workers: motion gate → JPEG → Kafka

    Entire pipeline is rebuilt on every reload() — same as deepstream_batch_optimized.
    This avoids hot-plug race conditions (CUDA context reuse, mux pad timing, caps negotiation).
    """

    def __init__(self):
        self._lock              = threading.RLock()
        self._pipeline          = None
        self._glib_loop         = None
        self._loop_thread       = None
        self._pull_threads: list = []
        self._pull_stops:   list = []
        self._camera_map:   dict = {}   # cam_idx → info dict
        self._camera_sinks: dict = {}   # cam_idx → appsink element
        self._latest_detections: dict = {}  # source_id → detections list
        self._trt_ready: bool = False
        self._reload_lock = threading.Lock()
        self._json_lock   = threading.Lock()   # serializes rtsplinks.json writes
        self._skip_once_cameras: set = set()
        self._offline_cameras:   dict = {}  # cam_name → rtsp_url (surgically removed; recovery loop re-adds)
        self._src_404_counts:    dict = {}  # src_name → consecutive 404 warning count
        self._refreshing_cameras: set = set()  # src indices currently being refreshed (guard against double-refresh)
        self._cam_refresh_fails:  dict = {}  # cam_name → consecutive refresh failure count (for backoff)
        self._cam_retry_after:    dict = {}  # cam_name → monotonic time before which recovery skips this cam
        self._ghost_pad_indices:  set  = set()  # mux sink indices where release_request_pad() was a no-op (DS 8.0)
        self._restart_thread_active: bool = False  # guards against piling up overlapping _restart_after threads
        self._restart_started_at: Optional[float] = None  # monotonic time the current restart attempt began
        self._all_stalled_since: Optional[float] = None  # monotonic time "all cameras stalled" first observed

    # ── startup ───────────────────────────────────────────────────────────────

    def start(self):
        """Spawn background loops. Call exactly once at startup."""
        threading.Thread(target=self._startup_retry_loop, daemon=True,
                         name="ds-retry").start()
        threading.Thread(target=self._recovery_loop, daemon=True,
                         name="ds-recovery").start()
        threading.Thread(target=self._stall_monitor_loop, daemon=True,
                         name="ds-stall-monitor").start()
        logger.info("DeepStreamNvInferService started")

    def _startup_retry_loop(self):
        """Poll every 30 s and rebuild pipeline if the desired camera set has changed."""
        while True:
            time.sleep(30)
            self._maybe_reload_if_changed()

    def _desired_cameras(self):
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"Cannot read rtsplinks.json: {e}")
            return None
        return {
            info["cam_name"]: {"rtsp_url": rtsp_url,
                               "rtsp_id":  str(info.get("rtsp_id", info["cam_name"]))}
            for rtsp_url, info in data.items()
            if info.get("running_status") and info.get("cam_name")
            and int(info.get("batch_id", 1)) == BATCH_ID
        }

    def _cameras_for_batch(self):
        """All cameras for this pod's batch_id regardless of running_status.
        Used by recovery to distinguish 'disabled on this pod' from 'moved to other pod'."""
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception:
            return {}
        return {
            info["cam_name"]: {"rtsp_url": rtsp_url,
                               "rtsp_id":  str(info.get("rtsp_id", info["cam_name"]))}
            for rtsp_url, info in data.items()
            if info.get("cam_name") and int(info.get("batch_id", 1)) == BATCH_ID
        }

    def _maybe_reload_if_changed(self):
        desired = self._desired_cameras()
        if desired is None:
            return
        with self._lock:
            current = {info["cam_name"] for info in self._camera_map.values()}
            offline = set(self._offline_cameras.keys())
        # Exclude surgically-removed cameras — _recovery_loop re-adds them when RTSP recovers.
        effective_desired = set(desired) - offline
        # Cameras in BOTH camera_map AND offline are stalled and owned by the stall monitor /
        # recovery loop — don't count them as "removed" to avoid spurious reloads.
        current_active = current - offline
        if effective_desired != current_active:
            logger.info("Camera set changed — reloading pipeline")
            with self._reload_lock:
                self._do_reload()

    def reload(self):
        """Debounced reload — collapses rapid POST /reload calls into one rebuild."""
        threading.Thread(target=self._debounced_reload, daemon=True,
                         name="ds-debounce").start()

    _DEBOUNCE_S = 5.0

    def _debounced_reload(self):
        time.sleep(self._DEBOUNCE_S)
        with self._reload_lock:
            self._do_reload()

    def _do_reload(self):
        """Reconcile desired cameras with the running pipeline.

        Incremental path (pipeline already running): hot-add / hot-remove individual
        camera branches so other cameras are never interrupted.
        Full-build path (no pipeline yet): RTSP-check all, stop old pipeline, build fresh.
        """
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"reload: cannot read rtsplinks.json: {e}")
            return

        desired = {
            info["cam_name"]: {"rtsp_url": rtsp_url,
                               "rtsp_id":  str(info.get("rtsp_id", info["cam_name"]))}
            for rtsp_url, info in data.items()
            if info.get("running_status") and info.get("cam_name")
            and int(info.get("batch_id", 1)) == BATCH_ID
        }

        with self._lock:
            skip    = set(self._skip_once_cameras)
            self._skip_once_cameras.clear()
            # Do NOT clear _offline_cameras here — _recovery_loop owns that dict
            offline = set(self._offline_cameras.keys())

        if skip:
            logger.warning(f"Skipping stalled cameras this reload: {sorted(skip)}")
            for cam_name in skip:
                self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
        if offline:
            logger.info(f"Excluding offline cameras (awaiting recovery): {sorted(offline)}")

        desired = {k: v for k, v in desired.items() if k not in skip and k not in offline}

        if not desired:
            logger.info("reload: no cameras for this batch_id")
            self._stop_pipeline()
            return

        # ── INCREMENTAL PATH: pipeline already running ──────────────────────
        with self._lock:
            pipeline_running = self._pipeline is not None
            current_by_name  = {info["cam_name"]: idx
                                 for idx, info in self._camera_map.items()}

        if pipeline_running:
            current_names = set(current_by_name.keys())
            desired_names = set(desired.keys())
            to_remove = current_names - desired_names
            to_add    = desired_names - current_names

            # URL changed → counts as remove + re-add
            for cam_name in list(current_names & desired_names):
                idx = current_by_name[cam_name]
                with self._lock:
                    existing_url = self._camera_map.get(idx, {}).get("rtsp_url")
                if existing_url != desired[cam_name]["rtsp_url"]:
                    to_remove.add(cam_name)
                    to_add.add(cam_name)

            if not to_remove and not to_add:
                logger.info("Incremental reload: no changes")
                return

            if to_remove:
                # DS 8.0 nvstreammux: release_request_pad() is a no-op while PLAYING —
                # surgical removal leaves a dead mux pad that blocks hot-add forever.
                # Full restart is the only safe path when any camera must be removed.
                logger.warning(
                    f"Incremental reload: {sorted(to_remove)} need removal — "
                    f"full restart (no safe surgical removal in DS 8.0)"
                )
                # Queue the cameras being removed so recovery re-adds them after restart
                with self._lock:
                    for cam_name in to_remove:
                        if cam_name in desired:
                            self._offline_cameras.setdefault(cam_name, desired[cam_name]["rtsp_url"])
                # Fall through to full build path below — DO NOT return

            else:
                # Only additions — safe to hot-add without restarting other cameras
                logger.info(f"Incremental reload | add={sorted(to_add)}")
                with concurrent.futures.ThreadPoolExecutor(
                        max_workers=max(1, len(to_add))) as ex:
                    reach = {n: ex.submit(_rtsp_reachable, desired[n]["rtsp_url"])
                             for n in to_add}
                    reach = {n: fut.result() for n, fut in reach.items()}

                for cam_name in sorted(to_add):
                    if not reach.get(cam_name, False):
                        logger.warning(f"RTSP unreachable (hot-add) — skipping: {cam_name}")
                        self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
                        with self._lock:
                            self._offline_cameras[cam_name] = desired[cam_name]["rtsp_url"]
                        continue
                    cam_data = desired[cam_name]
                    cfg = fetch_camera_config(cam_name)
                    ok = self._add_camera_branch(
                        cam_name, cam_data["rtsp_url"], cfg, cam_data["rtsp_id"])
                    if not ok:
                        with self._lock:
                            self._offline_cameras[cam_name] = desired[cam_name]["rtsp_url"]
                        logger.warning(f"Incremental hot-add failed for {cam_name} — queued for recovery")
                return

        # ── FULL BUILD PATH: no pipeline yet ────────────────────────────────
        # Parallel TCP reachability check — skip cameras whose RTSP port is closed
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(desired))) as ex:
            reach = {name: ex.submit(_rtsp_reachable, d["rtsp_url"])
                     for name, d in desired.items()}
            reach = {name: fut.result() for name, fut in reach.items()}

        unreachable = [n for n, ok in reach.items() if not ok]
        if unreachable:
            logger.warning(f"RTSP unreachable — skipping: {unreachable}")
            for n in unreachable:
                with self._lock:
                    self._offline_cameras[n] = desired[n]["rtsp_url"]

        cameras = []
        for cam_name, cam_data in desired.items():
            if not reach[cam_name]:
                # Don't create folders for unreachable cameras — offline recovery handles it
                continue
            cfg = fetch_camera_config(cam_name)
            cameras.append((cam_name, cam_data["rtsp_url"], cfg, cam_data["rtsp_id"]))

        # Cap to MAX_CAMERAS — excess cameras are queued for hot-add by recovery loop
        if len(cameras) > MAX_CAMERAS:
            excess  = cameras[MAX_CAMERAS:]
            cameras = cameras[:MAX_CAMERAS]
            logger.warning(
                f"reload: {len(cameras) + len(excess)} reachable cameras exceeds "
                f"MAX_CAMERAS={MAX_CAMERAS} — building with {len(cameras)}, "
                f"queuing {len(excess)} for hot-add: {[c[0] for c in excess]}"
            )
            with self._lock:
                for cam_name, rtsp_url, _cfg, _rid in excess:
                    self._offline_cameras.setdefault(cam_name, rtsp_url)

        self._stop_pipeline()

        if not cameras:
            logger.info("reload: no reachable cameras")
            return

        result = self._build_pipeline(cameras)
        if result is None:
            logger.error("reload: pipeline build failed")
            return

        pipeline, camera_map, camera_sinks = result

        # DS 8.0: GLib main loop must be running BEFORE nvinfer initialises its CUDA context.
        glib_loop = GLib.MainLoop()
        _loop_ready = threading.Event()
        def _run_loop():
            GLib.idle_add(lambda: (_loop_ready.set(), False)[-1])
            glib_loop.run()
        loop_thread = threading.Thread(target=_run_loop, daemon=True, name="ds-glib")
        loop_thread.start()
        if not _loop_ready.wait(timeout=5.0):
            logger.warning("GLib main loop did not signal ready in 5 s — proceeding")

        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)

        pipeline.set_state(Gst.State.PLAYING)

        with self._lock:
            self._pipeline     = pipeline
            self._camera_map   = camera_map
            self._camera_sinks = camera_sinks
            self._latest_detections.clear()
            self._glib_loop    = glib_loop
            self._loop_thread  = loop_thread
            # Remove built cameras from offline_cameras so recovery doesn't
            # hot-add them again as duplicates while they're already in the pipeline.
            for cam_name, _, _, _ in cameras:
                self._offline_cameras.pop(cam_name, None)

        if os.path.exists(TRT_ENGINE_PATH):
            self._trt_ready = True
            logger.info(f"TRT engine on disk — ready: {TRT_ENGINE_PATH}")
        else:
            self._trt_ready = False
            threading.Thread(target=self._watch_engine_file,
                             daemon=True, name="ds-engine-watch").start()

        pull_threads, pull_stops = [], []
        for i, appsink in camera_sinks.items():
            stop_ev = threading.Event()
            t = threading.Thread(
                target=self._pull_worker_camera,
                args=(i, appsink, stop_ev),
                daemon=True,
                name=f"pull-{camera_map[i]['cam_name']}")
            t.start()
            pull_threads.append(t)
            pull_stops.append(stop_ev)
        with self._lock:
            self._pull_threads = pull_threads
            self._pull_stops   = pull_stops

        logger.info(f"Pipeline PLAYING | cameras={[c[0] for c in cameras]}")

        threading.Thread(
            target=self._post_start_stall_watchdog,
            args=(list(camera_map.keys()), pipeline),
            daemon=True, name="ds-stall-watch").start()

        threading.Thread(
            target=self._pipeline_health_watchdog,
            args=(pipeline,),
            daemon=True, name="ds-health-watch").start()

    def _pipeline_health_watchdog(self, owner_pipeline):
        """Detect pod-level freeze: if ALL cameras lose frames simultaneously it's a pipeline
        crash (GPU stall, nvinfer OOM, GLib loop died), not individual RTSP drops.
        Restart the pipeline immediately rather than waiting 90 s per camera to cascade."""
        CHECK_INTERVAL   = 15.0   # poll every 15 s
        FREEZE_THRESHOLD = 60.0   # all cameras silent for this long → pipeline frozen
        MIN_CAMERAS      = 2      # don't trigger on a single-camera pod (could be legitimate)

        time.sleep(60.0)  # give cameras time to connect on fresh build before first check
        while True:
            time.sleep(CHECK_INTERVAL)
            with self._lock:
                if self._pipeline is not owner_pipeline:
                    return  # pipeline was replaced by a restart — this watchdog is stale
                camera_map = dict(self._camera_map)
                pipeline   = self._pipeline
            if pipeline is None or len(camera_map) < MIN_CAMERAS:
                return  # pipeline stopped externally — exit this watchdog

            now = time.monotonic()
            stale = [
                info["cam_name"]
                for info in camera_map.values()
                if (now - info.get("last_frame_time", now)) > FREEZE_THRESHOLD
            ]
            if len(stale) == len(camera_map):
                logger.warning(
                    f"[HEALTH] Pipeline freeze — all {len(stale)} cameras silent "
                    f">{FREEZE_THRESHOLD:.0f}s: {sorted(stale)} — restarting pipeline")
                with self._reload_lock:
                    self._do_reload()
                return  # _do_reload starts a new watchdog thread

    def _build_pipeline(self, cameras):
        """
        Build one GStreamer pipeline containing all cameras.
        Per camera: nvurisrcbin → tee → [Branch A: queue→mux, Branch B: queue→conv→appsink]
        Returns (pipeline, camera_map, camera_sinks) or None on failure.
        """
        n        = len(cameras)
        pipeline = Gst.Pipeline.new("nvinfer-backbone")

        mux = Gst.ElementFactory.make("nvstreammux", "mux")
        if not mux:
            logger.error("nvstreammux not found — DeepStream not installed")
            return None
        mux.set_property("batch-size",           MAX_CAMERAS)  # reserve MAX_CAMERAS slots so hot-add never exceeds the pad cap
        mux.set_property("width",                NETWORK_W)
        mux.set_property("height",               NETWORK_H)
        mux.set_property("live-source",          1)
        mux.set_property("batched-push-timeout", BATCH_TIMEOUT_US)
        mux.set_property("sync-inputs",          0)
        try:
            mux.set_property("attach-sys-ts", 1)
        except Exception:
            pass
        pipeline.add(mux)

        pgie = Gst.ElementFactory.make("nvinfer", "pgie")
        if not pgie:
            logger.error("nvinfer plugin not found — check DeepStream install")
            return None
        pgie.set_property("config-file-path", DS_CONFIG_PATH)
        pgie.set_property("interval",         INFER_INTERVAL)
        pipeline.add(pgie)

        fakesink = Gst.ElementFactory.make("fakesink", "fakesink0")
        fakesink.set_property("async", False)
        pipeline.add(fakesink)

        if not mux.link(pgie):
            logger.error("LINK FAILED: mux → pgie")
            return None
        if not pgie.link(fakesink):
            logger.error("LINK FAILED: pgie → fakesink")
            return None

        pgie.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER, self._tensor_probe)

        camera_map   = {}
        camera_sinks = {}

        for i, (cam_name, rtsp_url, config, rtsp_id) in enumerate(cameras):
            orig_w      = int(config.get("Output_Width",  640))
            orig_h      = int(config.get("Output_Height", 360))
            fps         = float(config.get("FPS", 5.0))
            ssim_thresh = float(config.get("SSIM_Thresh", 0.95))

            src   = Gst.ElementFactory.make("nvurisrcbin",    f"src{i}")
            tee   = Gst.ElementFactory.make("tee",            f"tee{i}")
            q_a   = Gst.ElementFactory.make("queue",          f"qa{i}")
            q_b   = Gst.ElementFactory.make("queue",          f"qb{i}")
            conv  = Gst.ElementFactory.make("nvvideoconvert", f"conv{i}")
            cfilt = Gst.ElementFactory.make("capsfilter",     f"cf{i}")
            asink = Gst.ElementFactory.make("appsink",        f"asink{i}")

            if not all([src, tee, q_a, q_b, conv, cfilt, asink]):
                logger.error(f"Failed to create GStreamer elements for camera {cam_name}")
                return None

            # Create folders only once we know this camera is actually going into the pipeline
            for sub in ("live", "spotlight", "alerts", "frame"):
                os.makedirs(os.path.join(AKSHA_PATH, cam_name, sub), exist_ok=True)
            os.makedirs(os.path.join(AKSHA_PATH, "Reference_images"), exist_ok=True)

            src.set_property("uri",    rtsp_url)
            src.set_property("gpu-id", 0)
            try:
                src.set_property("rtsp-reconnect-interval", 5)
            except Exception:
                pass
            # Force TCP via deep-element-added — fires when nvurisrcbin adds its
            # internal rtspsrc child. UDP RTP packet loss → NVDEC corrupted H.264
            # → 0 frames even when ffplay (software decode) works fine.
            def _on_deep_element_added_build(_bin, _sub_bin, element):
                factory = element.get_factory()
                if factory and factory.get_name() == "rtspsrc":
                    try:
                        element.set_property("protocols", 4)   # GST_RTSP_LOWER_TRANS_TCP
                        element.set_property("latency", 200)
                        logger.info(f"TCP forced via deep-element-added | camera={cam_name}")
                    except Exception as e:
                        logger.warning(f"deep-element-added TCP force failed | camera={cam_name}: {e}")
            src.connect("deep-element-added", _on_deep_element_added_build)

            src_fps = int(config.get("Source_FPS", SOURCE_FPS))
            if src_fps > fps:
                drop_iv = max(1, round(src_fps / fps))
                try:
                    src.set_property("drop-frame-interval", drop_iv)
                    logger.info(f"HW frame skip | camera={cam_name} | "
                                f"{src_fps}fps → {fps}fps drop_interval={drop_iv}")
                except Exception:
                    pass

            for q in (q_a, q_b):
                q.set_property("max-size-buffers", 1)
                q.set_property("leaky",            2)
                q.set_property("max-size-time",    0)
                q.set_property("max-size-bytes",   0)

            cfilt.set_property("caps", Gst.Caps.from_string(
                f"video/x-raw,format=RGBA,width={orig_w},height={orig_h}"))

            asink.set_property("emit-signals", False)
            asink.set_property("sync",         False)
            asink.set_property("max-buffers",  1)
            asink.set_property("drop",         True)

            for el in [src, tee, q_a, q_b, conv, cfilt, asink]:
                pipeline.add(el)

            try:
                mux_pad = mux.request_pad_simple(f"sink_{i}")
            except AttributeError:
                mux_pad = mux.get_request_pad(f"sink_{i}")
            if not mux_pad:
                logger.error(f"Failed to get mux pad sink_{i} | camera={cam_name}")
                return None

            _rps  = getattr(tee, "request_pad_simple", tee.get_request_pad)
            tee_a = _rps("src_%u")
            tee_a.link(q_a.get_static_pad("sink"))
            q_a.get_static_pad("src").link(mux_pad)

            tee_b = _rps("src_%u")
            tee_b.link(q_b.get_static_pad("sink"))
            q_b.link(conv)
            conv.link(cfilt)
            cfilt.link(asink)

            # pad-added: no caps check — pad may be unnegotiated when signal fires in DS 8.0
            def _on_pad_added(element, pad, _tee=tee, _i=i, _cam=cam_name):
                tee_sink = _tee.get_static_pad("sink")
                if tee_sink.is_linked():
                    return
                result = pad.link(tee_sink)
                if result == Gst.PadLinkReturn.OK:
                    with self._lock:
                        if _i in self._camera_map:
                            self._camera_map[_i]["pad_linked"] = True
                    logger.info(f"Source pad linked | camera={_cam} idx={_i}")
                else:
                    logger.error(f"Source pad link failed (code={result}) | camera={_cam} idx={_i}")

            src.connect("pad-added", _on_pad_added)

            camera_map[i] = {
                "cam_name":        cam_name,
                "rtsp_id":         rtsp_id,
                "rtsp_url":        rtsp_url,
                "src_name":        f"src{i}",
                "mux_pad":         mux_pad,
                "orig_w":          orig_w,
                "orig_h":          orig_h,
                "fps":             fps,
                "min_interval":    1.0 / max(fps, 0.1),
                "ssim_thresh":     ssim_thresh,
                "last_proc":       0.0,
                "last_force":      0.0,
                "pad_linked":      False,
                "last_frame_time": time.monotonic(),
            }
            camera_sinks[i] = asink
            logger.info(f"Camera queued | id={i} name={cam_name} fps={fps} {orig_w}×{orig_h}")

        return pipeline, camera_map, camera_sinks

    def _stop_pipeline(self):
        """Stop pull workers, set pipeline to NULL, clear all state."""
        for stop_ev in self._pull_stops:
            stop_ev.set()
        for t in self._pull_threads:
            t.join(timeout=3.0)
        self._pull_stops   = []
        self._pull_threads = []

        if self._pipeline:
            self._pipeline.set_state(Gst.State.NULL)
            self._pipeline.get_state(8 * Gst.SECOND)  # bounded — never blocks forever on stuck nvurisrcbin
            self._pipeline = None
            logger.info("Pipeline stopped")

        if self._glib_loop and self._glib_loop.is_running():
            self._glib_loop.quit()
        self._glib_loop   = None
        self._loop_thread = None

        with self._lock:
            self._camera_map.clear()
            self._camera_sinks.clear()
            self._latest_detections.clear()
            self._trt_ready = False
        self._src_404_counts.clear()
        # NOTE: _cam_refresh_fails / _cam_retry_after are per-camera recovery backoff
        # state, independent of the GStreamer pipeline's lifecycle — do NOT clear them
        # here. _restart_after() sets backoff for stuck cameras right before calling
        # this method; clearing it here erased that backoff on every restart, making
        # the recovery loop treat every camera as immediately retryable and causing
        # an infinite 60s stall-restart loop instead of the intended 2→10 min backoff.
        self._ghost_pad_indices.clear()

    def _post_start_stall_watchdog(self, expected_ids, owner_pipeline):
        """30 s after start: cameras that never linked their source pad are excluded.
        pad_linked=True means nvurisrcbin established the RTSP session — frames will
        follow once the decoder warms up. Only kill cameras that are completely stuck
        (pad never linked = NVR truly unreachable or auth failed at startup)."""
        time.sleep(30)
        with self._lock:
            if self._pipeline is not owner_pipeline:
                return  # pipeline was replaced by a restart — this watchdog is stale
        with self._lock:
            stuck = [
                (i, self._camera_map[i]["cam_name"],
                 self._camera_map[i].get("rtsp_url", ""))
                for i in expected_ids
                if i in self._camera_map and not self._camera_map[i].get("pad_linked", False)
            ]
        if not stuck:
            return
        logger.warning(f"[STALL-WD] Stuck cameras at startup — restarting pipeline without them: "
                       f"{[n for _, n, _ in stuck]}")
        with self._lock:
            for _, cam_name, rtsp_url in stuck:
                # Pre-populate so _restart_after → _do_reload excludes them,
                # and recovery loop re-adds them once RTSP is reachable.
                self._skip_once_cameras.add(cam_name)
                self._offline_cameras[cam_name] = rtsp_url
        threading.Thread(target=self._restart_after, args=(5,),
                         daemon=True, name="ds-post-stall-restart").start()

    def _on_bus_message(self, bus, msg):
        if msg.type == Gst.MessageType.WARNING:
            err, dbg = msg.parse_warning()
            src_name = msg.src.get_name() if msg.src else "unknown"
            # 404 warnings come from the inner GstRTSPSrc element named "src" (inside
            # GstDsNvUriSrcBin:src0/src1/...). Walk up to the bin so we get "src0" etc.
            if src_name == "src" and msg.src and msg.src.get_parent():
                bin_name = msg.src.get_parent().get_name()
                if bin_name and bin_name.startswith("src"):
                    src_name = bin_name
            logger.warning(f"GStreamer WARNING | src={src_name} | {err.message} | debug={dbg}")

            # Detect consecutive 404s from an RTSP source. nvurisrcbin retries the same
            # TCP connection which the NVR keeps rejecting. Threshold is 10 (~50 s) to
            # tolerate transient NVR connection-limit overload — fewer than 10 consecutive
            # 404s are treated as self-recovering NVR hiccups, not camera failures.
            if src_name.startswith("src") and "not found" in (err.message or "").lower():
                count = self._src_404_counts.get(src_name, 0) + 1
                self._src_404_counts[src_name] = count
                if count >= 10:
                    self._src_404_counts.pop(src_name, None)
                    try:
                        src_idx = int(src_name[3:])
                    except ValueError:
                        src_idx = None
                    with self._lock:
                        info     = self._camera_map.get(src_idx, {}) if src_idx is not None else {}
                        cam_name = info.get("cam_name", src_name)
                        rtsp_url = info.get("rtsp_url", "")
                        fps      = float(info.get("fps",    5.0))
                        orig_w   = int(info.get("width",  640))
                        orig_h   = int(info.get("height", 360))
                        rtsp_id  = info.get("rtsp_id",  "0")
                    if src_idx is not None and cam_name != src_name:
                        logger.warning(
                            f"[RTSP 404] {count} consecutive 404s — refreshing source for fresh "
                            f"TCP connection | camera={cam_name} url={rtsp_url}"
                        )
                        cfg = {"FPS": fps, "Output_Width": orig_w, "Output_Height": orig_h}
                        threading.Thread(
                            target=self._refresh_camera_source,
                            args=(src_idx, cam_name, rtsp_url, cfg, rtsp_id),
                            daemon=True, name=f"ds-404-refresh-{src_idx}"
                        ).start()
            # No elif reset here — TCP-level warnings ("Could not read/write to resource")
            # also come from src0/src1 and must NOT reset the 404 counter. The counter
            # resets only on: (1) frame received (_pull_worker_camera) or (2) pipeline stop.
        elif msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            src_name = msg.src.get_name() if msg.src else "unknown"
            if src_name.startswith("src"):
                # Fatal source error (auth failure, codec unsupported, etc.) — nvurisrcbin
                # cannot recover on its own. Surgically remove this camera branch; the
                # recovery loop will re-add it when RTSP becomes reachable again.
                # Note: transient RTSP drops are handled by nvurisrcbin's internal retry
                # (rtsp-reconnect-interval=5, unlimited attempts) and never reach here.
                try:
                    src_idx = int(src_name[3:])
                except ValueError:
                    src_idx = None
                with self._lock:
                    info     = self._camera_map.get(src_idx, {}) if src_idx is not None else {}
                    cam_name = info.get("cam_name", src_name)
                    rtsp_url = info.get("rtsp_url", "")
                logger.warning(
                    f"[RTSP FAIL] Fatal source error | camera={cam_name} src={src_name} "
                    f"url={rtsp_url} | reason={err.message} | debug={dbg}"
                )
                if src_idx is not None and cam_name != src_name:
                    # DS 8.0: release_request_pad() is a no-op while PLAYING — the mux
                    # sink pad for this slot is ghost-padded. Blacklist the slot so
                    # _next_src_idx() skips it; recovery will hot-add on a fresh slot.
                    with self._lock:
                        self._camera_map.pop(src_idx, None)
                        self._ghost_pad_indices.add(src_idx)
                        self._offline_cameras[cam_name] = rtsp_url
                return True
            logger.error(f"Fatal pipeline ERROR | src={src_name} | {err.message} | debug={dbg}")
            for info in self._camera_map.values():
                self._write_status_image(info["cam_name"], _RTSP_ISSUE_IMG)
            if self._glib_loop:
                self._glib_loop.quit()
            threading.Thread(target=self._restart_after, args=(20,),
                             daemon=True, name="ds-restart").start()
        elif msg.type == Gst.MessageType.EOS:
            logger.warning("Pipeline EOS — restarting in 20 s")
            if self._glib_loop:
                self._glib_loop.quit()
            threading.Thread(target=self._restart_after, args=(20,),
                             daemon=True, name="ds-restart").start()
        return True

    # How long without frames before a camera is considered stuck and skipped on restart.
    _STUCK_CAMERA_TIMEOUT = 60.0

    def _restart_after(self, delay: int = 20):
        """Sleep delay seconds then stop and do a fresh reload.
        20 s delay is intentional — CUDA contexts from nvinfer take ~10-15 s to fully
        release after pipeline NULL. Restarting too soon causes cudaErrorMemoryAllocation.

        Cameras that have not produced a frame in _STUCK_CAMERA_TIMEOUT seconds are
        automatically added to _skip_once_cameras so the reload excludes them — this
        prevents one broken stream from causing an infinite restart loop.
        """
        # Flag stays set for the whole attempt (including the delay sleep below) so
        # _stall_monitor_loop doesn't spawn an overlapping restart thread that would
        # pile up behind this one on _reload_lock if this attempt hangs.
        with self._lock:
            self._restart_thread_active = True
        try:
            time.sleep(delay)
            # Hold _reload_lock for the ENTIRE restart so _startup_retry_loop cannot
            # race in and do a surgical incremental remove while we are stopping.
            with self._reload_lock:
                now = time.monotonic()
                with self._lock:
                    stuck = [
                        (info["cam_name"], info.get("rtsp_url", ""))
                        for info in self._camera_map.values()
                        if (now - info.get("last_frame_time", now)) > self._STUCK_CAMERA_TIMEOUT
                    ]
                    if stuck:
                        stuck_names = [n for n, _ in stuck]
                        logger.warning(f"Restart: marking stuck cameras for skip: {stuck_names}")
                        self._skip_once_cameras.update(stuck_names)
                        now_bt = time.monotonic()
                        for cam_name, rtsp_url in stuck:
                            self._offline_cameras.setdefault(cam_name, rtsp_url)
                            # Exponential backoff so recovery loop doesn't immediately
                            # re-add a camera that never produces frames (NVDEC 0 frames).
                            # Without this, the recovery loop re-adds within 60s → restart
                            # loop fires again → infinite 60s cycle.
                            fails = self._cam_refresh_fails.get(cam_name, 0) + 1
                            self._cam_refresh_fails[cam_name] = fails
                            backoff = min(600, 120 * (2 ** (fails - 1)))  # 2→4→8→10 min
                            self._cam_retry_after[cam_name] = now_bt + backoff
                            logger.warning(
                                f"Restart: stuck camera {cam_name} — "
                                f"recovery backoff {backoff}s (attempt #{fails})"
                            )
                    cam_names = [info["cam_name"] for info in self._camera_map.values()]
                logger.info("Restarting pipeline after error/EOS")
                # Only one thread can ever be inside this _reload_lock block at a time,
                # so this can't be clobbered by an overlapping restart attempt — it
                # marks the start of the actual risky window (_stop_pipeline's
                # get_state() is where a wedged teardown would hang) for the
                # wedged-restart watchdog in _stall_monitor_loop.
                with self._lock:
                    self._restart_started_at = time.monotonic()
                self._stop_pipeline()
                for cam_name in cam_names:
                    self._write_status_image(cam_name, _LOADING_IMG)
                self._do_reload()
        finally:
            with self._lock:
                self._restart_thread_active = False
                self._restart_started_at    = None

    def _tensor_probe(self, pad, info):
        """Pad probe on nvinfer src — reads tensor metadata, stores detections per source_id."""
        try:
            buf = info.get_buffer()
            if not buf:
                return Gst.PadProbeReturn.OK
            batch_meta = pyds.gst_buffer_get_nvds_batch_meta(hash(buf))
            if not batch_meta:
                return Gst.PadProbeReturn.OK
            if not self._trt_ready:
                self._trt_ready = True
                logger.info("TRT engine ready — first inference batch received")
            l_frame = batch_meta.frame_meta_list
            while l_frame is not None:
                try:
                    fm = pyds.NvDsFrameMeta.cast(l_frame.data)
                except StopIteration:
                    break
                source_id = fm.source_id
                with self._lock:
                    info_cam = self._camera_map.get(source_id, {})
                orig_w = info_cam.get("orig_w", NETWORK_W)
                orig_h = info_cam.get("orig_h", NETWORK_H)
                self._latest_detections[source_id] = self._parse_tensors(fm, orig_w, orig_h)
                try:
                    l_frame = l_frame.next
                except StopIteration:
                    break
        except Exception as e:
            logger.error(f"tensor_probe error: {e}")
        return Gst.PadProbeReturn.OK
    def _parse_tensors(self, frame_meta, orig_w, orig_h):
        """Extract YOLOv10 boxes from NvDsInferTensorMeta for one frame."""
        detections = []
        l_user = frame_meta.frame_user_meta_list
        while l_user is not None:
            try:
                user_meta = pyds.NvDsUserMeta.cast(l_user.data)
            except StopIteration:
                break
            if user_meta.base_meta.meta_type == pyds.NvDsMetaType.NVDSINFER_TENSOR_OUTPUT_META:
                try:
                    tm = pyds.NvDsInferTensorMeta.cast(user_meta.user_meta_data)
                    if tm.num_output_layers < 1:
                        raise ValueError("num_output_layers=0")
                    layer  = pyds.get_nvds_LayerInfo(tm, 0)
                    n_rows = layer.dims.d[0] if layer.dims.numDims >= 1 else 300
                    n_cols = layer.dims.d[1] if layer.dims.numDims >= 2 else 6
                    if n_rows <= 0 or n_cols <= 0:
                        raise ValueError(f"bad dims {n_rows}×{n_cols}")
                    raw_ptr = pyds.get_ptr(layer.buffer)
                    if not raw_ptr:
                        raise ValueError("null buffer")
                    ptr    = ctypes.cast(raw_ptr, ctypes.POINTER(ctypes.c_float))
                    output = np.ctypeslib.as_array(ptr, shape=(n_rows, n_cols)).copy()
                    sx = orig_w / NETWORK_W
                    sy = orig_h / NETWORK_H
                    boxes, confs, class_ids = [], [], []
                    for row in output:
                        if len(row) < 6:
                            continue
                        x0, y0, x1, y1, score, cls = (row[0], row[1], row[2],
                                                        row[3], row[4], row[5])
                        if score > CONF_THRESHOLD:
                            boxes.append([int(x0*sx), int(y0*sy),
                                          int((x1-x0)*sx), int((y1-y0)*sy)])
                            confs.append(round(float(score), 3))
                            class_ids.append(int(cls))
                    detections = get_labels(boxes, confs, class_ids, class_names)
                except Exception as e:
                    logger.error(f"tensor parse error: {e}")
            try:
                l_user = l_user.next
            except StopIteration:
                break
        return detections

    # ── per-camera pull worker ─────────────────────────────────────────────────


    def _pull_worker_camera(self, cam_idx: int, appsink, stop_ev: threading.Event):
        """One thread per camera — pulls appsink, motion gate, JPEG encode, Kafka publish."""
        prev_gray_i16        = None
        prev_gpu_gray        = None
        last_live_write      = 0.0
        cam_issue_shown      = False
        ref_date             = None
        fps_frame_count      = 0
        fps_window_start     = time.monotonic()
        RTSP_ISSUE_TIMEOUT   = 30.0
        STALL_LOG_INTERVAL   = 60.0   # re-log stall warning every 60 s while still frozen
        STALL_WARN_THRESHOLD = 300.0  # first stall warning after 5 min no frames
        FPS_LOG_INTERVAL     = 60.0   # log measured FPS every 60 s
        last_stall_warn      = 0.0

        while not stop_ev.is_set():
            with self._lock:
                info = self._camera_map.get(cam_idx)
            if not info:
                break  # camera was removed externally

            last_frame_time = info.get("last_frame_time", time.monotonic())
            now_t2 = time.monotonic()
            elapsed = now_t2 - last_frame_time

            if elapsed > STALL_WARN_THRESHOLD:
                cam_name = info.get("cam_name", str(cam_idx))
                rtsp_url = info.get("rtsp_url", "")
                pad_linked = info.get("pad_linked", False)
                cause = ("RTSP stream silent/frozen (NVDEC 0 frames)"
                         if pad_linked else
                         "pad never linked (RTSP failed at GStreamer level)")
                if now_t2 - last_stall_warn > STALL_LOG_INTERVAL:
                    logger.warning(
                        f"[STALL] No frames for {elapsed:.0f}s — waiting for nvurisrcbin to reconnect | "
                        f"camera={cam_name} url={rtsp_url} pad_linked={pad_linked} cause={cause}"
                    )
                    last_stall_warn = now_t2
                # Mark offline so recovery loop tracks it, but DO NOT restart the pipeline.
                # nvurisrcbin retries RTSP internally — if it reconnects, this worker
                # resumes automatically. Restarting here would disrupt ALL other cameras
                # every time one VPN camera drops, which is unacceptable.
                with self._lock:
                    self._offline_cameras.setdefault(cam_name, rtsp_url)
                # continue — keep worker alive so we pick up frames when stream recovers

            if elapsed > RTSP_ISSUE_TIMEOUT and not cam_issue_shown:
                cam_name   = info.get("cam_name", str(cam_idx))
                rtsp_url   = info.get("rtsp_url", "")
                pad_linked = info.get("pad_linked", False)
                self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
                cam_issue_shown = True
                logger.warning(
                    f"[RTSP ISSUE] No frames for {elapsed:.0f}s | camera={cam_name} "
                    f"url={rtsp_url} pad_linked={pad_linked} "
                    f"(stall monitor refreshes at 120s if not recovered)"
                )

            sample = appsink.emit("try-pull-sample", _PULL_TIMEOUT_NS)
            if sample is None:
                continue

            now_t = time.monotonic()
            with self._lock:
                if cam_idx in self._camera_map:
                    self._camera_map[cam_idx]["last_frame_time"] = now_t
                    # Camera is delivering frames → any prior 404s were transient reconnects,
                    # not a wrong URL. Reset so the counter starts fresh next disconnect.
                    self._src_404_counts.pop(f"src{cam_idx}", None)

            # FPS measurement — log actual decoded FPS every 60 s
            fps_frame_count += 1
            fps_elapsed = now_t - fps_window_start
            if fps_elapsed >= FPS_LOG_INTERVAL:
                with self._lock:
                    _info = self._camera_map.get(cam_idx, {})
                measured_fps  = fps_frame_count / fps_elapsed
                configured_fps = _info.get("fps", 0)
                logger.info(
                    f"[FPS] camera={_info.get('cam_name', cam_idx)} "
                    f"measured={measured_fps:.2f} configured={configured_fps:.1f}"
                )
                fps_frame_count  = 0
                fps_window_start = now_t

            if cam_issue_shown or last_stall_warn > 0.0:
                cam_name_log = info.get("cam_name", cam_idx) if info else cam_idx
                if last_stall_warn > 0.0:
                    logger.info(f"[STALL RECOVERED] Camera resumed after {elapsed:.0f}s | camera={cam_name_log}")
                    last_stall_warn = 0.0
                    with self._lock:
                        self._offline_cameras.pop(cam_name_log, None)
                cam_issue_shown = False
                logger.info(f"Camera reconnected | camera={cam_name_log}")

            with self._lock:
                info = self._camera_map.get(cam_idx)
            if not info:
                break  # pipeline stopped

            cam_name     = info["cam_name"]
            orig_w       = info["orig_w"]
            orig_h       = info["orig_h"]
            min_interval = info["min_interval"]
            ssim_thresh  = info["ssim_thresh"]
            ts           = dt.datetime.now()
            force_pub    = (now_t - info["last_force"]) >= FORCE_INTERVAL

            if (now_t - info["last_proc"]) < min_interval and not force_pub:
                continue
            info["last_proc"] = now_t

            buf    = sample.get_buffer()
            ok, mi = buf.map(Gst.MapFlags.READ)
            if not ok:
                continue
            try:
                arr        = np.frombuffer(mi.data, dtype=np.uint8)
                frame_size = orig_w * orig_h * 4
                if len(arr) < frame_size:
                    continue
                frame_rgba = arr[:frame_size].reshape(orig_h, orig_w, 4)
                frame_bgr  = cv2.cvtColor(frame_rgba, cv2.COLOR_RGBA2BGR)
                gray_u8    = cv2.cvtColor(frame_rgba, cv2.COLOR_RGBA2GRAY)
            finally:
                buf.unmap(mi)

            today = ts.date()
            if ref_date != today or (ts.hour == 9 and ts.minute == 0):
                try:
                    ref_path = os.path.join(AKSHA_PATH, "Reference_images")
                    cv2.imwrite(os.path.join(ref_path, f"{info['rtsp_id']}.jpg"), frame_bgr)
                except Exception:
                    pass
                ref_date = today

            gray_small = cv2.resize(gray_u8, (orig_w // 4, orig_h // 4),
                                    interpolation=cv2.INTER_LINEAR)
            motion = True
            if _HAS_CUDA_CV:
                gpu_cur = cv2.cuda_GpuMat()
                gpu_cur.upload(gray_small)
                if prev_gpu_gray is not None:
                    diff_gpu = cv2.cuda.absdiff(gpu_cur, prev_gpu_gray)
                    score    = cv2.cuda.norm(diff_gpu, cv2.NORM_L1) / (
                                   (orig_h // 4) * (orig_w // 4) * 255.0)
                    motion   = score >= (1.0 - ssim_thresh)
                prev_gpu_gray = gpu_cur
            else:
                gray_i16 = gray_small.astype(np.int16)
                if prev_gray_i16 is not None:
                    score  = np.abs(gray_i16 - prev_gray_i16).mean() / 255.0
                    motion = score >= (1.0 - ssim_thresh)
                prev_gray_i16 = gray_i16

            live_path      = os.path.join(AKSHA_PATH, cam_name, "live")
            live_write_due = (now_t - last_live_write) >= min_interval

            if not motion and not force_pub and not live_write_due:
                _adaptive_skip.should_run_od(cam_name, False)
                continue

            jpeg_bytes = _encode_jpeg(frame_bgr)

            if live_write_due:
                for name in ("workday", "holiday"):
                    try:
                        with open(f"{live_path}/{name}.jpg", "wb") as fh:
                            fh.write(jpeg_bytes)
                        _live_publisher.submit(live_path, cam_name, name)
                    except Exception as e:
                        logger.debug(f"live write | camera={cam_name}: {e}")
                last_live_write = now_t

            if not motion and not force_pub:
                _adaptive_skip.should_run_od(cam_name, False)
                continue

            if not _adaptive_skip.should_run_od(cam_name, motion) and not force_pub:
                continue

            if force_pub:
                info["last_force"] = now_t

            detections = self._latest_detections.get(cam_idx, [])
            frame_id   = f"{cam_name}@{ts.strftime('%H:%M:%S.%f')}"
            try:
                payload = {
                    "frame_id":                 frame_id,
                    "frame_bytes":              base64.b64encode(jpeg_bytes).decode(),
                    "object_detection_results": detections,
                }
                headers = [
                    ("frame_id",      frame_id.encode()),
                    ("timestamp_str", ts.isoformat().encode()),
                    ("camera_name",   cam_name.encode()),
                    ("content-type",  b"image/jpeg"),
                ]
                producer.send(OUTPUT_TOPIC, value=payload,
                              key=frame_id.encode(), headers=headers)
                logger.info(
                    f"[FRAME SENT] frame_id={frame_id} | camera={cam_name} | "
                    f"objects={len(detections)} | motion={motion}")

                if PUBLISH_RAW_FRAME:
                    raw_payload = {
                        "frame_id":    frame_id,
                        "camera_name": cam_name,
                        "timestamp":   ts.isoformat(),
                        "frame_bytes": base64.b64encode(jpeg_bytes).decode("utf-8"),
                    }
                    raw_headers = [
                        ("frame_id",          frame_id.encode()),
                        ("timestamp_str",     ts.isoformat().encode()),
                        ("camera_name",       cam_name.encode()),
                        ("content-type",      b"image/jpeg"),
                        ("anomaly_detection", b"False"),
                    ]
                    producer.send(RAW_FRAME_TOPIC, value=raw_payload,
                                  key=frame_id.encode(), headers=raw_headers)
                    logger.debug(f"[RAW FRAME SENT] frame_id={frame_id} | camera={cam_name}")
            except Exception as e:
                logger.error(f"Kafka publish failed | camera={cam_name}: {e}")

    def _write_status_image(self, cam_name, img_path):
        img = cv2.imread(img_path)
        if img is None:
            return
        live = os.path.join(AKSHA_PATH, cam_name, "live")
        try:
            for name in ("workday", "holiday"):
                cv2.imwrite(f"{live}/{name}.jpg", img)
        except Exception:
            pass

    def _watch_engine_file(self):
        """Poll for TRT engine file; set _trt_ready once it appears on disk."""
        while not self._trt_ready:
            if os.path.exists(TRT_ENGINE_PATH):
                self._trt_ready = True
                logger.info(f"TRT engine file detected — ready: {TRT_ENGINE_PATH}")
                return
            time.sleep(5.0)

    def cameras_status(self):
        with self._lock:
            return {
                info["cam_name"]: {
                    "fps":        info["fps"],
                    "pad_linked": info["pad_linked"],
                }
                for info in self._camera_map.values()
            }

    # ── surgical branch management ────────────────────────────────────────────

    def _next_src_idx(self) -> int:
        """Return the lowest free non-ghost camera slot (must be called with self._lock held).

        DS 8.0 release_request_pad() is a no-op while PLAYING, so removed slots stay
        ghost-padded on the mux. _ghost_pad_indices tracks those slots so we never
        re-request them — the camera gets a fresh slot instead of hitting the same ghost.
        Ghost slots are cleared on full pipeline restart (new mux, clean state).
        """
        used = set(self._camera_map.keys()) | self._ghost_pad_indices
        for i in range(MAX_CAMERAS):
            if i not in used:
                return i
        return None

    def _remove_camera_branch(self, src_idx: int):
        """Surgically remove one camera's GStreamer branch without touching others."""
        with self._lock:
            info    = self._camera_map.pop(src_idx, None)
            self._camera_sinks.pop(src_idx, None)
        if not info:
            return
        cam_name = info["cam_name"]
        mux_pad  = info.get("mux_pad")
        logger.info(f"Removing camera branch | camera={cam_name} idx={src_idx}")

        pipeline = self._pipeline
        if pipeline is None:
            return

        mux   = pipeline.get_by_name("mux")
        src   = pipeline.get_by_name(f"src{src_idx}")
        tee   = pipeline.get_by_name(f"tee{src_idx}")
        q_a   = pipeline.get_by_name(f"qa{src_idx}")
        q_b   = pipeline.get_by_name(f"qb{src_idx}")
        conv  = pipeline.get_by_name(f"conv{src_idx}")
        cfilt = pipeline.get_by_name(f"cf{src_idx}")
        asink = pipeline.get_by_name(f"asink{src_idx}")

        # 1. Stop data source first — prevents data from flowing into the mux while
        #    we're trying to release its sink pad (race that causes "pad already exists").
        if src:
            src.set_state(Gst.State.NULL)
            src.get_state(2 * Gst.SECOND)
            pipeline.remove(src)

        # 2. Stop queue_a so no buffered frames are pushed to the mux sink pad.
        if q_a:
            q_a.set_state(Gst.State.NULL)
            q_a.get_state(Gst.SECOND)

        # 3. Now safe to unlink and release the mux sink pad.
        if mux and mux_pad:
            peer = mux_pad.get_peer()
            if peer:
                peer.unlink(mux_pad)
            mux.release_request_pad(mux_pad)
            # DS 8.0: release_request_pad() is a no-op while PLAYING — sink_{src_idx}
            # stays ghost-padded on the mux forever, exactly like the fatal-error and
            # hot-add-detected-ghost paths already document. Blacklist it here too so
            # _next_src_idx() never hands this slot to another camera — without this,
            # the slot silently "looks free" (absent from both camera_map AND
            # _ghost_pad_indices) until some unrelated camera's hot-add stumbles into
            # it, fails once, and only then gets it blacklisted reactively. Cameras
            # refreshed via this surgical path (404s, stall recovery) are the common
            # case, so leaving it untracked here is how slots quietly ran out.
            with self._lock:
                self._ghost_pad_indices.add(src_idx)

        # 4. Remove remaining elements.
        for el in [tee, q_a, q_b, conv, cfilt, asink]:
            if el:
                el.set_state(Gst.State.NULL)
                el.get_state(2 * Gst.SECOND)
                pipeline.remove(el)

        self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
        logger.info(f"Camera branch removed | camera={cam_name} idx={src_idx}")

    def _remove_and_mark_offline(self, src_idx: int, cam_name: str, rtsp_url: str):
        """Called from a thread: remove branch then queue for recovery."""
        self._remove_camera_branch(src_idx)
        with self._lock:
            self._offline_cameras[cam_name] = rtsp_url
        logger.info(f"Camera offline | camera={cam_name} — recovery loop will retry in 60 s")

    def _set_rtsp_status(self, rtsp_url: str, running: bool,
                         cam_name: str = None, rtsp_id: str = None, fps: float = None):
        """Persist running_status for a camera in rtsplinks.json so pipeline restarts
        include or exclude the camera correctly without requiring the controller to re-add."""
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        with self._json_lock:
            try:
                with open(rtsp_path) as f:
                    data = json.load(f)
            except Exception:
                data = {}
            if rtsp_url in data:
                data[rtsp_url]["running_status"] = running
                if running and "batch_id" not in data[rtsp_url]:
                    data[rtsp_url]["batch_id"] = BATCH_ID
            elif running:
                data[rtsp_url] = {
                    "cam_name":      cam_name or rtsp_url,
                    "rtsp_id":       rtsp_id or "0",
                    "batch_id":      BATCH_ID,
                    "running_status": True,
                    "FPS":           fps or 5.0,
                }
            try:
                with open(rtsp_path, "w") as f:
                    json.dump(data, f, indent=4)
            except Exception as e:
                logger.error(f"Failed to update rtsplinks.json: {e}")

    def _stall_monitor_loop(self):
        """Periodically detect cameras that stopped sending frames and refresh them.

        Catches failure modes not handled by the startup stall watchdog (which only
        runs once at build time): hot-added cameras that stall, mid-stream TCP drops
        where nvurisrcbin keeps retrying internally but never recovers."""
        STALL_TIMEOUT  = 120  # seconds of silence before declaring a camera stalled
        CHECK_INTERVAL = 60
        while True:
            time.sleep(CHECK_INTERVAL)
            with self._lock:
                # Wedged-restart watchdog — independent of per-camera stall status.
                # The "all cameras stalled" escalation below never fires if even one
                # camera stays healthy while a restart thread is stuck (e.g. inside
                # _stop_pipeline()'s get_state(), which is supposed to be bounded but
                # can ignore its own timeout on a wedged NVDEC/GStreamer teardown).
                # This checks how long the CURRENT restart attempt has actually been
                # running, regardless of camera health, and self.pipeline can
                # legitimately be None during a normal restart — so this runs before
                # the pipeline-None short-circuit below, not after it.
                if self._restart_thread_active and self._restart_started_at is not None:
                    restart_elapsed = time.monotonic() - self._restart_started_at
                    if restart_elapsed > _HARD_RESTART_ESCALATION_TIMEOUT:
                        logger.critical(
                            f"[STALL-MONITOR] Restart has been running for "
                            f"{restart_elapsed:.0f}s — assuming it's wedged, "
                            f"exiting process for a clean container restart"
                        )
                        os._exit(1)
                if self._pipeline is None:
                    continue
                now   = time.monotonic()
                total = len(self._camera_map)
                stalled = [
                    (idx,
                     info.get("cam_name", ""),
                     info.get("rtsp_url", ""),
                     float(info.get("fps",    5.0)),
                     int(info.get("width",   640)),
                     int(info.get("height",  360)),
                     info.get("rtsp_id", "0"))
                    for idx, info in self._camera_map.items()
                    if now - info.get("last_frame_time", now) > STALL_TIMEOUT
                    and idx not in self._refreshing_cameras
                ]
            if not stalled:
                with self._lock:
                    self._all_stalled_since = None
                continue
            if len(stalled) >= total and total > 0:
                with self._lock:
                    if self._all_stalled_since is None:
                        self._all_stalled_since = now
                    all_stalled_elapsed = now - self._all_stalled_since
                    restart_already_running = self._restart_thread_active

                # HARD ESCALATION: a wedged NVDEC/GStreamer teardown can make
                # _stop_pipeline()'s get_state() ignore its own timeout and block
                # _reload_lock forever, silently swallowing every subsequent
                # _restart_after attempt with no further log output. If cameras
                # are STILL all-stalled this long after we first noticed, no amount
                # of retrying in-process will help — exit so `restart: always`
                # (docker/k8s) cycles the container and forces the OS to release
                # the wedged decoder session.
                if all_stalled_elapsed > _HARD_RESTART_ESCALATION_TIMEOUT:
                    logger.critical(
                        f"[STALL-MONITOR] All {total} cameras stalled for "
                        f"{all_stalled_elapsed:.0f}s despite restart attempts — "
                        f"exiting process for a clean container restart"
                    )
                    os._exit(1)

                logger.warning(
                    f"[STALL-MONITOR] All {total} cameras stalled — full restart"
                )
                if restart_already_running:
                    logger.info("[STALL-MONITOR] Restart already in progress — not spawning another")
                else:
                    threading.Thread(target=self._restart_after, args=(5,), daemon=True,
                                     name="ds-stall-restart").start()
            else:
                for idx, cam_name, rtsp_url, fps, w, h, rtsp_id in stalled:
                    logger.warning(
                        f"[STALL-MONITOR] No frames for >{STALL_TIMEOUT}s — refreshing | camera={cam_name}"
                    )
                    cfg = {"FPS": fps, "Output_Width": w, "Output_Height": h}
                    threading.Thread(
                        target=self._refresh_camera_source,
                        args=(idx, cam_name, rtsp_url, cfg, rtsp_id),
                        daemon=True, name=f"ds-stall-refresh-{idx}"
                    ).start()

    def _refresh_camera_source(self, src_idx: int, cam_name: str, rtsp_url: str,
                                cfg: dict, rtsp_id: str):
        """Refresh a stalled/404-looping camera source — creates a fresh TCP connection
        without the 60s recovery loop delay.

        Single-camera batch: stop pipeline + immediately rebuild (no offline queue).
          Total downtime: ~5s (stop + rebuild) instead of 20s EOS + 60s recovery.
        Multi-camera batch: remove branch + hot-add fresh element.
          Other cameras are never interrupted."""
        with self._lock:
            if src_idx in self._refreshing_cameras:
                return  # already being refreshed by another trigger (404 or stall monitor)
            self._refreshing_cameras.add(src_idx)
        try:
            time.sleep(2)
            with self._lock:
                pipeline  = self._pipeline
                n_cameras = len(self._camera_map)
            if pipeline is None:
                return

            if n_cameras <= 1:
                logger.info(f"[REFRESH] Single-camera batch — stop+rebuild for fresh TCP | camera={cam_name}")
                with self._reload_lock:
                    self._stop_pipeline()
                    self._do_reload()
                return

            self._remove_camera_branch(src_idx)
            time.sleep(2)
            with self._lock:
                pipeline = self._pipeline
            if pipeline is None:
                with self._lock:
                    self._offline_cameras[cam_name] = rtsp_url
                return
            ok = self._add_camera_branch(cam_name, rtsp_url, cfg, rtsp_id)
            if ok:
                logger.info(f"[REFRESH] Source refreshed with new element | camera={cam_name}")
            else:
                with self._lock:
                    self._offline_cameras[cam_name] = rtsp_url
                logger.warning(f"[REFRESH] Re-add failed — queued for recovery | camera={cam_name}")
        finally:
            with self._lock:
                self._refreshing_cameras.discard(src_idx)

    def _add_camera_branch(self, cam_name: str, rtsp_url: str, config: dict, rtsp_id: str) -> bool:
        """Hot-add one camera branch to a running pipeline without stopping others.
        Returns True if the branch was successfully added, False otherwise."""
        with self._lock:
            pipeline = self._pipeline
            if cam_name in {info["cam_name"] for info in self._camera_map.values()}:
                logger.warning(f"Hot-add skipped | camera={cam_name} already in camera_map — duplicate prevented")
                return False
            src_idx  = self._next_src_idx()

        if pipeline is None:
            logger.warning(f"Hot-add skipped | camera={cam_name} pipeline=None idx={src_idx}")
            return False

        if src_idx is None:
            with self._lock:
                occupied = {k: v.get("cam_name") for k, v in self._camera_map.items()}
            logger.warning(
                f"Hot-add skipped | camera={cam_name} pipeline=ok idx=None — "
                f"all {MAX_CAMERAS} slots claimed: {occupied} — "
                f"triggering restart to flush stale camera_map"
            )
            threading.Thread(target=self._restart_after, args=(5,), daemon=True,
                             name="ds-slots-full-restart").start()
            return False

        orig_w      = int(config.get("Output_Width",  640))
        orig_h      = int(config.get("Output_Height", 360))
        fps         = float(config.get("FPS", 5.0))
        ssim_thresh = float(config.get("SSIM_Thresh", 0.95))

        src   = Gst.ElementFactory.make("nvurisrcbin",    f"src{src_idx}")
        tee   = Gst.ElementFactory.make("tee",            f"tee{src_idx}")
        q_a   = Gst.ElementFactory.make("queue",          f"qa{src_idx}")
        q_b   = Gst.ElementFactory.make("queue",          f"qb{src_idx}")
        conv  = Gst.ElementFactory.make("nvvideoconvert", f"conv{src_idx}")
        cfilt = Gst.ElementFactory.make("capsfilter",     f"cf{src_idx}")
        asink = Gst.ElementFactory.make("appsink",        f"asink{src_idx}")

        if not all([src, tee, q_a, q_b, conv, cfilt, asink]):
            logger.error(f"Hot-add: failed to create GStreamer elements | camera={cam_name}")
            return False

        # Create folders only after confirming the camera branch will actually be built
        for sub in ("live", "spotlight", "alerts", "frame"):
            os.makedirs(os.path.join(AKSHA_PATH, cam_name, sub), exist_ok=True)
        os.makedirs(os.path.join(AKSHA_PATH, "Reference_images"), exist_ok=True)

        src.set_property("uri", rtsp_url)
        src.set_property("gpu-id", 0)
        try:
            src.set_property("rtsp-reconnect-interval", 5)
        except Exception:
            pass
        # Force TCP via deep-element-added — same as _build_pipeline.
        def _on_deep_element_added_add(_bin, _sub_bin, element):
            factory = element.get_factory()
            if factory and factory.get_name() == "rtspsrc":
                try:
                    element.set_property("protocols", 4)   # GST_RTSP_LOWER_TRANS_TCP
                    element.set_property("latency", 1000)  # 1s buffer for VPN/public net jitter
                    logger.info(f"TCP forced via deep-element-added | camera={cam_name}")
                except Exception as e:
                    logger.warning(f"deep-element-added TCP force failed | camera={cam_name}: {e}")
        src.connect("deep-element-added", _on_deep_element_added_add)

        src_fps = int(config.get("Source_FPS", SOURCE_FPS))
        if src_fps > fps:
            try:
                src.set_property("drop-frame-interval", max(1, round(src_fps / fps)))
            except Exception:
                pass

        for q in (q_a, q_b):
            q.set_property("max-size-buffers", 1)
            q.set_property("leaky",            2)
            q.set_property("max-size-time",    0)
            q.set_property("max-size-bytes",   0)

        cfilt.set_property("caps", Gst.Caps.from_string(
            f"video/x-raw,format=RGBA,width={orig_w},height={orig_h}"))
        asink.set_property("emit-signals", False)
        asink.set_property("sync",         False)
        asink.set_property("max-buffers",  1)
        asink.set_property("drop",         True)

        for el in [src, tee, q_a, q_b, conv, cfilt, asink]:
            pipeline.add(el)

        mux = pipeline.get_by_name("mux")
        try:
            mux_pad = mux.request_pad_simple(f"sink_{src_idx}")
        except AttributeError:
            mux_pad = mux.get_request_pad(f"sink_{src_idx}")
        if not mux_pad:
            # DS 8.0: release_request_pad() is a no-op while PLAYING — sink_{src_idx}
            # is ghost-padded and will never be available again. Mark the slot so
            # _next_src_idx() skips it; the next hot-add gets a fresh unused slot.
            with self._lock:
                self._ghost_pad_indices.add(src_idx)
            logger.warning(
                f"Hot-add: mux sink_{src_idx} is ghost-padded — slot blacklisted, "
                f"camera={cam_name} will retry on a fresh slot"
            )
            for el in [src, tee, q_a, q_b, conv, cfilt, asink]:
                pipeline.remove(el)
            return False

        _rps  = getattr(tee, "request_pad_simple", tee.get_request_pad)
        tee_a = _rps("src_%u")
        tee_a.link(q_a.get_static_pad("sink"))
        q_a.get_static_pad("src").link(mux_pad)

        tee_b = _rps("src_%u")
        tee_b.link(q_b.get_static_pad("sink"))
        q_b.link(conv)
        conv.link(cfilt)
        cfilt.link(asink)

        def _on_pad_added(element, pad, _tee=tee, _i=src_idx, _cam=cam_name):
            tee_sink = _tee.get_static_pad("sink")
            if tee_sink.is_linked():
                return
            result = pad.link(tee_sink)
            if result == Gst.PadLinkReturn.OK:
                with self._lock:
                    if _i in self._camera_map:
                        self._camera_map[_i]["pad_linked"] = True
                logger.info(f"Source pad linked (hot-add) | camera={_cam} idx={_i}")
            else:
                logger.error(f"Source pad link failed (hot-add, code={result}) | "
                             f"camera={_cam} idx={_i}")

        src.connect("pad-added", _on_pad_added)

        # Bring new elements to the same state as the running pipeline without stopping it
        for el in [src, tee, q_a, q_b, conv, cfilt, asink]:
            el.sync_state_with_parent()

        with self._lock:
            self._camera_map[src_idx] = {
                "cam_name":        cam_name,
                "rtsp_id":         rtsp_id,
                "rtsp_url":        rtsp_url,
                "src_name":        f"src{src_idx}",
                "mux_pad":         mux_pad,
                "orig_w":          orig_w,
                "orig_h":          orig_h,
                "fps":             fps,
                "min_interval":    1.0 / max(fps, 0.1),
                "ssim_thresh":     ssim_thresh,
                "last_proc":       0.0,
                "last_force":      0.0,
                "pad_linked":      False,
                "last_frame_time": time.monotonic(),
            }
            self._camera_sinks[src_idx] = asink

        stop_ev = threading.Event()
        t = threading.Thread(
            target=self._pull_worker_camera,
            args=(src_idx, asink, stop_ev),
            daemon=True,
            name=f"pull-{cam_name}")
        t.start()
        with self._lock:
            self._pull_threads.append(t)
            self._pull_stops.append(stop_ev)

        logger.info(f"Hot-add complete | camera={cam_name} idx={src_idx}")
        return True

    def _recovery_loop(self):
        """Poll _offline_cameras every 60 s and re-add any whose RTSP port is reachable."""
        while True:
            time.sleep(60)
            with self._lock:
                offline  = dict(self._offline_cameras)
                pipeline = self._pipeline
            if not offline:
                continue

            with concurrent.futures.ThreadPoolExecutor(
                    max_workers=max(1, len(offline))) as ex:
                reach = {name: ex.submit(_rtsp_reachable, url)
                         for name, url in offline.items()}
                reach = {name: fut.result() for name, fut in reach.items()}

            now = time.monotonic()
            recoverable = {
                name: url for name, url in offline.items()
                if reach.get(name) and now >= self._cam_retry_after.get(name, 0)
            }
            if not recoverable:
                continue

            logger.info(f"Recovery: cameras back online — re-adding: {sorted(recoverable)}")

            if pipeline is None:
                # Pipeline is down (all cameras were stalled/removed) — clear the reachable
                # cameras from _offline_cameras so _do_reload includes them in the rebuild.
                with self._lock:
                    for cam_name in recoverable:
                        self._offline_cameras.pop(cam_name, None)
                logger.info(f"Recovery: pipeline is down — triggering full rebuild for: {sorted(recoverable)}")
                with self._reload_lock:
                    self._do_reload()
                continue

            desired = self._desired_cameras()
            if desired is None:
                continue

            all_batch = self._cameras_for_batch()

            with self._lock:
                # Mere presence in _camera_map isn't proof of health — a camera whose
                # nvurisrcbin/NVDEC session wedged (TCP/RTSP reachable per `reach` above,
                # but zero frames — the "ffplay works, pipeline doesn't" failure mode)
                # stays in _camera_map forever since nothing here ever evicted it. Split
                # by last_frame_time recency so those get force-refreshed instead of
                # being silently treated as "recovered on its own" every cycle.
                running_info = {
                    info["cam_name"]: (idx, info)
                    for idx, info in self._camera_map.items()
                }
                already_fresh = {
                    name for name, (_, info) in running_info.items()
                    if now - info.get("last_frame_time", now) <= self._STUCK_CAMERA_TIMEOUT
                }
                already_stale = set(running_info) - already_fresh

            for cam_name in list(recoverable):
                # Genuinely healthy — recovered on their own (e.g. nvurisrcbin reconnected).
                # Leaving them in offline_cameras would cause recovery to hot-add a
                # duplicate at a different mux slot.
                if cam_name in already_fresh:
                    with self._lock:
                        self._offline_cameras.pop(cam_name, None)
                    logger.info(f"Recovery: {cam_name} already running in pipeline — clearing stale offline entry")
                    continue

                if cam_name in already_stale:
                    # Present in the pipeline but still frozen — the earlier stall/restart
                    # attempt never actually evicted this branch. Force a surgical
                    # remove+re-add instead of leaving it to loop here forever.
                    idx, info = running_info[cam_name]
                    with self._lock:
                        self._offline_cameras.pop(cam_name, None)
                    logger.warning(
                        f"Recovery: {cam_name} still in pipeline but frozen — forcing refresh"
                    )
                    cfg = {"FPS": info.get("fps", 5.0), "Output_Width": info.get("orig_w", 640),
                           "Output_Height": info.get("orig_h", 360)}
                    threading.Thread(
                        target=self._refresh_camera_source,
                        args=(idx, cam_name, info.get("rtsp_url", ""), cfg, info.get("rtsp_id", "0")),
                        daemon=True, name=f"ds-recovery-refresh-{idx}"
                    ).start()
                    continue

                if cam_name not in desired:
                    if cam_name in all_batch:
                        # Camera assigned to this pod but running_status=False — keep retrying
                        logger.info(f"Recovery: {cam_name} disabled (running_status=False) — retrying when enabled")
                    else:
                        # Camera removed from config or moved to a different pod — drop
                        with self._lock:
                            self._offline_cameras.pop(cam_name, None)
                        logger.info(f"Recovery: {cam_name} not in this pod's config — dropping")
                    continue
                cam_data = desired[cam_name]
                cfg = fetch_camera_config(cam_name)
                ok = self._add_camera_branch(
                    cam_name, cam_data["rtsp_url"], cfg, cam_data["rtsp_id"])
                if ok:
                    with self._lock:
                        self._offline_cameras.pop(cam_name, None)
                    self._cam_refresh_fails.pop(cam_name, None)
                    self._cam_retry_after.pop(cam_name, None)
                else:
                    # Hot-add failed — exponential backoff: 2 min → 5 min → 10 min → 10 min cap
                    fails = self._cam_refresh_fails.get(cam_name, 0) + 1
                    self._cam_refresh_fails[cam_name] = fails
                    backoff = min(600, 120 * (2 ** (fails - 1)))  # 120s, 240s, 480s, 600s...
                    self._cam_retry_after[cam_name] = time.monotonic() + backoff
                    logger.warning(
                        f"Recovery: hot-add failed for {cam_name} (attempt #{fails}) "
                        f"— backing off {backoff}s before retry"
                    )

# ─────────────────────────────────────────────────────────────────────────────
# FASTAPI
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_: FastAPI):
    service.start()
    service.reload()
    logger.info("FastAPI startup complete")
    yield

app     = FastAPI(lifespan=lifespan)
service = DeepStreamNvInferService()

class AddCameraRequest(BaseModel):
    cam_name:      str
    rtsp_url:      str
    rtsp_id:       str
    batch_id:      int
    fps:           Optional[float] = None
    output_width:  Optional[int]   = None
    output_height: Optional[int]   = None
    ssim_thresh:   Optional[float] = None

@app.post("/reload")
def reload():
    """Re-read rtsplinks.json and reconcile cameras (add/remove as needed)."""
    service.reload()
    return {"ok": True, "active_cameras": list(service.cameras_status().keys())}

@app.post("/add")
def add_camera(req: AddCameraRequest):
    """Hot-add a single camera without touching any other running camera."""
    if req.batch_id != BATCH_ID:
        return JSONResponse(status_code=400, content={
            "ok": False, "reason": f"wrong batch_id={req.batch_id}, this pod={BATCH_ID}"})

    # Create all folders before touching the pipeline
    for sub in ("live", "spotlight", "alerts", "frame"):
        os.makedirs(os.path.join(AKSHA_PATH, req.cam_name, sub), exist_ok=True)
    os.makedirs(os.path.join(AKSHA_PATH, "Reference_images"), exist_ok=True)

    service._write_status_image(req.cam_name, _LOADING_IMG)

    if not _rtsp_reachable(req.rtsp_url):
        with service._lock:
            service._offline_cameras[req.cam_name] = req.rtsp_url
        service._write_status_image(req.cam_name, _RTSP_ISSUE_IMG)
        logger.warning(f"/add: RTSP unreachable, queued for recovery | camera={req.cam_name}")
        return {"ok": False, "reason": "RTSP unreachable, queued for recovery",
                "cam_name": req.cam_name}

    cfg = fetch_camera_config(req.cam_name)
    if req.fps           is not None: cfg["FPS"]          = req.fps
    if req.output_width  is not None: cfg["Output_Width"]  = req.output_width
    if req.output_height is not None: cfg["Output_Height"] = req.output_height
    if req.ssim_thresh   is not None: cfg["SSIM_Thresh"]   = req.ssim_thresh

    # Persist to JSON first so a pipeline restart (EOS, etc.) picks this camera up
    # without the controller needing to call /add again.
    service._set_rtsp_status(req.rtsp_url, True, req.cam_name,
                             req.rtsp_id, cfg.get("FPS"))

    ok = service._add_camera_branch(req.cam_name, req.rtsp_url, cfg, req.rtsp_id)
    if ok:
        logger.info(f"/add: hot-add done | camera={req.cam_name}")
        return {"ok": True, "cam_name": req.cam_name, "batch_id": BATCH_ID}

    # pipeline=None or no free slot — camera is queued; recovery will add when pipeline up
    with service._lock:
        service._offline_cameras[req.cam_name] = req.rtsp_url
    logger.info(f"/add: pipeline not ready — queued for recovery | camera={req.cam_name}")
    return {"ok": False, "reason": "pipeline not ready, queued for recovery",
            "cam_name": req.cam_name}

@app.post("/remove")
def remove_camera(cam_name: str):
    """Surgically remove one camera without touching any other running camera."""
    with service._lock:
        idx = next(
            (i for i, info in service._camera_map.items()
             if info["cam_name"] == cam_name), None
        )
        rtsp_url = service._camera_map.get(idx, {}).get("rtsp_url", "") if idx is not None else ""
    if idx is None:
        return JSONResponse(status_code=404, content={
            "ok": False, "reason": f"camera '{cam_name}' not found in this pod"})
    service._remove_camera_branch(idx)
    with service._lock:
        service._offline_cameras.pop(cam_name, None)
    # Mark as not running in JSON so a pipeline restart doesn't re-add it automatically.
    if rtsp_url:
        service._set_rtsp_status(rtsp_url, False)
    logger.info(f"/remove: done | camera={cam_name}")
    return {"ok": True, "cam_name": cam_name}

@app.get("/health")
def health():
    now = time.monotonic()
    with service._lock:
        has_cameras = len(service._camera_map) > 0
        trt_ready   = service._trt_ready
        all_stalled = has_cameras and all(
            now - info.get("last_frame_time", now) > _HARD_RESTART_ESCALATION_TIMEOUT
            for info in service._camera_map.values()
        )
    if has_cameras and not trt_ready:
        return JSONResponse(status_code=503, content={
            "ok": False, "reason": "TRT engine compiling", "batch_id": BATCH_ID})
    if all_stalled:
        # Every camera frozen well past the stall-monitor's own hard-restart threshold —
        # report unhealthy so an external watcher (k8s livenessProbe, Swarm, autoheal
        # sidecar) can restart the container even if the in-process escalation hasn't
        # fired yet (e.g. the stall-monitor thread itself is what's wedged).
        return JSONResponse(status_code=503, content={
            "ok": False, "reason": "all cameras stalled", "batch_id": BATCH_ID})
    return {"ok": True, "batch_id": BATCH_ID, "cameras": service.cameras_status()}

@app.get("/cameras")
def cameras():
    return {"batch_id": BATCH_ID, "cameras": service.cameras_status()}

if __name__ == "__main__":
    os.makedirs(os.path.join(AKSHA_PATH, "log"), exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DS_POD_PORT", 8080)))
