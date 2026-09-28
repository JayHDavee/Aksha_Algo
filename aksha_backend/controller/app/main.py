"""
controller — Docker-based camera deployment orchestrator.

Architecture:

  ┌───────────────────────────────────────────────────────────────────────────┐
  │  FastAPI service  (port 4000)                                              │
  │                                                                            │
  │  POST /Surveillance  — start / update / restart / stop camera containers  │
  │    deployment_mode="frame_reader"      → frame_reader container per cam   │
  │    deployment_mode="deepstream_single" → deepstream_service per cam       │
  │    deployment_mode="deepstream_batch"  → write rtsplinks.json +           │
  │                                          POST /reload to batch pods        │
  │    deployment_mode="deepstream_nvinfer"→ write rtsplinks.json +           │
  │                                          POST /reload to nvinfer pods      │
  │                                                                            │
  │  POST /Insight              — heatmap generation (camera + time range)    │
  │  POST /AlertReportAnalyzer  — LLM alert trend summary  (Azure GPT)        │
  │  POST /ImageAnalysis        — VQA over a camera frame  (Azure GPT)        │
  │  POST /Notifications        — restart all running camera containers        │
  │  POST /DockerClean          — docker system prune                          │
  │  GET  /rtsplinks.json       — current camera registry                      │
  │  GET  /health               — Docker connectivity liveness probe           │
  └───────────────────────────────────────────────────────────────────────────┘

  Shared state:
    AKSHA_PATH/rtsplinks.json  — camera registry
                                 key: rtsp_url → {cam_name, running_status, batch_id}
    Docker daemon (SDK)        — create / stop / remove / restart containers
    BATCH_COUNT env var        — number of deepstream-batch/nvinfer pods
                                 (1 = legacy single-pod "deepstream-batch" name)
    DEEPSTREAM_SERVICE env var — "deepstream_batch" (default) or "deepstream_nvinfer"
                                 selects which pod fleet to signal on /reload
"""

import os, pathlib, datetime, pytz, docker, json, shutil, time, threading
import concurrent.futures
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from enum import Enum
from pydantic import BaseModel
from typing import List, Optional
import uvicorn
import logging
from fastapi.responses import JSONResponse, StreamingResponse

# -------------------- STARTUP: ENV VARS & LOGGER --------------------

host_dir = os.environ.get("HOST_MACHINE_AKSHA_PATH")
main_dir = os.environ.get("AKSHA_PATH")
logger_path = f"{main_dir}/log"
os.makedirs(logger_path, exist_ok=True)

logging.basicConfig(
    filename=f"{logger_path}/controller.log",
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    filemode="a",
)
logger = logging.getLogger("controller")
logger.info(f"Controller starting | main_dir={main_dir} | host_dir={host_dir}")

# -------------------- DOCKER CLIENT --------------------

def init_client():
    """Connect to the Docker daemon and return the client, or None on failure."""
    # Stage: connect to Docker daemon from environment defaults
    try:
        client = docker.from_env(timeout=60)
        logger.info("Docker client initialised successfully")
        return client
    except Exception as e:
        logger.exception(f"Docker client initialization failed: {e}")
        return None

client = init_client()
HOST_MACHINE_AKSHA = os.environ.get("HOST_MACHINE_AKSHA_PATH")

# -------------------- KAFKA CONFIG --------------------

def load_kafka_config():
    # Stage: resolve Kafka bootstrap server from env or apply container/local fallback
    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        if os.path.exists("/.dockerenv"):
            KAFKA_SERVER = "broker:9092"
        else:
            KAFKA_SERVER = "localhost:9092"
    logger.info(f"Kafka server resolved | KAFKA_SERVER={KAFKA_SERVER}")
    return KAFKA_SERVER

KAFKA_SERVER = load_kafka_config()
# How many deepstream-batch containers are running. Each handles ~10 cameras.
# BATCH_COUNT=1 → single container named "deepstream-batch" (backward compat)
# BATCH_COUNT=N → containers named "deepstream-batch1" .. "deepstream-batchN"
BATCH_COUNT = int(os.environ.get("BATCH_COUNT", "1"))
# Which deepstream pod fleet to signal: "deepstream_batch" or "deepstream_nvinfer"
DEEPSTREAM_SERVICE = os.environ.get("DEEPSTREAM_SERVICE", "deepstream_batch")

# -------------------- FPS PRESETS --------------------
# FPS_DEFAULT : normal camera processing rate
# FPS_HIGH    : burst / high-activity cameras
# FPS_MIN     : minimum allowed — below this motion gate misses fast events
FPS_DEFAULT = 3.0
FPS_HIGH    = 5.0
FPS_MIN     = 1.0
FPS_MAX     = FPS_HIGH

# -------------------- MODELS --------------------

class Operation(str, Enum):
    create = "start"
    update = "update"
    restart = "restart"
    delete = "stop"

class Item(BaseModel):
    camera_name: str
    update_camera_name: Optional[str] = None
    rtsp_link: str
    rtsp_id: Optional[int] = None
    alerts: List = []
    fps: Optional[float] = 1.0
    email_auto_alert: bool = True
    display_auto_alert: bool = True
    email_alert: bool = True
    display_alert: bool = True
    output_height: int = 360
    output_width: int = 640
    object_detection: bool = True
    anomaly_detection: bool = True
    face_rec: bool = False
    anpr: bool = False
    prefilter_threshold: float = 0.95
    # deployment_mode controls which pipeline runs for this camera:
    #   "frame_reader"       — original OpenCV RTSP + shared OD service (default, CPU-based)
    #   "deepstream_single"  — one DeepStream container per camera (NVDEC + TRT, best isolation)
    #   "deepstream_batch"   — shared DeepStream batch container (NVDEC + batch TRT, best for 4+ cameras)
    #   "deepstream_nvinfer" — shared DeepStream NvInfer container (DS 7.1, dynamic add/remove, RTX 3050)
    #   "ppe"                — PPE detection container (RTSP read + inference + ppe_results, CPU-based)
    #   "jewelry"            — Jewelry store detection container (RTSP read + rule engine + jewelry_results, CPU-based; behind JEWELRY_DETECTION feature flag)
    #deployment_mode: str = "frame_reader"
    #deployment_mode: str = "deepstream_single"
    #deployment_mode: str = "deepstream_batch"
    deployment_mode: str = "deepstream_nvinfer"

    class Config:
        extra = "ignore"

