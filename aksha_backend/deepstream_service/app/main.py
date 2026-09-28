"""
deepstream_service — single-camera GStreamer + YOLOv10 ONNX inference container.

Replaces the old two-container setup (frame_reader + object_detection_service_gpu)
with one process per camera:

  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  GStreamer pipeline  (hardware decode, stays on GPU until appsink)            │
  │                                                                               │
  │  RTSP stream (TCP, latency 200 ms)                                            │
  │    → nvv4l2decoder  (NVDEC — hardware H.264/H.265 decode, ~0% CPU)           │
  │    → nvvideoconvert  (GPU resize + NV12, stays in NVMM memory)               │
  │    → nvvideoconvert  (NVMM → system memory, RGBx format)                     │
  │    → appsink  [rate-limited to target FPS, 1 s pull timeout]                 │
  └─────────────────────────────────┬────────────────────────────────────────────┘
                                    │  RGBx numpy array
  ┌─────────────────────────────────▼────────────────────────────────────────────┐
  │  DeepStreamService processing loop                                             │
  │                                                                               │
  │    Prefilter  (picks fastest available path)                                  │
  │      cv2.cuda absdiff → mean pixel diff  (GPU, FAST_PREFILTER=true)          │
  │      numpy   absdiff → mean pixel diff   (CPU fallback)                      │
  │      SSIM                                (FAST_PREFILTER=false)              │
  │      below threshold → write live thumbnail only, skip OD                     │
  │                                                                               │
  │    YOLOv10 ONNX inference  (TRT FP16 → CUDA → CPU provider priority)        │
  │      → object_detection() → get_labels() (second NMS pass)                   │
  │                                                                               │
  │    KafkaProducer → object_detection_results                                   │
  │      payload: {frame_id, frame_bytes (JPEG/base64), OD results}              │
  │    _LivePublisher → workday.jpg / holiday.jpg → POST /api/monitor/           │
  └──────────────────────────────────────────────────────────────────────────────┘

CPU savings vs the old two-container architecture on RTX 2070:
  NVDEC hardware decode:         saves ~10–15%  (was cv2.VideoCapture software decode)
  No raw_frame Kafka hop:        saves  ~5%      (no encode → publish → consume cycle)
  No base64 round-trip:          saves  ~3%
  One container instead of two:  no inter-process network overhead
Total expected: 18–25% CPU reduction system-wide.

Output topic and message format are identical to object_detection_service_gpu so
alert_identification, post_processor, and notification services need no changes.
"""

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

import numpy as np
import cv2
import base64
import json
import datetime as dt
import os
import threading
import time
import logging
import logging.handlers
import gzip
import shutil
import argparse
import socket
import requests
import onnxruntime as ort
from kafka import KafkaProducer
from skimage.metrics import structural_similarity

from object_detection import load_object_detection_model, object_detection, get_labels

Gst.init(None)

# -------------------- KAFKA --------------------

def load_kafka_config():
    """Return the Kafka bootstrap server address, auto-selecting docker vs localhost."""
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        KAFKA_SERVER = "broker:9092" if os.path.exists("/.dockerenv") else "localhost:9092"
    return KAFKA_SERVER

KAFKA_SERVER = load_kafka_config()
OUTPUT_TOPIC = "object_detection_results"

# -------------------- ARGS --------------------

parser = argparse.ArgumentParser()
parser.add_argument('--camera_name',         default=os.environ.get("CAMERA_NAME"))
parser.add_argument('--rtsp_id',             default=os.environ.get("RTSP_ID"))
parser.add_argument('--rtsp_url',            default=os.environ.get("RTSP_URL"))
parser.add_argument('--output_width',        type=int,   default=int(os.environ.get("OUTPUT_WIDTH",  640)))
parser.add_argument('--output_height',       type=int,   default=int(os.environ.get("OUTPUT_HEIGHT", 360)))
parser.add_argument('--fps',                 type=float, default=float(os.environ.get("FPS", 1.0)))
# argparse type=bool is broken: bool("false") == True because any non-empty string is truthy.
_to_bool = lambda v: v.lower() in ('true', '1', 'yes') if isinstance(v, str) else bool(v)
parser.add_argument('--object_detection',    type=_to_bool,
                    default=_to_bool(os.environ.get("OBJECT_DETECTION", "true")))
