"""
deepstream_batch_optimized — nvinfer TRT + fixed pull workers.

Per-camera pipeline:
  nvurisrcbin → tee
    ├─ Branch A: queue(leaky=downstream,max=1) → nvstreammux → nvinfer(TRT FP16) → fakesink
    │                                               ↑ probe: tensor metadata → _latest_detections
    └─ Branch B: queue(leaky=downstream,max=1) → nvvideoconvert(RGBA,w,h) → appsink_i
                                                   ↑ pull workers: try-pull-sample(10ms timeout)
                                                     → motion gate → JPEG → Kafka
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
import math
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

from fastapi import FastAPI
from fastapi.responses import JSONResponse
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

try:
    import nvjpeg as _nvjpeg_mod
    _nvjpeg_enc = _nvjpeg_mod.NvJpeg()
    _HAS_NVJPEG = True
except Exception:
    _nvjpeg_enc = None
    _HAS_NVJPEG = False

def _encode_jpeg(frame_bgr, quality=75):
    """
    Encode a BGR numpy frame to JPEG bytes using the fastest available encoder.

    Priority: nvjpeg (GPU, Turing/Ampere+) → turbojpeg (CPU, ~3× OpenCV)
    → cv2.imencode (always available, slowest).
    """
    if _HAS_NVJPEG:
        try:
            return _nvjpeg_enc.encode(frame_bgr, quality)
        except Exception:
            pass
    if _HAS_TURBO:
        return _turbo.encode(frame_bgr, quality=quality)
    _, buf = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()

Gst.init(None)

try:
    _HAS_CUDA_CV = cv2.cuda.getCudaEnabledDeviceCount() > 0
except (cv2.error, AttributeError):
    _HAS_CUDA_CV = False

# ──────────────────────────────────────────────────────────────────────────────
# ENV
# ──────────────────────────────────────────────────────────────────────────────

KAFKA_SERVER       = os.environ.get("KAFKA_BOOTSTRAP_SERVERS",
                         "broker:9092" if os.path.exists("/.dockerenv") else "localhost:9092")
MONGODB_URI        = os.environ.get("MONGODB_URI",      "mongodb://localhost:27017")
AKSHA_PATH         = os.environ.get("AKSHA_PATH",       "/Aksha")
OUTPUT_TOPIC       = "object_detection_results"   # Kafka topic for OD results + JPEG frames
PUBLISH_LIVE_IMAGE = os.environ.get("PUBLISH_LIVE_IMAGE", "true").lower() == "true"
# Which batch pod this instance handles — controller sets batch_id per camera in rtsplinks.json
BATCH_ID           = int(os.environ.get("BATCH_ID", 1))

# nvstreammux push timeout — env var is in ms, GStreamer property requires microseconds
BATCH_TIMEOUT_US   = int(os.environ.get("BATCH_TIMEOUT_MS", 300)) * 1000

# Confidence threshold for filtering raw nvinfer tensor detections (applied in _parse_tensors)
CONF_THRESHOLD        = float(os.environ.get("CONF_THRESHOLD", 0.35))
# ADAPTIVE_SKIP: burst (streak ≤ burst_frames) → OD every frame; sustained → every Nth frame
ADAPTIVE_SKIP_RATIO   = int(os.environ.get("ADAPTIVE_SKIP_RATIO",   2))
ADAPTIVE_BURST_FRAMES = int(os.environ.get("ADAPTIVE_BURST_FRAMES", 3))

# N_PULL_THREADS: worker threads that pull from appsinks.
# Each thread owns a partition of cameras so no lock is needed on per-camera state.
N_PULL_THREADS = int(os.environ.get("PULL_THREADS", 4))

# FRAME_WORKERS: thread pool for motion gate + JPEG encode + Kafka publish.
FRAME_WORKERS = int(os.environ.get("FRAME_WORKERS", 8))

# Native camera stream FPS — used to compute nvurisrcbin drop-frame-interval
SOURCE_FPS     = int(os.environ.get("SOURCE_FPS", 25))
# nvinfer interval=0: infer on every frame; increase to skip frames for performance
INFER_INTERVAL = int(os.environ.get("INFER_INTERVAL", 0))

NETWORK_W      = 640   # YOLOv10 input width
NETWORK_H      = 640   # YOLOv10 input height
# Force a Kafka publish every FORCE_INTERVAL seconds even on a static scene
FORCE_INTERVAL = 10.0

# Pull timeout: 10ms blocking. At 3fps frames arrive every 333ms.
# 8 cameras × 10ms = 80ms cycle — no frame is delayed more than 80ms.
# VS try-pull-sample(0): wakes every 5ms even with no frames → CPU spin.
_PULL_TIMEOUT_NS = 10_000_000   # 10ms in nanoseconds

_app_dir        = os.path.dirname(__file__)
_names_path     = os.path.join(_app_dir, "coco.names")
DS_CONFIG_PATH  = os.path.join(_app_dir, "ds_config", "config_infer_primary_yolov10.txt")
_LOADING_IMG    = os.path.join(_app_dir, "LOADING_IMG.png")
_RTSP_ISSUE_IMG = os.path.join(_app_dir, "RTSP_ISSUE_IMG.png")

_ONNX_SRC  = os.path.join(_app_dir, "yolov10.onnx")
_ONNX_DEST = os.path.join(AKSHA_PATH, "trt_cache", "yolov10.onnx")
os.makedirs(os.path.join(AKSHA_PATH, "trt_cache"), exist_ok=True)
if not os.path.exists(_ONNX_DEST):
    import shutil as _shutil
    _shutil.copy2(_ONNX_SRC, _ONNX_DEST)
    print(f"Copied ONNX → {_ONNX_DEST}")

with open(_names_path) as f:
    class_names = [l.strip() for l in f.readlines()]

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
        filename=f"{_log_path}/deepstream_batch_opt_{_hostname}.log",
        when='midnight', interval=1, backupCount=30, encoding='utf-8')
    def _rot(src, dst):
        with open(src, 'rb') as fi, gzip.open(dst, 'wb') as fo:
            shutil.copyfileobj(fi, fo)
        os.remove(src)
    h.rotator = _rot
    h.namer   = lambda n: n + ".gz"
    h.setFormatter(fmt)
    log = logging.getLogger(f"ds_batch_opt_{_hostname}_b{BATCH_ID}")
    log.setLevel(logging.INFO)
    log.propagate = False
    if not log.handlers:
        log.addHandler(h)
    return log

logger = _make_logger()
logger.info(
    f"DeepStream batch OPTIMIZED starting | kafka={KAFKA_SERVER} | "
    f"batch_id={BATCH_ID} | batch_timeout_ms={BATCH_TIMEOUT_US//1000} | "
    f"source_fps={SOURCE_FPS} | infer_interval={INFER_INTERVAL} | "
    f"pull_threads={N_PULL_THREADS} | frame_workers={FRAME_WORKERS} | "
    f"jpeg={'nvjpeg(GPU)' if _HAS_NVJPEG else 'turbojpeg(CPU)' if _HAS_TURBO else 'cv2(CPU)'} | "
    f"cuda_cv={_HAS_CUDA_CV}"
)

# ──────────────────────────────────────────────────────────────────────────────
# ADAPTIVE FRAME SKIP
# ──────────────────────────────────────────────────────────────────────────────

class _AdaptiveSkip:
    """
    Per-camera motion-streak tracker that throttles object-detection calls.

    New burst (streak ≤ burst_frames) → run OD every frame.
    Sustained motion (streak > burst_frames) → run OD every skip_ratio frames.
    Thread-safe: pull workers run concurrently and may call should_run_od simultaneously.
    """

    def __init__(self, skip_ratio=2, burst_frames=3):
        """Initialise skip state; thread-safe via self._lock."""
        self._skip_ratio   = skip_ratio
        self._burst_frames = burst_frames
        self._streak:  dict[str, int] = {}
        self._counter: dict[str, int] = {}
        self._lock = threading.Lock()

    def should_run_od(self, camera_name, motion) -> bool:
        """Return True if object detection should run for this frame."""
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

# ──────────────────────────────────────────────────────────────────────────────
# LIVE IMAGE PUBLISHER
# ──────────────────────────────────────────────────────────────────────────────

class _LivePublisher:
    """
    Single background thread that POSTs live thumbnails to node_backend.

    Coalesces concurrent submits: newer submits for the same camera+type overwrite
    older ones so the worker always sends the most recent frame, never a stale one.
    """

    def __init__(self):
        # Keyed by "camera:image_type" so newer submits overwrite stale pending entries
        self._pending: dict[str, tuple] = {}
        self._lock  = threading.Lock()
        self._event = threading.Event()  # signals the worker that work is ready
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, path, camera_name, image_type):
        """Enqueue a live thumbnail write; overwrites any pending entry for the same key."""
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
                    with open(f"{path}/{image_type}.jpg", "rb") as f:
                        requests.post("http://node_backend:5000/api/monitor/",
                                      files={"image": f}, data=data, timeout=(1.0, 1.0))
                except Exception as e:
                    logger.debug(f"publish_live_image error | camera={camera_name}: {e}")

_live_publisher = _LivePublisher()

def publish_live_image(path, camera_name, image_type):
    _live_publisher.submit(path, camera_name, image_type)

# ──────────────────────────────────────────────────────────────────────────────
# KAFKA PRODUCER
# ──────────────────────────────────────────────────────────────────────────────

producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    linger_ms=50,
    batch_size=131072,
    compression_type='gzip',
    acks=1,
    value_serializer=lambda v: json.dumps(v).encode('utf-8'),
)
logger.info(f"Kafka producer ready | topic={OUTPUT_TOPIC}")

# ──────────────────────────────────────────────────────────────────────────────
# MONGODB
# ──────────────────────────────────────────────────────────────────────────────

_mongo  = pymongo.MongoClient(MONGODB_URI)
_config = _mongo["Aksha"]["config"]

def fetch_camera_config(camera_name):
    """Return the MongoDB config document for *camera_name*, or {} on any failure."""
    try:
        return _config.find_one({"Camera_Name": camera_name}) or {}
    except Exception as e:
        logger.warning(f"MongoDB config fetch failed | camera={camera_name}: {e}")
        return {}

# ──────────────────────────────────────────────────────────────────────────────
# RTSP REACHABILITY CHECK
# ──────────────────────────────────────────────────────────────────────────────

def _rtsp_reachable(url: str, timeout: float = 3.0) -> bool:
    """TCP connect check — skip unreachable cameras before building the pipeline."""
    try:
        p = urlparse(url)
        with socket.create_connection((p.hostname, p.port or 554), timeout=timeout):
            return True
    except Exception:
        return False

# ──────────────────────────────────────────────────────────────────────────────
# DEEPSTREAM BATCH SERVICE
# ──────────────────────────────────────────────────────────────────────────────

class DeepStreamBatchService:
    """
    Manages one shared GStreamer pipeline with N camera branches and a pool of pull workers.

    Pipeline layout per camera (built in _build_pipeline):
      nvurisrcbin → tee
        ├─ Branch A: queue(leaky) → nvstreammux → nvinfer(TRT FP16) → fakesink
        └─ Branch B: queue(leaky) → nvvideoconvert(RGBA) → appsink_i
    Pull workers pull from appsink_i, apply the motion gate, and publish to Kafka.
    Tensor detections are read from Branch A via a pad probe and stored in _latest_detections.
    """

    def __init__(self):
        self._lock              = threading.RLock()
        self._pipeline          = None
        self._glib_loop         = None
        self._loop_thread       = None
        self._pull_threads: list[threading.Thread] = []
        self._pull_stops:   list[threading.Event]  = []
        self._camera_map:   dict[int, dict]         = {}
        self._camera_sinks: dict[int, object]       = {}
        self._latest_detections: dict[int, list]    = {}
        self._frame_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=FRAME_WORKERS, thread_name_prefix="ds-frame")
        self._trt_ready: bool = False
        self._reload_timer: "threading.Timer | None" = None
        self._reload_debounce_lock = threading.Lock()
        self._skip_once_cameras: set = set()

    def _write_status_image(self, cam_name, img_path):
        """Write a status JPEG (LOADING or RTSP_ISSUE) to the camera's live directory."""
        img = cv2.imread(img_path)
        if img is None:
            return
        live = os.path.join(AKSHA_PATH, cam_name, "live")
        try:
            for name in ("workday", "holiday"):
                cv2.imwrite(f"{live}/{name}.jpg", img)
        except Exception:
            pass

    def start(self):
        """Spawn the startup retry loop. Call exactly once after construction."""
        threading.Thread(target=self._startup_retry_loop, daemon=True,
                         name="ds-retry-reload").start()
        logger.info("DeepStreamBatchService started — waiting for reload()")

    def _startup_retry_loop(self):
        """Poll every 30 s for camera set / config changes and rebuild the pipeline if needed."""
        while True:
            time.sleep(30)
            self._maybe_reload_if_changed()

    def _desired_cameras(self):
        """Return the set of camera names that should be active for this BATCH_ID, or None on error."""
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception as e:
            logger.debug(f"_desired_cameras: cannot read rtsplinks.json: {e}")
            return None
        return {
            info["cam_name"]
            for _, info in data.items()
            if info.get("running_status") and info.get("cam_name")
            and int(info.get("batch_id", 1)) == BATCH_ID
        }

    def _maybe_reload_if_changed(self):
        """Rebuild the pipeline if the desired camera set or any camera config has changed."""
        desired = self._desired_cameras()
        if desired is None:
            return
        with self._lock:
            current      = {info["cam_name"] for info in self._camera_map.values()}
            current_cfgs = {
                info["cam_name"]: {"fps": info["fps"], "orig_w": info["orig_w"], "orig_h": info["orig_h"]}
                for info in self._camera_map.values()
            }
        if desired != current:
            added   = desired - current
            removed = current - desired
            logger.info(f"Camera set changed — reloading | added={sorted(added)} removed={sorted(removed)}")
            self._do_reload()
            return
        for cam_name in desired:
            try:
                cfg     = fetch_camera_config(cam_name)
                new_fps = float(cfg.get("FPS", 1.0))
                new_w   = int(cfg.get("Output_Width",  640))
                new_h   = int(cfg.get("Output_Height", 360))
                old     = current_cfgs.get(cam_name, {})
                if abs(old.get("fps", 0) - new_fps) > 0.01 or \
                   old.get("orig_w", 0) != new_w or old.get("orig_h", 0) != new_h:
                    logger.warning(f"Config changed | camera={cam_name} — rebuilding pipeline")
                    self._do_reload()
                    return
            except Exception as e:
                logger.debug(f"Config check failed | camera={cam_name}: {e}")

    _RELOAD_DEBOUNCE_S = 5.0

    def reload(self):
        """
        Queue a debounced pipeline rebuild (5 s debounce to coalesce rapid POST /reload calls).

        Rapid controller retries all trigger the same rebuild — the debounce ensures only
        the last call within the window actually rebuilds, avoiding pipeline thrash.
        """
        with self._reload_debounce_lock:
            if self._reload_timer is not None:
                self._reload_timer.cancel()
            t = threading.Timer(self._RELOAD_DEBOUNCE_S, self._do_reload)
            t.daemon = True
            t.start()
            self._reload_timer = t
        logger.info(f"reload: queued (debounce={self._RELOAD_DEBOUNCE_S}s) — "
                    f"pipeline will rebuild once calls settle")

    def _do_reload(self):
        """
        Tear down the current pipeline and rebuild with cameras from rtsplinks.json.

        Steps: TCP-reachability check → stop old pipeline → build new pipeline →
        start GLib loop → spawn pull workers → start stall watchdog.
        """
        rtsp_path = os.path.join(AKSHA_PATH, "rtsplinks.json")
        try:
            with open(rtsp_path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"reload: cannot read rtsplinks.json: {e}")
            return

        desired = {
            info["cam_name"]: {"rtsp_url": rtsp_url, "rtsp_id": str(info.get("rtsp_id", info["cam_name"]))}
            for rtsp_url, info in data.items()
            if info.get("running_status") and info.get("cam_name")
            and int(info.get("batch_id", 1)) == BATCH_ID
        }

        with self._reload_debounce_lock:
            skip = set(self._skip_once_cameras)
            self._skip_once_cameras.clear()
        if skip:
            logger.warning(f"Skipping mux-stall cameras: {sorted(skip)}")
            for cam_name in skip:
                self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
            desired = {k: v for k, v in desired.items() if k not in skip}

        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(desired))) as ex:
            reach = {name: ex.submit(_rtsp_reachable, d["rtsp_url"]) for name, d in desired.items()}
            reach = {name: fut.result() for name, fut in reach.items()}

        skipped = [n for n, ok in reach.items() if not ok]
        if skipped:
            logger.warning(f"RTSP unreachable — skipping: {skipped}")

        with self._lock:
            self._stop_pipeline()

            cameras = []
            for cam_name, cam_data in desired.items():
                if not reach[cam_name]:
                    self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
                    continue
                cfg = fetch_camera_config(cam_name)
                cameras.append((cam_name, cam_data["rtsp_url"], cfg, cam_data["rtsp_id"]))
                for sub in ("live", "spotlight", "alerts", "frame"):
                    os.makedirs(os.path.join(AKSHA_PATH, cam_name, sub), exist_ok=True)
                os.makedirs(os.path.join(AKSHA_PATH, "Reference_images"), exist_ok=True)
                self._write_status_image(cam_name, _LOADING_IMG)

            if not cameras:
                logger.info("reload: no cameras for this batch_id")
                return

            result = self._build_pipeline(cameras)
            if result is None:
                logger.error("reload: failed to build pipeline")
                return
            self._pipeline, self._camera_map, self._camera_sinks = result
            self._latest_detections.clear()

            self._glib_loop = GLib.MainLoop()
            bus = self._pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect("message", self._on_bus_message)

            self._pipeline.set_state(Gst.State.PLAYING)

            self._loop_thread = threading.Thread(
                target=self._glib_loop.run, daemon=True, name="ds-glib")
            self._loop_thread.start()

            # Partition cameras across pull workers.
            items = list(self._camera_sinks.items())
            n_workers = min(max(2, math.ceil(len(items) * 1.0 / 7.0)), N_PULL_THREADS)
            chunk  = math.ceil(len(items) / n_workers)
            groups = [items[i:i+chunk] for i in range(0, len(items), chunk)]

            self._pull_stops   = []
            self._pull_threads = []
            for idx, grp in enumerate(groups):
                stop = threading.Event()
                t = threading.Thread(
                    target=self._pull_worker,
                    args=(dict(grp), self._camera_map, stop),
                    daemon=True, name=f"ds-pull-{idx}")
                t.start()
                self._pull_stops.append(stop)
                self._pull_threads.append(t)

            logger.info(
                f"Pipeline PLAYING | cameras={[c[0] for c in cameras]} "
                f"| pull_workers={len(groups)}")

            threading.Thread(
                target=self._post_start_stall_watchdog,
                args=(list(self._camera_map.keys()),),
                daemon=True, name="ds-stall-watch").start()

    def _post_start_stall_watchdog(self, expected_ids):
        """Wait 12 s post-start; trigger a rebuild if any camera's pad never linked (mux stall)."""
        time.sleep(12)
        with self._lock:
            unlinked = [
                self._camera_map[i]["cam_name"]
                for i in expected_ids
                if i in self._camera_map and not self._camera_map[i].get("pad_linked", False)
            ]
        if not unlinked:
            return
        logger.warning(f"Stall watchdog: pad never linked for {unlinked} — rebuilding")
        with self._reload_debounce_lock:
            self._skip_once_cameras.update(unlinked)
        self._do_reload()

    def _stop_pipeline(self):
        """Signal pull workers to stop, join them, then set the GStreamer pipeline to NULL."""
        for stop in self._pull_stops:
            stop.set()
        for t in self._pull_threads:
            t.join(timeout=3.0)
        self._pull_stops   = []
        self._pull_threads = []

        if self._pipeline:
            self._pipeline.set_state(Gst.State.NULL)
            self._pipeline.get_state(Gst.CLOCK_TIME_NONE)
            self._pipeline = None
            logger.info("Pipeline stopped")

        if self._glib_loop and self._glib_loop.is_running():
            self._glib_loop.quit()
        self._glib_loop    = None
        self._loop_thread  = None
        self._camera_map   = {}
        self._camera_sinks = {}
        self._trt_ready    = False

    def _on_bus_message(self, bus, msg):
        """GStreamer bus callback — handle ERROR and EOS by triggering a pipeline restart."""
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            src_name = msg.src.get_name() if msg.src else "unknown"
            if src_name.startswith("src"):
                logger.warning(f"Source error (nvurisrcbin reconnecting) | src={src_name} | {err.message}")
                for info in self._camera_map.values():
                    if info.get("src_name") == src_name:
                        self._write_status_image(info["cam_name"], _RTSP_ISSUE_IMG)
                        break
                return True
            logger.error(f"Pipeline ERROR | src={src_name} | {err.message} | {dbg}")
            for info in self._camera_map.values():
                self._write_status_image(info["cam_name"], _RTSP_ISSUE_IMG)
            if self._glib_loop:
                self._glib_loop.quit()
            threading.Thread(target=self._restart_after, args=(5,), daemon=True).start()
        elif msg.type == Gst.MessageType.EOS:
            logger.warning("GStreamer EOS — restarting in 5s")
            if self._glib_loop:
                self._glib_loop.quit()
            threading.Thread(target=self._restart_after, args=(5,), daemon=True).start()
        return True

    def _restart_after(self, delay):
        """Sleep *delay* seconds then stop the pipeline and trigger a fresh reload."""
        time.sleep(delay)
        logger.info("Restarting pipeline after error/EOS")
        with self._lock:
            cam_names = [info["cam_name"] for info in self._camera_map.values()]
            self._stop_pipeline()
        for cam_name in cam_names:
            self._write_status_image(cam_name, _LOADING_IMG)
        self.reload()

    # ──────────────────────────────────────────────────────────────────────────
    # PIPELINE BUILD
    # ──────────────────────────────────────────────────────────────────────────

    def _build_pipeline(self, cameras):
        """
        Per camera:
          nvurisrcbin → tee
            ├─ Branch A: queue(leaky) → nvstreammux → nvinfer(TRT FP16) → fakesink
            └─ Branch B: queue(leaky) → nvvideoconvert(RGBA,w,h) → appsink_i
        """
        n          = len(cameras)
        camera_map = {}
        pipeline   = Gst.Pipeline()

        mux = Gst.ElementFactory.make("nvstreammux", "mux")
        if not mux:
            logger.error("nvstreammux not found — DeepStream not installed?")
            return None
        mux.set_property("batch-size",           n)
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
            logger.error("nvinfer not found")
            return None
        pgie.set_property("config-file-path", DS_CONFIG_PATH)
        pgie.set_property("interval",         INFER_INTERVAL)
        pipeline.add(pgie)

        fs = Gst.ElementFactory.make("fakesink", "fs0")
        fs.set_property("async", False)
        pipeline.add(fs)

        if not mux.link(pgie): logger.error("LINK FAILED: mux → pgie"); return None
        if not pgie.link(fs):  logger.error("LINK FAILED: pgie → fs");  return None

        # nvinfer src pad probe — tensor metadata ONLY, safe on NVMM buffer.
        pgie.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._tensor_probe)

        camera_sinks = {}

        for i, (cam_name, rtsp_url, config, rtsp_id) in enumerate(cameras):
            orig_w      = int(config.get("Output_Width",  640))
            orig_h      = int(config.get("Output_Height", 360))
            fps         = float(config.get("FPS", 1.0))
            ssim_thresh = float(config.get("SSIM_Thresh", 0.95))
            src_name    = f"src{i}"

            camera_map[i] = {
                "cam_name":     cam_name,
                "rtsp_id":      rtsp_id,
                "orig_w":       orig_w,
                "orig_h":       orig_h,
                "fps":          fps,
                "min_interval": 1.0 / fps,
                "ssim_thresh":  ssim_thresh,
                "last_proc":    0.0,
                "last_force":   0.0,
                "src_name":     src_name,
                "pad_linked":   False,
            }

            src_bin    = Gst.ElementFactory.make("nvurisrcbin",    src_name)
            tee        = Gst.ElementFactory.make("tee",            f"tee{i}")
            q_infer    = Gst.ElementFactory.make("queue",          f"q_infer{i}")
            q_frame    = Gst.ElementFactory.make("queue",          f"q_frame{i}")
            conv_frame = Gst.ElementFactory.make("nvvideoconvert", f"conv_f{i}")
            caps_rgba  = Gst.ElementFactory.make("capsfilter",     f"caps_r{i}")
            appsink_i  = Gst.ElementFactory.make("appsink",        f"appsink{i}")

            if not all([src_bin, tee, q_infer, q_frame, conv_frame, caps_rgba, appsink_i]):
                logger.error(f"Failed to create elements for camera {cam_name}")
                return None

            src_bin.set_property("uri",    rtsp_url)
            src_bin.set_property("gpu-id", 0)
            try:
                src_bin.set_property("rtsp-reconnect-interval", 5)
            except Exception:
                logger.warning(f"rtsp-reconnect-interval not supported | camera={cam_name}")

            cam_source_fps = int(config.get("Source_FPS", SOURCE_FPS))
            if cam_source_fps > fps:
                drop_interval = max(1, round(cam_source_fps / fps))
                try:
                    src_bin.set_property("drop-frame-interval", drop_interval)
                    logger.info(
                        f"HW frame skip | camera={cam_name} | "
                        f"source={cam_source_fps}fps → target={fps}fps | drop_interval={drop_interval}")
                except Exception as e:
                    logger.warning(f"HW frame skip unavailable ({e}) | camera={cam_name}")

            for q in (q_infer, q_frame):
                q.set_property("max-size-buffers", 1)
                q.set_property("leaky",            2)
                q.set_property("max-size-time",    0)
                q.set_property("max-size-bytes",   0)

            caps_rgba.set_property("caps", Gst.Caps.from_string(
                f"video/x-raw,format=RGBA,width={orig_w},height={orig_h}"))

            appsink_i.set_property("emit-signals", False)
            appsink_i.set_property("sync",         False)
            appsink_i.set_property("max-buffers",  1)
            appsink_i.set_property("drop",         True)

            for el in [src_bin, tee, q_infer, q_frame, conv_frame, caps_rgba, appsink_i]:
                pipeline.add(el)

            mux_sink = mux.get_request_pad(f"sink_{i}")

            def _on_pad_added(element, pad, _tee=tee, _cam=cam_name,
                              _id=i, _map=camera_map):
                caps = pad.get_current_caps() or pad.query_caps(None)
                if not caps or caps.is_empty():
                    return
                if "video" not in caps.get_structure(0).get_name():
                    return
                sink = _tee.get_static_pad("sink")
                if sink.is_linked():
                    return
                ret = pad.link(sink)
                if ret == Gst.PadLinkReturn.OK:
                    _map[_id]["pad_linked"] = True
                    logger.info(f"nvurisrcbin pad linked → tee | camera={_cam}")
                else:
                    logger.error(f"nvurisrcbin pad link failed ({ret}) | camera={_cam}")

            src_bin.connect("pad-added", _on_pad_added)

            tee_a = tee.get_request_pad("src_%u")
            tee_a.link(q_infer.get_static_pad("sink"))
            q_infer.get_static_pad("src").link(mux_sink)

            tee_b = tee.get_request_pad("src_%u")
            tee_b.link(q_frame.get_static_pad("sink"))
            q_frame.link(conv_frame)
            conv_frame.link(caps_rgba)
            caps_rgba.link(appsink_i)

            camera_sinks[i] = appsink_i
            logger.info(f"Camera added | id={i} name={cam_name} fps={fps} {orig_w}×{orig_h}")

        return pipeline, camera_map, camera_sinks

    # ── tensor probe — DETECTIONS ONLY, no pixel access ──────────────────────

    def _tensor_probe(self, pad, info):
        """
        GStreamer pad probe on nvinfer src pad — reads tensor metadata, no pixel access.

        Runs on the GStreamer streaming thread. Stores parsed detections per source_id
        in _latest_detections so pull workers can attach them to published frames.
        """
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
                cam_info  = self._camera_map.get(source_id, {})
                orig_w    = cam_info.get("orig_w", NETWORK_W)
                orig_h    = cam_info.get("orig_h", NETWORK_H)
                self._latest_detections[source_id] = self._parse_tensors(fm, orig_w, orig_h)
                try:
                    l_frame = l_frame.next
                except StopIteration:
                    break
        except Exception as e:
            logger.error(f"tensor_probe error: {e}")
        return Gst.PadProbeReturn.OK

    def _parse_tensors(self, frame_meta, orig_w, orig_h):
        """
        Extract detection boxes from nvinfer tensor output for one frame.

        Reads NvDsInferTensorMeta via ctypes, scales xyxy coords from network space
        (640×640) back to original camera resolution, then calls get_labels() for NMS.
        """
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
                        x0, y0, x1, y1, score, cls_id = row[0], row[1], row[2], row[3], row[4], row[5]
                        if score > CONF_THRESHOLD:
                            boxes.append([int(x0*sx), int(y0*sy), int((x1-x0)*sx), int((y1-y0)*sy)])
                            confs.append(round(float(score), 3))
                            class_ids.append(int(cls_id))
                    detections = get_labels(boxes, confs, class_ids, class_names)
                except Exception as e:
                    logger.error(f"tensor parse error: {e}")
            try:
                l_user = l_user.next
            except StopIteration:
                break
        return detections

    # ──────────────────────────────────────────────────────────────────────────
    # PULL WORKER
    # Key fix: try-pull-sample(_PULL_TIMEOUT_NS) — 10ms blocking timeout.
    # Eliminates busy-polling. At 3fps frames arrive every 333ms, so 10ms
    # timeout wastes zero frames while dropping CPU from 40% to ~10%.
    # ──────────────────────────────────────────────────────────────────────────

    def _pull_worker(self, camera_sinks, camera_map, stop_event):
        """
        Pull frames from a partition of appsinks, apply motion gate, and publish to Kafka.

        Uses a 10 ms blocking try-pull-sample timeout instead of busy-polling (0 timeout).
        At 3 fps frames arrive every 333 ms — the 10 ms timeout adds negligible latency
        while dropping CPU from ~40% (spin) to ~10% (blocked in kernel most of the time).

        Each pull worker owns a non-overlapping subset of camera sinks so per-camera
        state (prev_gray, ref_date, last_live_write) needs no lock.
        """
        prev_gray_i16:   dict[int, np.ndarray] = {}
        prev_gpu_gray:   dict[int, object]     = {}
        last_live_write: dict[int, float]       = {}
        last_frame_time: dict[int, float]       = {}
        cam_issue_state: set[int]               = set()
        ref_date:        dict[int, object]      = {}
        RTSP_ISSUE_TIMEOUT = 30.0

        now_init = time.monotonic()
        for sid in camera_sinks:
            last_frame_time[sid] = now_init

        while not stop_event.is_set():
            now_t = time.monotonic()

            for sid in list(camera_sinks.keys()):
                elapsed = now_t - last_frame_time.get(sid, now_t)
                if elapsed > RTSP_ISSUE_TIMEOUT and sid not in cam_issue_state:
                    cam_info = camera_map.get(sid, {})
                    cam_name = cam_info.get("cam_name")
                    if cam_name:
                        self._write_status_image(cam_name, _RTSP_ISSUE_IMG)
                        cam_issue_state.add(sid)
                        logger.warning(
                            f"No frames {elapsed:.0f}s — RTSP issue | camera={cam_name}")

            for source_id, appsink in list(camera_sinks.items()):
                # 10ms BLOCKING pull — eliminates CPU busy-polling.
                sample = appsink.emit('try-pull-sample', _PULL_TIMEOUT_NS)
                if sample is None:
                    continue

                cam_info = camera_map.get(source_id)
                if not cam_info:
                    continue

                now_t = time.monotonic()
                last_frame_time[source_id] = now_t
                if source_id in cam_issue_state:
                    cam_issue_state.discard(source_id)
                    logger.info(f"Camera reconnected | camera={cam_info['cam_name']}")

                cam_name     = cam_info["cam_name"]
                orig_w       = cam_info["orig_w"]
                orig_h       = cam_info["orig_h"]
                min_interval = cam_info["min_interval"]
                ts           = dt.datetime.now()
                force_pub    = (now_t - cam_info["last_force"]) >= FORCE_INTERVAL

                if (now_t - cam_info["last_proc"]) < min_interval and not force_pub:
                    continue
                cam_info["last_proc"] = now_t

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

                # Daily reference image
                today = ts.date()
                if ref_date.get(source_id) != today or (ts.hour == 9 and ts.minute == 0):
                    ref_path = os.path.join(AKSHA_PATH, "Reference_images")
                    try:
                        cv2.imwrite(os.path.join(ref_path, f"{cam_info['rtsp_id']}.jpg"), frame_bgr)
                    except Exception:
                        pass
                    ref_date[source_id] = today

                # Motion gate — 1/4-res absdiff
                ssim_thresh = cam_info["ssim_thresh"]
                motion      = True
                gray_small  = cv2.resize(gray_u8, (orig_w // 4, orig_h // 4),
                                         interpolation=cv2.INTER_LINEAR)
                if _HAS_CUDA_CV:
                    gpu_cur = cv2.cuda_GpuMat()
                    gpu_cur.upload(gray_small)
                    prev_gpu = prev_gpu_gray.get(source_id)
                    if prev_gpu is not None:
                        diff_gpu = cv2.cuda.absdiff(gpu_cur, prev_gpu)
                        score    = cv2.cuda.norm(diff_gpu, cv2.NORM_L1) / (
                                       (orig_h // 4) * (orig_w // 4) * 255.0)
                        motion   = score >= (1.0 - ssim_thresh)
                    prev_gpu_gray[source_id] = gpu_cur
                else:
                    gray_i16 = gray_small.astype(np.int16)
                    prev     = prev_gray_i16.get(source_id)
                    if prev is not None:
                        score  = np.abs(gray_i16 - prev).mean() / 255.0
                        motion = score >= (1.0 - ssim_thresh)
                    prev_gray_i16[source_id] = gray_i16

                live_path      = os.path.join(AKSHA_PATH, cam_name, "live")
                live_write_due = (now_t - last_live_write.get(source_id, 0.0) >= min_interval)

                if not motion and not force_pub and not live_write_due:
                    _adaptive_skip.should_run_od(cam_name, False)
                    continue

                jpeg_bytes = _encode_jpeg(frame_bgr)

                if live_write_due:
                    for name in ("workday", "holiday"):
                        try:
                            with open(f"{live_path}/{name}.jpg", "wb") as fh:
                                fh.write(jpeg_bytes)
                            publish_live_image(live_path, cam_name, name)
                        except Exception as e:
                            logger.debug(f"live write | camera={cam_name}: {e}")
                    last_live_write[source_id] = now_t

                if not motion and not force_pub:
                    _adaptive_skip.should_run_od(cam_name, False)
                    continue

                if not _adaptive_skip.should_run_od(cam_name, motion) and not force_pub:
                    continue

                if force_pub:
                    cam_info["last_force"] = now_t

                detections = self._latest_detections.get(source_id, [])
                frame_id   = f"{cam_name}@{ts.strftime('%H:%M:%S.%f')}"
                try:
                    payload = {
                        'frame_id':                 frame_id,
                        'frame_bytes':              base64.b64encode(jpeg_bytes).decode('utf-8'),
                        'object_detection_results': detections,
                    }
                    headers = [
                        ('frame_id',      frame_id.encode()),
                        ('timestamp_str', ts.isoformat().encode()),
                        ('camera_name',   cam_name.encode()),
                        ('content-type',  b'image/jpeg'),
                    ]
                    producer.send(OUTPUT_TOPIC, value=payload,
                                  key=frame_id.encode(), headers=headers)
                    logger.info(
                        f"[FRAME SENT] frame_id={frame_id} | camera={cam_name} | "
                        f"objects={len(detections)} | motion={motion}")
                except Exception as e:
                    logger.error(f"Kafka publish failed | camera={cam_name}: {e}")

    def cameras_status(self):
        """Return a {cam_name: {fps}} snapshot for all currently active camera sessions."""
        with self._lock:
            return {info["cam_name"]: {"fps": info["fps"]}
                    for info in self._camera_map.values()}


# ──────────────────────────────────────────────────────────────────────────────
# FASTAPI
# ──────────────────────────────────────────────────────────────────────────────

app     = FastAPI()
service = DeepStreamBatchService()

@app.on_event("startup")
def on_startup():
    service.start()
    service.reload()
    logger.info("FastAPI startup complete")

@app.post("/reload")
def reload():
    """Re-read rtsplinks.json and queue a debounced pipeline rebuild."""
    service.reload()
    return {"ok": True, "active_cameras": list(service.cameras_status().keys())}

@app.get("/health")
def health():
    """
    Liveness + readiness probe.

    Returns 503 while the TRT engine is still compiling on first start —
    the load balancer will hold traffic until the engine is ready.
    """
    with service._lock:
        has_cameras = len(service._camera_map) > 0
        trt_ready   = service._trt_ready
    if has_cameras and not trt_ready:
        return JSONResponse(status_code=503, content={
            "ok": False, "reason": "TRT engine building", "batch_id": BATCH_ID})
    return {"ok": True, "batch_id": BATCH_ID, "cameras": service.cameras_status()}

@app.get("/cameras")
def cameras():
    """List active cameras and their current target FPS."""
    return {"batch_id": BATCH_ID, "cameras": service.cameras_status()}

if __name__ == "__main__":
    os.makedirs(os.path.join(AKSHA_PATH, "log"), exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=8080)