class Surveillance(BaseModel):
    type: Operation
    camera_list: List[Item]

class Insight(BaseModel):
    camera_name: str
    start_date: str
    start_time: str
    end_date: str
    end_time: str

class ImageAnalysis(BaseModel):
    question: str
    image: str
    model_option: str
    chat_history: list

class DownloadImageAnalysisChat(BaseModel):
    image: str
    chat_history: list

class AlertReportAnalyzer(BaseModel):
    filtered_data: dict
    start_date: str
    end_date: str
    model_option: str
    lang_option: str

# -------------------- APP & MIDDLEWARE --------------------

app = FastAPI()
origins = ["*"]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# -------------------- DIRECTORY INIT --------------------

def initialize_directories():
    """Create AKSHA_PATH directory structure and an empty rtsplinks.json if missing."""
    # Stage: ensure AKSHA_PATH structure and rtsplinks.json exist before serving requests
    try:
        os.makedirs(main_dir, exist_ok=True)
        os.makedirs(logger_path, exist_ok=True)

        rtsplinks_path = os.path.join(main_dir, "rtsplinks.json")
        if not os.path.exists(rtsplinks_path):
            with open(rtsplinks_path, 'w') as f:
                json.dump({}, f, indent=4)
            logger.info(f"Created empty rtsplinks.json at {rtsplinks_path}")

        logger.info("Directories and config files initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize directories: {e}")

initialize_directories()

_rtsp_lock = threading.Lock()

# -------------------- DOCKER CLIENT HELPER --------------------

def get_client():
    """Return a live Docker client, reconnecting if the previous connection dropped."""
    # Stage: return a live Docker client, reconnecting if the previous connection dropped
    global client
    if client:
        try:
            client.ping()
            return client
        except Exception:
            logger.warning("Docker client ping failed — reconnecting")
            client = None
    client = init_client()
    if not client:
        logger.error("Docker connection failed")
        raise HTTPException(503, "Docker connection failed")
    return client

# -------------------- HEALTH / ROOT ENDPOINTS --------------------

@app.get("/")
def root():
    logger.info("GET / — health probe")
    return {"message": "Controller API is running"}

@app.get("/health")
def health():
    logger.info("GET /health — checking Docker connectivity")
    try:
        get_client().ping()
        logger.info("Health check passed | docker=connected")
        return {"ok": True, "docker": "connected"}
    except Exception as e:
        logger.exception(f"Health check failed: {e}")
        return {"ok": False, "docker": str(e)}

# -------------------- RTSP LINKS --------------------

@app.get("/rtsplinks.json")
async def get_rtsp_links():
    # Stage: return the current RTSP registry (camera name → link + running_status)
    logger.info("GET /rtsplinks.json — reading camera registry")
    try:
        rtsplinks_path = os.path.join(main_dir, "rtsplinks.json")
        if os.path.exists(rtsplinks_path):
            with open(rtsplinks_path, 'r') as f:
                data = json.load(f)
            logger.info(f"rtsplinks.json read | cameras={list(data.keys())}")
            return data
        else:
            logger.warning("rtsplinks.json not found — returning empty dict")
            return {}
    except Exception as e:
        logger.error(f"Error reading rtsplinks.json: {e}")
        raise HTTPException(500, f"Error reading rtsplinks.json: {e}")

# -------------------- DOCKER PRUNE --------------------

@app.post("/DockerClean")
def docker_system_prune():
    # Stage: free disk space by removing stopped containers, dangling images, unused networks
    logger.info("POST /DockerClean — running docker system prune")
    try:
        import subprocess
        result = subprocess.run(["docker", "system", "prune", "-f"],
                                capture_output=True, text=True)
        logger.info(f"Docker prune executed | output={result.stdout.strip()}")
        return {"message": "Docker system pruned successfully", "output": result.stdout}
    except Exception as e:
        logger.error(f"Docker prune failed: {e}")
        raise HTTPException(500, f"Docker prune failed: {e}")

# -------------------- NOTIFICATIONS (RESTART ALL RUNNING CAMERAS) --------------------