parser.add_argument('--prefilter_threshold', type=float, default=float(os.environ.get("SSIM_THRESH", 0.95)))
parser.add_argument('--rtsp_codec',          default=os.environ.get("RTSP_CODEC", "h264"),
                    help="h264 or h265")
args = parser.parse_args()

if not args.camera_name:
    print("FATAL: CAMERA_NAME env var not set — exiting", flush=True)
    raise SystemExit(1)
if not args.rtsp_url:
    print("FATAL: RTSP_URL env var not set — exiting", flush=True)
    raise SystemExit(1)

# -------------------- LOGGER --------------------

aksha_path         = os.environ.get("AKSHA_PATH", "/Aksha")
# k8s Service names can't contain underscores (DNS-1035 label) — the Compose
# service "node_backend" is exposed as "node-backend" when this stack runs on
# Kubernetes.
DEPLOYMENT_PLATFORM = os.environ.get("DEPLOYMENT_PLATFORM", "docker").strip().lower()
NODE_BACKEND_HOST    = "node-backend" if DEPLOYMENT_PLATFORM == "kubernetes" else "node_backend"
logger_path        = os.path.join(aksha_path, args.camera_name, "log")
live_path          = os.path.join(aksha_path, args.camera_name, "live")
spotlight_path     = os.path.join(aksha_path, args.camera_name, "spotlight")
reference_img_path = os.path.join(aksha_path, "Reference_images")
os.makedirs(logger_path,        exist_ok=True)
os.makedirs(live_path,          exist_ok=True)
os.makedirs(spotlight_path,     exist_ok=True)
os.makedirs(reference_img_path, exist_ok=True)

_hostname = socket.gethostname()

def _make_logger():
    """Build a rotating file logger that gzip-compresses rolled logs on midnight rotation."""
    fmt     = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler = logging.handlers.TimedRotatingFileHandler(
        filename=f"{logger_path}/deepstream_{_hostname}.log",
        when='midnight', interval=1, backupCount=30, encoding='utf-8'
    )
    def _rotator(src, dst):
        with open(src, 'rb') as fi, gzip.open(dst, 'wb') as fo:
            shutil.copyfileobj(fi, fo)
        os.remove(src)
    handler.rotator = _rotator
    handler.namer   = lambda n: n + ".gz"
    handler.setFormatter(fmt)
    log = logging.getLogger(f"deepstream_{_hostname}")
    log.setLevel(logging.INFO)
    log.propagate = False
    if not log.handlers:
        log.addHandler(handler)
    return log

logger = _make_logger()
logger.info(
    f"DeepStream service starting | camera={args.camera_name} | rtsp={args.rtsp_url} "
    f"| fps={args.fps} | size={args.output_width}x{args.output_height} | codec={args.rtsp_codec}"
)

# -------------------- KAFKA PRODUCER --------------------

producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    value_serializer=lambda v: json.dumps(v).encode('utf-8')
)
logger.info(f"Kafka producer ready | topic={OUTPUT_TOPIC}")

# -------------------- INFERENCE SETUP --------------------

enable_gpu      = os.environ.get("ENABLE_GPU",      "true").lower() == "true"
enable_tensorrt = os.environ.get("ENABLE_TENSORRT", "true").lower() == "true"
# FP16 requires Tensor Cores (Turing/Ampere+). Set ENABLE_TRT_FP16=false for Pascal (GTX 10xx).
enable_trt_fp16 = os.environ.get("ENABLE_TRT_FP16", "true").lower() == "true"
trt_cache_path  = os.environ.get("TRT_CACHE_PATH",  "/Aksha/trt_cache")
# FAST_PREFILTER: replace scikit-image SSIM (22ms/frame) with full-res CUDA/numpy pixel diff (~1ms/frame).
# Uses CUDA if cv2.cuda is available, numpy otherwise. Set to false to keep original SSIM.
FAST_PREFILTER      = os.environ.get("FAST_PREFILTER",      "true").lower() == "true"
# Live image write interval matches camera FPS — UI thumbnail refreshes at the same rate.
# Override with LIVE_WRITE_INTERVAL env var if a slower refresh is needed (e.g. 50-cam setups).
LIVE_WRITE_INTERVAL  = float(os.environ.get("LIVE_WRITE_INTERVAL",  1.0 / args.fps))
# Set false to skip HTTP push to node_backend entirely.
# node_backend serves workday.jpg/holiday.jpg directly from the shared /Aksha volume,
# so disabling this eliminates multipart upload traffic without losing live view.
PUBLISH_LIVE_IMAGE   = os.environ.get("PUBLISH_LIVE_IMAGE", "true").lower() == "true"