@app.post("/Notifications")
def restart_running_cameras():
    # Stage: restart all containers for cameras currently marked as running in rtsplinks.json
    logger.info("POST /Notifications — restarting all running camera containers")
    try:
        rtsplinks_path = os.path.join(main_dir, "rtsplinks.json")
        if os.path.exists(rtsplinks_path):
            with open(rtsplinks_path, 'r') as f:
                data = json.load(f)

            client = get_client()
            restarted_cameras = []

            for rtsp_link, cam_info in data.items():
                if cam_info.get("running_status", False):
                    cam_name = cam_info.get("cam_name")
                    if cam_name:
                        # Stage: restart each service container for this camera.
                        # -ppe/-jewelry included unconditionally (like -anomaly/
                        # -face/-anpr) rather than gated on the persisted
                        # deployment_mode — a container that doesn't exist for
                        # this camera just logs a harmless "not found (skipped)"
                        # below, whereas relying solely on deployment_mode would
                        # silently skip the restart for any camera created
                        # before that field started being persisted.
                        for suffix in ["-rtsp", "-ppe", "-jewelry", "-anomaly", "-face", "-anpr"]:
                            container_name = f"{cam_name}{suffix}"
                            try:
                                container = client.containers.get(container_name)
                                container.restart()
                                logger.info(f"Restarted container: {container_name}")
                            except docker.errors.NotFound:
                                logger.info(f"Container not found (skipped): {container_name}")
                            except Exception as e:
                                logger.error(f"Failed to restart {container_name}: {e}")

                        restarted_cameras.append(cam_name)

            logger.info(f"Restart sweep complete | restarted={restarted_cameras}")
            return {"message": f"Restarted cameras: {restarted_cameras}"}
        else:
            logger.warning("No rtsplinks.json found — nothing to restart")
            return {"message": "No rtsplinks.json found"}
    except Exception as e:
        logger.error(f"Failed to restart cameras: {e}")
        raise HTTPException(500, f"Failed to restart cameras: {e}")

# -------------------- CONTAINER HELPERS --------------------

def safe_delete(client, name):
    """Stop and remove all service containers for *name* ({name}-rtsp/anomaly/face/anpr) in parallel."""
    # Stage: stop and remove all service containers for a camera before re-creating them
    logger.info(f"safe_delete called | camera={name}")
    from concurrent.futures import ThreadPoolExecutor

    def _stop_one(n):
        try:
            c = client.containers.get(n)
            try:
                c.stop(timeout=5)
            except Exception:
                try:
                    c.kill()
                except Exception:
                    pass
            c.remove(force=True)
            logger.info(f"Stopped and removed container: {n}")
        except docker.errors.NotFound:
            logger.info(f"Container not found (skipped): {n}")
        except Exception as e:
            logger.error(f"Failed to stop/remove container {n}: {e}")

    names = [f"{name}-rtsp", f"{name}-anomaly", f"{name}-face", f"{name}-anpr"]
    with ThreadPoolExecutor(max_workers=len(names)) as ex:
        list(ex.map(_stop_one, names))

def _assign_batch_id(data: dict) -> int:
    """Return the batch_id (1..BATCH_COUNT) with fewest running cameras."""
    counts = {i: 0 for i in range(1, BATCH_COUNT + 1)}
    for info in data.values():
        if info.get("running_status"):
            bid = int(info.get("batch_id", 1))
            if bid in counts:
                counts[bid] += 1
    return min(counts, key=counts.get)


def update_rtsp_status(camera_name, rtsp_link=None, running_status=None, cam_name=None, rtsp_id=None, batch_id=None, deployment_mode=None):
    """Persist camera state to rtsplinks.json under _rtsp_lock. Returns the assigned batch_id."""
    # Stage: persist camera running_status to rtsplinks.json so /Notifications can find active cameras
    logger.info(f"Updating rtsplinks.json | camera={camera_name} | running_status={running_status}")
    try:
        rtsplinks_path = os.path.join(main_dir, "rtsplinks.json")
        assigned_bid = 1
        with _rtsp_lock:
            if os.path.exists(rtsplinks_path):
                with open(rtsplinks_path, 'r') as f:
                    data = json.load(f)
            else:
                data = {}

            if rtsp_link:
                if rtsp_link not in data:
                    data[rtsp_link] = {}
                if cam_name:
                    data[rtsp_link]["cam_name"] = cam_name
                if running_status is not None:
                    data[rtsp_link]["running_status"] = running_status
                if rtsp_id is not None:
                    data[rtsp_link]["rtsp_id"] = str(rtsp_id)
                if deployment_mode is not None:
                    # Durable record of which container type this camera runs —
                    # not currently read back by anything (the /Notifications
                    # restart sweep tries every known suffix instead, since not
                    # every existing entry will have this field yet), but gives
                    # the registry a source of truth for future reconciliation
                    # logic instead of only ever knowing "the camera is running".
                    data[rtsp_link]["deployment_mode"] = deployment_mode
                if batch_id is not None:
                    data[rtsp_link]["batch_id"] = int(batch_id)
                elif "batch_id" not in data[rtsp_link]:
                    data[rtsp_link]["batch_id"] = _assign_batch_id(data)
                assigned_bid = int(data[rtsp_link].get("batch_id", 1))

            with open(rtsplinks_path, 'w') as f:
                json.dump(data, f, indent=4)

        logger.info(f"rtsplinks.json updated | camera={camera_name} | rtsp_link={rtsp_link} | batch_id={assigned_bid}")
        return assigned_bid
    except Exception as e:
        logger.error(f"Failed to update rtsplinks.json: {e}")
        return 1


def _rename_in_rtsplinks(old_name: str, new_name: str, rtsp_link: str) -> int:
    """Update cam_name in rtsplinks.json for a camera rename. Returns the camera's batch_id."""
    rtsp_path = os.path.join(main_dir, "rtsplinks.json")
    bid = 1
    try:
        with _rtsp_lock:
            with open(rtsp_path) as f:
                data = json.load(f)
            if rtsp_link and rtsp_link in data:
                data[rtsp_link]["cam_name"] = new_name
                bid = int(data[rtsp_link].get("batch_id", 1))
            else:
                for info in data.values():
                    if info.get("cam_name") == old_name:
                        info["cam_name"] = new_name
                        bid = int(info.get("batch_id", 1))
                        break
            with open(rtsp_path, 'w') as f:
                json.dump(data, f, indent=4)
        logger.info(f"rtsplinks.json renamed | {old_name} → {new_name} | batch_id={bid}")
    except Exception as e:
        logger.error(f"_rename_in_rtsplinks failed: {e}")
    return bid

# -------------------- CONTAINER CREATION --------------------

def create_deepstream_deployment(client, item: Item):
    """Single DeepStream pod per camera — NVDEC decode + TRT inference in one container."""
    if not item.fps:
        item.fps = 1.0
    alerts_str = " ".join(item.alerts) if item.alerts else " "
    logger.info(f"Creating deepstream_single container | camera={item.camera_name}")
    try:
        client.containers.run(
            image="dockerhubalgo/deepstream_service:latest",
            name=f"{item.camera_name}-deepstream",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            environment={
                "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
                "CAMERA_NAME":       item.camera_name,
                "RTSP_ID":           str(item.rtsp_id),
                "RTSP_URL":          item.rtsp_link,
                "OUTPUT_WIDTH":      str(item.output_width),
                "OUTPUT_HEIGHT":     str(item.output_height),
                "FPS":               str(item.fps),
                "SSIM_THRESH":       str(item.prefilter_threshold),
                "ANOMALY_DETECTION": str(item.anomaly_detection).lower(),
                "OBJECT_DETECTION":  str(item.object_detection).lower(),
                "MY_ALERTS":         alerts_str,
                "AKSHA_PATH":        "/Aksha",
                "ENABLE_GPU":        "true",
                "ENABLE_TENSORRT":   "true",
                "TRT_CACHE_PATH":    "/Aksha/trt_cache",
                "AUTOALERT_EMAIL_NOTIFICATION_SERVICE": str(item.email_auto_alert).lower(),
                "AUTOALERT_DISPLAY": str(item.display_auto_alert).lower(),
                "EMAIL_ALERT":       str(item.email_alert).lower(),
                "ALERT_DISPLAY":     str(item.display_alert).lower(),
            },
            volumes={
                HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
                "/etc/timezone":    {"bind": "/etc/timezone",  "mode": "ro"},
                "/etc/localtime":   {"bind": "/etc/localtime", "mode": "ro"},
            },
            device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
        )
        logger.info(f"Container started | name={item.camera_name}-deepstream")
        update_rtsp_status(camera_name=item.camera_name, rtsp_link=item.rtsp_link,
                           running_status=True, cam_name=item.camera_name,
                           deployment_mode="deepstream_single")
    except Exception as e:
        logger.exception(f"Failed to create {item.camera_name}-deepstream: {e}")
        raise


def signal_deepstream_batch(batch_ids):
    """
    Signal one or more deepstream pods to reload rtsplinks.json via POST /reload.
    Routes to deepstream-nvinfer{N} or deepstream-batch{N} based on DEEPSTREAM_SERVICE.
    batch_ids: int, or set/list of ints (1-indexed batch container numbers).
    BATCH_COUNT=1 and DEEPSTREAM_SERVICE=deepstream_batch uses "deepstream-batch" (backward compat).
    """
    import requests as _req
    if isinstance(batch_ids, int):
        batch_ids = {batch_ids}
    for bid in batch_ids:
        if DEEPSTREAM_SERVICE == "deepstream_nvinfer":
            container = f"deepstream-nvinfer{bid}"
        elif BATCH_COUNT == 1:
            container = "deepstream-batch"
        else:
            container = f"deepstream-batch{bid}"
        url = f"http://{container}:8080/reload"
        try:
            r = _req.post(url, timeout=5)
            logger.info(f"Reload signal sent | service={DEEPSTREAM_SERVICE} | batch_id={bid} | status={r.status_code}")
        except Exception as e:
            logger.warning(f"Reload signal failed | service={DEEPSTREAM_SERVICE} | batch_id={bid}: {e}")


def safe_delete_deepstream(client, name):
    """Stop the deepstream_single container for a camera if it exists."""
    for n in (f"{name}-deepstream",):
        try:
            c = client.containers.get(n)
            c.stop()
            c.remove()
            logger.info(f"Stopped and removed container: {n}")
        except docker.errors.NotFound:
            logger.info(f"Container not found (skipped): {n}")

def safe_delete_ppe(client, name):
    """Stop the PPE container for a camera if it exists."""
    for n in (f"{name}-ppe",):
        try:
            c = client.containers.get(n)
            c.stop()
            c.remove()
            logger.info(f"Stopped and removed container: {n}")
        except docker.errors.NotFound:
            logger.info(f"Container not found (skipped): {n}")

def safe_delete_jewelry(client, name):
    """Stop the jewelry detection container for a camera if it exists."""
    for n in (f"{name}-jewelry",):
        try:
            c = client.containers.get(n)
            c.stop()
            c.remove()
            logger.info(f"Stopped and removed container: {n}")
        except docker.errors.NotFound:
            logger.info(f"Container not found (skipped): {n}")