try:
    _HAS_CUDA_CV = cv2.cuda.getCudaEnabledDeviceCount() > 0
except (cv2.error, AttributeError):
    _HAS_CUDA_CV = False

available = ort.get_available_providers()
logger.info(f"ONNX providers available: {available}")

if enable_gpu and enable_tensorrt and "TensorrtExecutionProvider" in available:
    os.makedirs(trt_cache_path, exist_ok=True)
    providers = [
        ("TensorrtExecutionProvider", {
            "trt_fp16_enable": enable_trt_fp16,
            "trt_engine_cache_enable": True,
            "trt_engine_cache_path": trt_cache_path,
            "trt_max_workspace_size": 1 << 30,
            "trt_builder_optimization_level": 3,
        }),
        ("CUDAExecutionProvider", {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"}),
        "CPUExecutionProvider",
    ]
    logger.info("Inference: TensorRT FP16 → CUDA → CPU")
elif enable_gpu and "CUDAExecutionProvider" in available:
    providers = [
        ("CUDAExecutionProvider", {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo"}),
        "CPUExecutionProvider",
    ]
    logger.info("Inference: CUDA → CPU")
else:
    providers = ["CPUExecutionProvider"]
    logger.info("Inference: CPU only")

_model_path = os.path.join(os.path.dirname(__file__), "yolov10.onnx")
_names_path = os.path.join(os.path.dirname(__file__), "coco.names")

logger.info("Loading YOLOv10 ONNX model — TRT engine build may take several minutes on first run")
ort_session, class_names, colors = load_object_detection_model(_model_path, _names_path, providers=providers)

# Force TRT engine compile now so the first real frame is not blocked for minutes.
object_detection(np.zeros((640, 640, 3), dtype=np.uint8), ort_session, class_names, colors)
logger.info("Model warmup complete")

# -------------------- HELPERS --------------------

class _LivePublisher:
    """
    Single background thread drains a per-camera latest-frame buffer.
    Replaces thread-per-call pattern — eliminates TCP connection storm to Go backend.
    Old frames are dropped if a newer one arrives before the previous was sent.
    """
    def __init__(self):
        self._pending: dict[str, tuple] = {}   # "cam:type" → (path, cam, type)
        self._lock  = threading.Lock()
        self._event = threading.Event()
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

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
                    with open(f"{path}/{image_type}.jpg", "rb") as f:
                        requests.post(f"http://{NODE_BACKEND_HOST}:5000/api/monitor/",
                                      files={"image": f}, data=data, timeout=(1.0, 1.0))
                except Exception as e:
                    logger.debug(f"publish_live_image error | camera={camera_name}: {e}")

_live_publisher = _LivePublisher()

def publish_live_image(path, camera_name, image_type):
    """Non-blocking submit to the shared live-image sender thread."""
    _live_publisher.submit(path, camera_name, image_type)

# -------------------- GSTREAMER PIPELINE --------------------

def build_pipeline(rtsp_url: str, width: int, height: int, codec: str) -> Gst.Pipeline:
    """
    Build and return a GStreamer pipeline for one RTSP camera.

    Chain: rtspsrc (TCP) → depay/parse → nvv4l2decoder (NVDEC)
           → nvvideoconvert (scale, NV12, NVMM) → nvvideoconvert (RGBx, system mem)
           → appsink (max-buffers=2, drop=true, sync=false)
    """
    depay   = "rtph264depay" if codec == "h264" else "rtph265depay"
    parse   = "h264parse"    if codec == "h264" else "h265parse"

    pipeline_str = (
        # Quoting the URI handles RTSP URLs with auth credentials (user:pass@host).
        f"rtspsrc location=\"{rtsp_url}\" latency=200 protocols=tcp retry=5 "
        f"! {depay} ! {parse} ! nvv4l2decoder "
        # First nvvideoconvert: GPU resize (NVMM NV12 → NVMM NV12 at target resolution).
        f"! nvvideoconvert "
        f"! video/x-raw(memory:NVMM),format=NV12,width={width},height={height} "
        # Second nvvideoconvert: move frame from GPU memory (NVMM) to system memory.
        # This step is required before appsink — appsink cannot read NVMM buffers directly.
        f"! nvvideoconvert "
        f"! video/x-raw,format=RGBx "
        # appsink reads RGBx (4-byte aligned). Alpha channel dropped in Python via [:,:,:3].
        # No CPU videoconvert element needed — saves one full-frame color-plane copy per frame.
        f"! appsink name=appsink0 emit-signals=false sync=false max-buffers=2 drop=true"
    )
    logger.info(f"GStreamer pipeline: {pipeline_str}")
    pipeline = Gst.parse_launch(pipeline_str)
    if not pipeline:
        raise RuntimeError("GStreamer pipeline parse failed")
    return pipeline

# -------------------- PIPELINE STATE & BUS --------------------

class PipelineState:
    """Shared mutable state passed between the GLib bus thread and the appsink loop."""

    def __init__(self):
        self.running   = True          # set to False on KeyboardInterrupt to exit cleanly
        self.rtsp_down = False         # True after an ERROR/EOS bus message
        self.restart   = threading.Event()  # set by bus callback to break the pull loop

def make_bus_callback(state: PipelineState, loop: GLib.MainLoop):
    """Return a GStreamer bus callback that sets state.restart on ERROR or EOS."""
    def on_bus_message(bus, message):
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            logger.warning(f"GStreamer ERROR: {err.message} | debug={dbg}")
            state.rtsp_down = True
            state.restart.set()
            loop.quit()
        elif t == Gst.MessageType.EOS:
            logger.warning("GStreamer EOS — stream ended, will reconnect")
            state.rtsp_down = True
            state.restart.set()
            loop.quit()
        elif t == Gst.MessageType.WARNING:
            w, _ = message.parse_warning()
            logger.debug(f"GStreamer WARNING: {w.message}")
        return True
    return on_bus_message

# -------------------- SERVICE --------------------

class DeepStreamService:
    """
    Single-camera inference service driven by a GStreamer appsink pull loop.

    One instance per container — camera identity comes from CLI args / env vars.
    Reconnects automatically on RTSP error/EOS by looping in run().
    """

    def __init__(self):
        self.camera_name    = args.camera_name
        self.rtsp_url       = args.rtsp_url
        self.rtsp_id        = args.rtsp_id
        self.width          = args.output_width
        self.height         = args.output_height
        self.target_fps     = args.fps
        self.object_det     = args.object_detection
        self.ssim_threshold = args.prefilter_threshold
        self.codec          = args.rtsp_codec
        # Time-based throttle: process one frame every N seconds regardless of stream FPS.
        # This avoids needing to know the stream's native FPS in advance.
        self.min_frame_interval = 1.0 / self.target_fps
        self.prev_frame      = None
        self._last_live_write = 0.0
        logger.info(f"DeepStreamService init | camera={self.camera_name} | fps={self.target_fps}")

    def _run_inference(self, frame):
        """Run YOLOv10 OD on *frame* and return a list of detection dicts."""
        t0 = time.monotonic()
        boxes, confs, class_ids, classes = object_detection(frame, ort_session, class_names, colors)
        results = get_labels(boxes, confs, class_ids, classes)
        logger.info(f"Inference | camera={self.camera_name} | detections={len(results)} | ms={(time.monotonic()-t0)*1000:.1f}")
        return results

    def _publish(self, frame_id, frame, results, timestamp):
        """JPEG-encode *frame* and publish it with OD results to the Kafka output topic."""
        _, jpeg = cv2.imencode('.jpg', cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        payload = {
            'frame_id':                 frame_id,
            'frame_bytes':              base64.b64encode(jpeg.tobytes()).decode('utf-8'),
            'object_detection_results': results,
        }
        headers = [
            ('frame_id',      frame_id.encode('utf-8')),
            ('timestamp_str', timestamp.isoformat().encode('utf-8')),
            ('camera_name',   self.camera_name.encode('utf-8')),
            ('content-type',  b'image/jpeg'),
        ]
        producer.send(OUTPUT_TOPIC, value=payload, key=frame_id.encode('utf-8'), headers=headers)
        logger.info(f"[FRAME SENT] frame_id={frame_id} | camera={self.camera_name} | objects={len(results)}")

    def _ssim_pass(self, frame, frame_id, force) -> bool:
        """Return True if the frame changed enough to warrant inference, or if forced."""
        if self.prev_frame is None:
            self.prev_frame = frame.copy()
            return True

        if FAST_PREFILTER:
            if _HAS_CUDA_CV:
                g = cv2.cuda_GpuMat(); g.upload(frame)
                p = cv2.cuda_GpuMat(); p.upload(self.prev_frame)
                diff = cv2.cuda.absdiff(g, p).download()
            else:
                diff = np.abs(frame.astype(np.float32) - self.prev_frame.astype(np.float32))
            score = np.mean(diff) / 255.0
            self.prev_frame = frame.copy()
            logger.info(f"diff={score:.4f} | threshold={1-self.ssim_threshold:.4f} | frame_id={frame_id}")
            if score < (1.0 - self.ssim_threshold) and not force:
                now_t = time.monotonic()
                if now_t - self._last_live_write >= LIVE_WRITE_INTERVAL:
                    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    cv2.imwrite(f'{live_path}/workday.jpg', bgr)
                    cv2.imwrite(f'{live_path}/holiday.jpg', bgr)
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "workday"), daemon=True).start()
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "holiday"), daemon=True).start()
                    self._last_live_write = now_t
                return False
        else:
            gray_cur  = cv2.cvtColor(frame,           cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
            gray_prev = cv2.cvtColor(self.prev_frame, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
            ssim, _   = structural_similarity(gray_prev, gray_cur, full=True, data_range=1.0, channel_axis=None)
            self.prev_frame = frame.copy()
            logger.info(f"SSIM={ssim:.4f} | threshold={self.ssim_threshold} | frame_id={frame_id}")
            if ssim > self.ssim_threshold and not force:
                now_t = time.monotonic()
                if now_t - self._last_live_write >= LIVE_WRITE_INTERVAL:
                    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    cv2.imwrite(f'{live_path}/workday.jpg', bgr)
                    cv2.imwrite(f'{live_path}/holiday.jpg', bgr)
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "workday"), daemon=True).start()
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "holiday"), daemon=True).start()
                    self._last_live_write = now_t
                return False
        return True

    def _store_reference(self, frame):
        """Write a reference JPEG for this camera (used for background subtraction)."""
        try:
            cv2.imwrite(f"{reference_img_path}/{self.rtsp_id}.jpg", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        except Exception as e:
            logger.warning(f"Reference image store failed: {e}")

    @staticmethod
    def _gst_buffer_to_numpy(sample, width, height):
        """Map a GStreamer RGBx sample buffer to a (H, W, 3) numpy array (zero-copy view, then copy)."""
        buf = sample.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            return None
        try:
            # RGBx: 4 bytes/pixel — drop padding channel to get 3-channel RGB frame.
            return np.frombuffer(mi.data, dtype=np.uint8).reshape((height, width, 4))[:, :, :3].copy()
        finally:
            buf.unmap(mi)

    def _run_session(self):
        """Run one pipeline session. Returns True to reconnect, False to exit."""
        state = PipelineState()

        try:
            loading = cv2.imread(os.path.join(os.path.dirname(__file__), "LOADING_IMG.png"))
            if loading is not None:
                cv2.imwrite(f'{live_path}/workday.jpg', loading)
                cv2.imwrite(f'{live_path}/holiday.jpg', loading)
                threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "workday"), daemon=True).start()
                threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "holiday"), daemon=True).start()
        except Exception as e:
            logger.debug(f"Loading placeholder error: {e}")

        pipeline = build_pipeline(self.rtsp_url, self.width, self.height, self.codec)
        appsink  = pipeline.get_by_name('appsink0')

        loop = GLib.MainLoop()
        bus  = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", make_bus_callback(state, loop))
        # GLib loop must run in a separate thread — it is blocking and handles
        # GStreamer bus events (ERROR, EOS, state changes) in the background.
        threading.Thread(target=loop.run, daemon=True).start()

        ret = pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            logger.error("Pipeline failed to enter PLAYING state")
            loop.quit()
            return True

        logger.info(f"Pipeline PLAYING | camera={self.camera_name}")

        last_process_time = 0.0
        last_force_time   = 0.0
        ref_date          = None
        # Send a frame to Kafka every FORCE_INTERVAL seconds even if SSIM says the scene
        # is unchanged. Downstream services need a heartbeat to stay alive.
        FORCE_INTERVAL    = 10.0

        try:
            while not state.restart.is_set():
                sample = appsink.emit('try-pull-sample', Gst.SECOND)
                if sample is None:
                    continue

                now = time.monotonic()
                if now - last_process_time < self.min_frame_interval:
                    continue
                last_process_time = now

                frame = self._gst_buffer_to_numpy(sample, self.width, self.height)
                if frame is None:
                    continue

                timestamp = dt.datetime.now()
                # %f guarantees 6-digit microseconds even when they are zero,
                # so frame_id is always the same fixed-width format downstream expects.
                frame_id = f"{self.camera_name}@{timestamp.strftime('%H:%M:%S.%f')}"

                # Track reference image by date, not a plain bool.
                # A bool would stay True forever and the 09:00 daily update would
                # never fire again after day one.
                today = timestamp.date()
                if ref_date != today or (timestamp.hour == 9 and timestamp.minute == 0):
                    self._store_reference(frame)
                    ref_date = today

                state.rtsp_down = False
                force = (now - last_force_time) >= FORCE_INTERVAL

                if not self._ssim_pass(frame, frame_id, force):
                    logger.info(f"[FRAME SKIPPED] SSIM unchanged | frame_id={frame_id}")
                    continue

                if force:
                    last_force_time = now

                logger.info(f"[FRAME RECEIVED] frame_id={frame_id} | camera={self.camera_name}")

                results = self._run_inference(frame) if self.object_det else []
                self._publish(frame_id, frame, results, timestamp)

                now_t = time.monotonic()
                if now_t - self._last_live_write >= LIVE_WRITE_INTERVAL:
                    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    cv2.imwrite(f'{live_path}/workday.jpg', bgr)
                    cv2.imwrite(f'{live_path}/holiday.jpg', bgr)
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "workday"), daemon=True).start()
                    threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "holiday"), daemon=True).start()
                    self._last_live_write = now_t

        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt — stopping")
            state.running = False
        except Exception as e:
            logger.exception(f"Processing loop error: {e}")
        finally:
            pipeline.set_state(Gst.State.NULL)
            loop.quit()
            logger.info(f"Pipeline stopped | camera={self.camera_name}")

        return state.running

    def run(self):
        """
        Outer reconnect loop — calls _run_session() repeatedly until it returns False.

        On each reconnect: show RTSP issue image, wait 5 s, then start a new session.
        """
        logger.info(f"DeepStreamService.run() | camera={self.camera_name}")
        rtsp_issue = cv2.imread(os.path.join(os.path.dirname(__file__), "RTSP_ISSUE_IMG.png"))

        while True:
            if not self._run_session():
                break
            logger.warning(f"RTSP stream lost — reconnecting in 5s | camera={self.camera_name}")
            if rtsp_issue is not None:
                cv2.imwrite(f'{live_path}/workday.jpg', rtsp_issue)
                cv2.imwrite(f'{live_path}/holiday.jpg', rtsp_issue)
                threading.Thread(target=publish_live_image, args=(live_path, self.camera_name, "workday"), daemon=True).start()
            time.sleep(5)

        logger.info(f"DeepStreamService exiting | camera={self.camera_name}")


# -------------------- ENTRYPOINT --------------------

if __name__ == "__main__":
    for d in ["frame", "alerts", "foreground", "spotlight",
              "Reference_images", "insight_report", "live", "insight"]:
        if d in ("Reference_images", "insight_report"):
            os.makedirs(os.path.join(aksha_path, d), exist_ok=True)
        else:
            os.makedirs(os.path.join(aksha_path, args.camera_name, d), exist_ok=True)

    DeepStreamService().run()