def create_deployment_object(client, item: Item):
    """Launch the frame_reader container for *item* (deployment_mode='frame_reader')."""
    # Stage: launch the frame_reader container for this camera
    if not item.update_camera_name:
        item.update_camera_name = item.camera_name
    if not item.fps:
        item.fps = 1.0

    logger.info(
        f"Creating frame_reader container | camera={item.camera_name} | rtsp={item.rtsp_link} "
        f"| fps={item.fps} | size={item.output_width}x{item.output_height} "
        f"| anomaly={item.anomaly_detection} | object_det={item.object_detection}"
    )

    time_delta = 10
    alerts_str = " ".join(item.alerts) if item.alerts else " "

    cmd = [
        "python3", "main.py",
        "--camera_name", item.camera_name,
        "--rtsp_id", str(item.rtsp_id),
        "--rtsp_url", item.rtsp_link,
        "--output_width", str(item.output_width),
        "--output_height", str(item.output_height),
        "--object_detection", str(item.object_detection),
        "--anomaly_detection", str(item.anomaly_detection),
        "--fps", str(item.fps),
        "--prefilter_threshold", str(item.prefilter_threshold)
    ]

    env = {
        "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
        "AKSHA_PATH": "/Aksha",
        "FPS": str(item.fps),
        "SSIM_THRESH": str(item.prefilter_threshold),
        "MY_ALERTS": alerts_str,
        "AUTOALERT_EMAIL_NOTIFICATION_SERVICE": str(item.email_auto_alert).lower(),
        "AUTOALERT_DISPLAY": str(item.display_auto_alert).lower(),
        "EMAIL_ALERT": str(item.email_alert).lower(),
        "ALERT_DISPLAY": str(item.display_alert).lower(),
        "TIME_DELTA": str(time_delta)
    }
    vols = {
        HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
        "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
        "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
    }

    try:
        # Stage: start container with restart=always so it survives host reboots
        client.containers.run(
            image="dockerhubalgo/frame_reader:latest",
            name=f"{item.camera_name}-rtsp",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            command=cmd,
            environment=env,
            volumes=vols
        )
        logger.info(f"Container started | name={item.camera_name}-rtsp | image=dockerhubalgo/frame_reader:latest")

        # Stage: record camera as running in the registry
        update_rtsp_status(
            camera_name=item.camera_name,
            rtsp_link=item.rtsp_link,
            running_status=True,
            cam_name=item.camera_name,
            deployment_mode="frame_reader"
        )
    except Exception as e:
        logger.exception(f"Failed to create container {item.camera_name}-rtsp: {e}")
        raise

def create_ppe_deployment_object(client, item: Item):
    """Launch the PPE detection container for *item* (deployment_mode='ppe')."""
    # Stage: launch the PPE container for this camera
    if not item.update_camera_name:
        item.update_camera_name = item.camera_name
    if not item.fps:
        item.fps = 1.0

    logger.info(
        f"Creating PPE container | camera={item.camera_name} | rtsp={item.rtsp_link} "
        f"| fps={item.fps} | size={item.output_width}x{item.output_height}"
    )

    cmd = [
        "python3", "app/main.py",
        "--camera_name", item.camera_name,
        "--rtsp_id", str(item.rtsp_id),
        "--rtsp_url", item.rtsp_link,
        "--output_width", str(item.output_width),
        "--output_height", str(item.output_height),
        "--fps", str(item.fps),
        "--prefilter_threshold", str(item.prefilter_threshold)
    ]

    env = {
        "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
        "AKSHA_PATH": "/Aksha",
        "FPS": str(item.fps),
        "SSIM_THRESH": str(item.prefilter_threshold),
    }
    vols = {
        HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
        "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
        "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
    }

    try:
        client.containers.run(
            image="dockerhubalgo/ppe_container:latest",
            name=f"{item.camera_name}-ppe",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            command=cmd,
            environment=env,
            volumes=vols
        )
        logger.info(f"Container started | name={item.camera_name}-ppe | image=dockerhubalgo/ppe_container:latest")

        update_rtsp_status(
            camera_name=item.camera_name,
            rtsp_link=item.rtsp_link,
            running_status=True,
            cam_name=item.camera_name,
            deployment_mode="ppe"
        )
    except Exception as e:
        logger.exception(f"Failed to create container {item.camera_name}-ppe: {e}")
        raise

def create_jewelry_deployment_object(client, item: Item):
    """Launch the jewelry detection container for *item* (deployment_mode='jewelry')."""
    # Stage: launch the jewelry container for this camera
    if not item.update_camera_name:
        item.update_camera_name = item.camera_name
    if not item.fps:
        item.fps = 1.0

    logger.info(
        f"Creating jewelry container | camera={item.camera_name} | rtsp={item.rtsp_link} "
        f"| fps={item.fps} | size={item.output_width}x{item.output_height}"
    )

    cmd = [
        "python3", "app/main.py",
        "--camera_name", item.camera_name,
        "--rtsp_id", str(item.rtsp_id),
        "--rtsp_url", item.rtsp_link,
        "--output_width", str(item.output_width),
        "--output_height", str(item.output_height),
        "--fps", str(item.fps),
        "--prefilter_threshold", str(item.prefilter_threshold)
    ]

    env = {
        "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
        "AKSHA_PATH": "/Aksha",
        "FPS": str(item.fps),
        "SSIM_THRESH": str(item.prefilter_threshold),
    }
    vols = {
        HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
        "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
        "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
    }

    # GPU is optional here (unlike deepstream_single, which requires one) — the
    # jewelry container itself auto-detects at runtime (torch.cuda.is_available())
    # and falls back to CPU, but Docker still needs an explicit device request to
    # ever expose a GPU to the container at all. Try with one first; on a
    # CPU-only host (no nvidia-container-toolkit) this request itself fails, so
    # fall back to a plain container rather than refusing to start the camera.
    run_kwargs = dict(
        image="dockerhubalgo/jewelry_container:latest",
        name=f"{item.camera_name}-jewelry",
        network="aksha-net",
        detach=True,
        restart_policy={"Name": "always"},
        command=cmd,
        environment=env,
        volumes=vols,
    )

    try:
        try:
            client.containers.run(
                device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
                **run_kwargs,
            )
            logger.info(f"Container started (GPU) | name={item.camera_name}-jewelry | image=dockerhubalgo/jewelry_container:latest")
        except docker.errors.APIError as gpu_err:
            logger.info(f"No GPU available for {item.camera_name}-jewelry, starting CPU-only: {gpu_err}")
            client.containers.run(**run_kwargs)
            logger.info(f"Container started (CPU) | name={item.camera_name}-jewelry | image=dockerhubalgo/jewelry_container:latest")

        update_rtsp_status(
            camera_name=item.camera_name,
            rtsp_link=item.rtsp_link,
            running_status=True,
            cam_name=item.camera_name,
            deployment_mode="jewelry"
        )
    except Exception as e:
        logger.exception(f"Failed to create container {item.camera_name}-jewelry: {e}")
        raise

def create_anomaly_model_deployment_object(client, cam: str):
    """Launch the anomaly model container for *cam*."""
    # Stage: launch the anomaly model container for this camera
    logger.info(f"Creating anomaly container | camera={cam}")
    try:
        client.containers.run(
            image="dockerhubalgo/anamoly_model_loader:latest",
            name=f"{cam}-anomaly",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            environment={
                "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
                "CAMERA_NAME": cam,
                "AKSHA_PATH": "/Aksha",
                "MONGODB_URI": "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false"
            },
            volumes={
                HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
                "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
                "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
            }
        )
        logger.info(f"Container started | name={cam}-anomaly | image=dockerhubalgo/anamoly_model_loader:latest")
    except Exception as e:
        logger.exception(f"Failed to create container {cam}-anomaly: {e}")

def create_face_rec_deployment(client, cam: str):
    """Launch the face recognition container for *cam* (optional, only when item.face_rec=True)."""
    # Stage: launch the face recognition container for this camera
    logger.info(f"Creating face recognition container | camera={cam}")
    try:
        client.containers.run(
            image="face_recognition:latest",
            name=f"{cam}-face",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            environment={
                "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
                "CAMERA_NAME": cam,
                "AKSHA_PATH": "/Aksha",
                "MONGODB_URI": "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false"
            },
            volumes={
                HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
                "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
                "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
            }
        )
        logger.info(f"Container started | name={cam}-face | image=face_recognition:latest")
    except Exception as e:
        logger.exception(f"Failed to create container {cam}-face: {e}")

def create_anpr_deployment(client, cam: str):
    """Launch the ANPR (licence plate recognition) container for *cam* (optional, only when item.anpr=True)."""
    # Stage: launch the ANPR (licence plate recognition) container for this camera
    logger.info(f"Creating ANPR container | camera={cam}")
    try:
        client.containers.run(
            image="anpr_service:latest",
            name=f"{cam}-anpr",
            network="aksha-net",
            detach=True,
            restart_policy={"Name": "always"},
            environment={
                "KAFKA_BOOTSTRAP_SERVERS": KAFKA_SERVER,
                "CAMERA_NAME": cam,
                "AKSHA_PATH": "/Aksha",
                "MONGODB_URI": "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false"
            },
            volumes={
                HOST_MACHINE_AKSHA: {"bind": "/Aksha", "mode": "rw"},
                "/etc/timezone": {"bind": "/etc/timezone", "mode": "ro"},
                "/etc/localtime": {"bind": "/etc/localtime", "mode": "ro"}
            }
        )
        logger.info(f"Container started | name={cam}-anpr | image=anpr_service:latest")
    except Exception as e:
        logger.exception(f"Failed to create container {cam}-anpr: {e}")

def restart_deployment(client, cam: str):
    """Restart all service containers for *cam* in-place (no teardown/recreate)."""
    # Stage: restart all service containers for a camera without removing them
    logger.info(f"Restarting all containers for camera={cam}")
    for n in (f"{cam}-rtsp", f"{cam}-anomaly", f"{cam}-face", f"{cam}-anpr"):
        try:
            client.containers.get(n).restart()
            logger.info(f"Restarted container: {n}")
        except docker.errors.NotFound:
            logger.info(f"Container not found (skipped): {n}")
        except Exception as e:
            logger.exception(f"Failed to restart container {n}: {e}")

# -------------------- SURVEILLANCE ENDPOINT --------------------

@app.post("/Surveillance")
async def camera_pod(surv: Surveillance):
    # Stage: entry — log operation type and number of cameras in request
    logger.info(f"POST /Surveillance | operation={surv.type} | camera_count={len(surv.camera_list)}")
    try:
        client = get_client()
        results = []
        _batch_reload_ids: set = set()  # signal only affected batch containers, once after the loop

        for it in surv.camera_list:
            logger.info(f"Processing camera | camera={it.camera_name} | operation={surv.type}")

            if surv.type == Operation.create:
                logger.info(
                    f"[CREATE] camera={it.camera_name} | mode={it.deployment_mode}")
                if it.deployment_mode == "deepstream_single":
                    safe_delete_deepstream(client, it.camera_name)
                    create_deepstream_deployment(client, it)
                elif it.deployment_mode in ("deepstream_batch", "deepstream_nvinfer"):
                    bid = update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                             running_status=True, cam_name=it.camera_name,
                                             rtsp_id=str(it.rtsp_id) if it.rtsp_id is not None else it.camera_name)
                    _batch_reload_ids.add(bid)
                elif it.deployment_mode == "ppe":
                    safe_delete_ppe(client, it.camera_name)
                    create_ppe_deployment_object(client, it)
                elif it.deployment_mode == "jewelry":
                    safe_delete_jewelry(client, it.camera_name)
                    create_jewelry_deployment_object(client, it)
                else:
                    safe_delete(client, it.camera_name)
                    create_deployment_object(client, it)
                if it.face_rec:
                    create_face_rec_deployment(client, it.camera_name)
                if it.anpr:
                    create_anpr_deployment(client, it.camera_name)
                results.append({"camera": it.camera_name, "status": "started"})
                logger.info(f"[CREATE] Complete | camera={it.camera_name}")

            elif surv.type == Operation.update:
                logger.info(
                    f"[UPDATE] camera={it.camera_name} | mode={it.deployment_mode}")
                if it.deployment_mode == "deepstream_single":
                    safe_delete_deepstream(client, it.camera_name)
                    create_deepstream_deployment(client, it)
                elif it.deployment_mode in ("deepstream_batch", "deepstream_nvinfer"):
                    bid = update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                             running_status=True, cam_name=it.camera_name,
                                             rtsp_id=str(it.rtsp_id) if it.rtsp_id is not None else it.camera_name)
                    _batch_reload_ids.add(bid)
                elif it.deployment_mode == "ppe":
                    safe_delete_ppe(client, it.camera_name)
                    create_ppe_deployment_object(client, it)
                elif it.deployment_mode == "jewelry":
                    safe_delete_jewelry(client, it.camera_name)
                    create_jewelry_deployment_object(client, it)
                else:
                    safe_delete(client, it.camera_name)
                    create_deployment_object(client, it)
                if it.face_rec:
                    create_face_rec_deployment(client, it.camera_name)
                if it.anpr:
                    create_anpr_deployment(client, it.camera_name)
                results.append({"camera": it.camera_name, "status": "updated"})
                logger.info(f"[UPDATE] Complete | camera={it.camera_name}")

            elif surv.type == Operation.restart:
                logger.info(f"[RESTART] camera={it.camera_name} | mode={it.deployment_mode}")
                is_rename = bool(it.update_camera_name and it.update_camera_name != it.camera_name)

                if it.deployment_mode in ("deepstream_batch", "deepstream_nvinfer"):
                    if is_rename:
                        bid = _rename_in_rtsplinks(it.camera_name, it.update_camera_name, it.rtsp_link)
                    else:
                        bid = update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                                 running_status=True, cam_name=it.camera_name)
                    _batch_reload_ids.add(bid)
                    results.append({"camera": it.update_camera_name or it.camera_name, "status": "restarted"})

                elif it.deployment_mode == "deepstream_single":
                    safe_delete_deepstream(client, it.camera_name)
                    if is_rename:
                        new_item = it.copy(update={"camera_name": it.update_camera_name})
                        update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                           running_status=False, cam_name=it.camera_name)
                        create_deepstream_deployment(client, new_item)
                    else:
                        create_deepstream_deployment(client, it)
                    results.append({"camera": it.update_camera_name or it.camera_name, "status": "restarted"})

                elif it.deployment_mode == "ppe":
                    safe_delete_ppe(client, it.camera_name)
                    if is_rename:
                        new_item = it.copy(update={"camera_name": it.update_camera_name})
                        update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                        running_status=False, cam_name=it.camera_name)
                        create_ppe_deployment_object(client, new_item)
                    else:
                        create_ppe_deployment_object(client, it)
                    results.append({"camera": it.update_camera_name or it.camera_name, "status": "restarted"})

                elif it.deployment_mode == "jewelry":
                    safe_delete_jewelry(client, it.camera_name)
                    if is_rename:
                        new_item = it.copy(update={"camera_name": it.update_camera_name})
                        update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                        running_status=False, cam_name=it.camera_name)
                        create_jewelry_deployment_object(client, new_item)
                    else:
                        create_jewelry_deployment_object(client, it)
                    results.append({"camera": it.update_camera_name or it.camera_name, "status": "restarted"})

                else:
                    if is_rename:
                        safe_delete(client, it.camera_name)
                        new_item = it.copy(update={"camera_name": it.update_camera_name})
                        create_deployment_object(client, new_item)
                    else:
                        restart_deployment(client, it.camera_name)
                    results.append({"camera": it.update_camera_name or it.camera_name, "status": "restarted"})

                logger.info(f"[RESTART] Complete | camera={it.update_camera_name or it.camera_name}")

            elif surv.type == Operation.delete:
                logger.info(
                    f"[DELETE] camera={it.camera_name} | mode={it.deployment_mode}")
                if it.deployment_mode == "deepstream_single":
                    safe_delete_deepstream(client, it.camera_name)
                elif it.deployment_mode in ("deepstream_batch", "deepstream_nvinfer"):
                    bid = update_rtsp_status(camera_name=it.camera_name, rtsp_link=it.rtsp_link,
                                             running_status=False, cam_name=it.camera_name)
                    _batch_reload_ids.add(bid)
                elif it.deployment_mode == "ppe":
                    safe_delete_ppe(client, it.camera_name)
                elif it.deployment_mode == "jewelry":
                    safe_delete_jewelry(client, it.camera_name)
                else:
                    safe_delete(client, it.camera_name)
                cam_dir = os.path.join(main_dir, it.camera_name) if main_dir else None
                if cam_dir and os.path.exists(cam_dir):
                    try:
                        shutil.rmtree(cam_dir)
                        logger.info(f"Removed camera directory: {cam_dir}")
                    except Exception as e:
                        logger.error(f"Failed to remove camera directory {cam_dir}: {e}")
                else:
                    logger.warning(f"Camera directory not found, skipping delete: {cam_dir}")

                if it.rtsp_link and it.deployment_mode not in ("deepstream_batch", "deepstream_nvinfer"):
                    update_rtsp_status(
                        camera_name=it.camera_name,
                        rtsp_link=it.rtsp_link,
                        running_status=False,
                        cam_name=it.camera_name
                    )
                elif not it.rtsp_link:
                    logger.warning(f"No rtsp_link provided for camera {it.camera_name} — cannot update rtsplinks.json")

                results.append({"camera": it.camera_name, "status": "stopped"})
                logger.info(f"[DELETE] Complete | camera={it.camera_name}")

        # Signal only the affected pods, once after all rtsplinks.json writes are done
        if _batch_reload_ids:
            signal_deepstream_batch(_batch_reload_ids)
            logger.info(f"Reload sent | service={DEEPSTREAM_SERVICE} | containers={sorted(_batch_reload_ids)} | cameras={len(surv.camera_list)}")

        logger.info(f"POST /Surveillance complete | results={results}")
        return {"ok": True, "results": results}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Camera pod operation failed: {e}")
        raise HTTPException(500, str(e))

# -------------------- INSIGHT (HEATMAP) --------------------

@app.post("/Insight")
def Insight(item: Insight):
    # Stage: generate a heatmap for the requested camera and time window
    logger.info(
        f"POST /Insight | camera={item.camera_name} | "
        f"from={item.start_date} {item.start_time} | to={item.end_date} {item.end_time}"
    )
    camera_name = item.camera_name
    start_date = item.start_date
    start_time = item.start_time
    end_date = item.end_date
    end_time = item.end_time

    try:
        startingtime = time.time()
        from . import insight
        logger.info(f"Calling create_heatmap | camera={camera_name}")
        result = insight.create_heatmap(
            Start_date=start_date, Start_time=start_time,
            End_date=end_date, End_time=end_time,
            Camera_name=camera_name, work_dir=main_dir, logger=logger
        )
        endingtime = time.time()
        logger.info(f"Insight complete | camera={camera_name} | elapsed={endingtime - startingtime:.2f}s")
    except Exception as e:
        logger.error(f"create_heatmap failed | camera={camera_name} | error={e}")
        raise HTTPException(status_code=500, detail=f"Create_heatmap() function facing issue, {e}")
    if result and result.startswith(("No frames found", "Failed to")):
        raise HTTPException(status_code=422, detail=result)
    return f"Result processed for Insight(Heatmap)"

# -------------------- ALERT REPORT ANALYZER --------------------

@app.post("/AlertReportAnalyzer")
def call_alert_report_analyzer(req: AlertReportAnalyzer):
    # Stage: run LLM-based analysis over a filtered alert dataset
    logger.info(
        f"POST /AlertReportAnalyzer | model={req.model_option} | lang={req.lang_option} "
        f"| from={req.start_date} | to={req.end_date}"
    )
    try:
        from . import alert_report_analyzer
        logger.info("Calling alert_report_analyzer.alert_report_analyzer()")
        report_analysis_result, mimetype, status_code = alert_report_analyzer.alert_report_analyzer(
            filtered_data=req.filtered_data,
            start_date=req.start_date,
            end_date=req.end_date,
            model_option=req.model_option,
            lang_option=req.lang_option
        )
        logger.info(f"AlertReportAnalyzer complete | status={status_code} | mimetype={mimetype}")
        return JSONResponse(content=report_analysis_result, status_code=status_code, media_type=mimetype)
    except Exception as e:
        logger.error(f"Error in call_alert_report_analyzer: {e}")
        raise HTTPException(500, f"Error in call_alert_report_analyzer function: {e}")

# -------------------- IMAGE ANALYSIS --------------------

@app.post("/ImageAnalysis")
def call_image_analysis(req: ImageAnalysis):
    # Stage: answer a question about an image using the selected model
    logger.info(
        f"POST /ImageAnalysis | model={req.model_option} | "
        f"question='{req.question[:80]}' | history_len={len(req.chat_history)}"
    )
    try:
        chat_history = req.chat_history if len(req.chat_history) != 0 else None
        from . import image_analysis
        logger.info("Calling image_analysis.imageanalysis()")
        model_response, mimetype, status_code = image_analysis.imageanalysis(
            question=req.question,
            image=req.image,
            model_option=req.model_option,
            chat_history=chat_history
        )
        logger.info(f"ImageAnalysis complete | status={status_code} | mimetype={mimetype}")
        return JSONResponse(content=model_response, status_code=status_code, media_type=mimetype)
    except Exception as e:
        logger.error(f"Error in call_image_analysis: {e}")
        raise HTTPException(500, f"Error in call_image_analysis function: {e}")

# -------------------- DOWNLOAD IMAGE ANALYSIS CHAT LOGS --------------------

@app.post("/DownloadImageAnalysisChat")
def call_download_image_analysis_chat_logs(req: DownloadImageAnalysisChat):
    # Stage: package image + chat history into a zip and return as a streaming download
    logger.info(f"POST /DownloadImageAnalysisChat | history_len={len(req.chat_history)}")
    try:
        chat_history = req.chat_history if len(req.chat_history) != 0 else None

        if chat_history is None:
            logger.warning("DownloadImageAnalysisChat called with empty chat history")
            raise HTTPException(400, "No chat messages found.")

        from . import image_analysis
        logger.info("Calling image_analysis.download_image_analysis_chat_logs()")
        zip_buffer, headers, status_code = image_analysis.download_image_analysis_chat_logs(
            b64img=req.image,
            chat_history=chat_history
        )

        if status_code == 200:
            logger.info("DownloadImageAnalysisChat complete — returning zip stream")
            return StreamingResponse(zip_buffer, headers=headers, media_type="application/zip", status_code=200)
        else:
            logger.error(f"DownloadImageAnalysisChat failed | status={status_code}")
            raise HTTPException(status_code, zip_buffer)
    except Exception as e:
        logger.error(f"Error in call_download_image_analysis_chat_logs: {e}")
        raise HTTPException(500, f"Error in call_download_image_analysis_chat_logs function: {e}")

# -------------------- ENTRYPOINT --------------------

if __name__ == "__main__":
    logger.info("Starting uvicorn on 0.0.0.0:4000")
    uvicorn.run(app, host="0.0.0.0", port=4000)
