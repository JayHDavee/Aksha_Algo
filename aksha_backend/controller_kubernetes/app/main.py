"""
controller_kubernetes — Kubernetes-native camera deployment orchestrator.

  POST /Surveillance  — start / update / restart / stop cameras
    deployment_mode="frame_reader"       → k8s Deployment per camera (frame_reader image)
    deployment_mode="deepstream_single"  → k8s Deployment per camera (deepstream_service + GPU)
    deployment_mode="deepstream_batch"   → dynamic Deployment per batch + rtsplinks.json + /reload
    deployment_mode="deepstream_nvinfer" → dynamic Deployment per batch + rtsplinks.json + /reload

  Dynamic pod spawning (batch/nvinfer modes):
    • Starts with 0 batches. First camera → spawn batch 1.
    • Each batch holds up to MAX_CAMERAS_PER_POD cameras (default 10).
    • When all batches are full → spawn a new batch Deployment (max existing + 1).
    • Each batch is its OWN single-replica Deployment (not a StatefulSet ordinal) —
      needed because these pods run with hostNetwork (Calico's pod CIDR collides
      with the camera LAN) and a StatefulSet's one shared pod template can't give
      different ordinals different ports. BATCH_ID and the pod's actual port
      are just fixed values in each batch's own manifest — no ordinal-derivation
      trick needed. Naming/ports stay 0-based like the old StatefulSet ordinals:
      batch_id=1 → deepstream-batch-0 → port 8080, batch_id=2 → deepstream-batch-1
      → port 8081, and so on.
    • Scale-down is manual (Phase 2) — any batch_id can be removed independently
      once it has no running cameras (no StatefulSet "highest ordinal only" limit).

  Environment variables (controller):
    AKSHA_PATH                  path inside pod where Aksha data is mounted (/Aksha)
    HOST_MACHINE_AKSHA_PATH     host path for hostPath volumes (fallback to AKSHA_PATH)
    AKSHA_PVC_NAME              PVC name to mount at AKSHA_PATH (preferred over hostPath)
    GPU_NODE_LABEL              node label key=value that identifies a GPU-capable node
                                 (optional but strongly recommended on multi-node clusters
                                 — without it the scheduler may place a batch pod on a
                                 node with no GPU at all). Deliberately a label, not a
                                 hostname — a hostname pin can only ever mean "this one
                                 named machine," so a newly-added GPU node would never
                                 receive any batch pods; a label match picks up any
                                 node carrying it, present or future.
                                 e.g. GPU_NODE_LABEL=nvidia.com/gpu.present=true adds
                                 nodeSelector: {nvidia.com/gpu.present: "true"} to every
                                 batch pod spec. GPU_NODE_NAME=<hostname> still works as
                                 a shorthand for kubernetes.io/hostname=<hostname>.
    MAX_CAMERAS_PER_POD         cameras per DeepStream pod before spawning next      (10)
    MAX_BATCHES_PER_GPU_NODE    hard cap on total batch pods (both modes combined)
                                 before refusing to spawn another — 0 disables the cap.
                                 Treats "all batches" as sharing one GPU node pool,
                                 since GPU_NODE_SELECTOR doesn't currently track which
                                 physical node each batch actually landed on            (0)
    AUTO_REBALANCE              "true" to run _reconcile_batches automatically after
                                 every camera delete; "false" (default) means
                                 consolidation only happens when POST /pods/{mode}/reconcile
                                 is called explicitly — test manually before enabling  (false)
    DS_IMAGE                    deepstream_nvinfer image used when creating pods
    DS_BATCH_IMAGE              deepstream_batch image used when creating pods
    DEEPSTREAM_SERVICE          default DS mode                      (deepstream_nvinfer)
    K8S_NAMESPACE               namespace for all k8s resources               (default)
    KAFKA_BOOTSTRAP_SERVERS     Kafka broker                              (broker:9092)
    DS_POD_PORT                 base port; ordinal N's actual port is this + N   (8080)
    MONGODB_URI                 MongoDB connection string
    DS_BATCH_TIMEOUT_MS         nvstreammux batched-push-timeout in ms          (300)
    DS_SOURCE_FPS               per-source FPS for nvinfer mode                  (25)
    DS_INFER_INTERVAL           nvinfer interval (0 = every frame)               (0)
    DS_CONF_THRESHOLD           detection confidence threshold                 (0.35)
    DS_PUBLISH_LIVE_IMAGE       publish JPEG frames to Kafka            (true)
    DS_PUBLISH_RAW_FRAME        publish raw BGR frames to Kafka        (false)
    DS_FAST_PREFILTER           batch mode motion prefilter             (true)
    DS_ADAPTIVE_SKIP_RATIO      batch mode adaptive-skip ratio               (4)
    DS_ADAPTIVE_BURST_FRAMES    batch mode burst frame count                 (2)
    DS_ENABLE_TENSORRT          enable TensorRT in batch mode           (true)
    DS_ENABLE_TRT_FP16          enable FP16 TRT in batch mode          (false)
"""

import os, json, time, threading, tempfile, logging, shutil, math
import concurrent.futures
from typing import List, Optional
from enum import Enum

import requests as _req
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, PlainTextResponse
from pydantic import BaseModel
import uvicorn

try:
    from kubernetes import client as k8s_client, config as k8s_config
    _K8S_AVAILABLE = True
except ImportError:
    _K8S_AVAILABLE = False

# ── env & paths ───────────────────────────────────────────────────────────────

AKSHA_PATH      = os.environ.get("AKSHA_PATH",              "/Aksha")
HOST_AKSHA_PATH = os.environ.get("HOST_MACHINE_AKSHA_PATH", AKSHA_PATH)
AKSHA_PVC_NAME  = os.environ.get("AKSHA_PVC_NAME",          "")

logger_path = f"{AKSHA_PATH}/log"
os.makedirs(logger_path, exist_ok=True)

logging.basicConfig(
    filename=f"{logger_path}/controller_k8s.log",
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    filemode="a",
)
logger = logging.getLogger("controller_k8s")

# ── config ────────────────────────────────────────────────────────────────────

MAX_CAMERAS_PER_POD    = int(os.environ.get("MAX_CAMERAS_PER_POD", "10"))
MAX_BATCHES_PER_GPU_NODE = int(os.environ.get("MAX_BATCHES_PER_GPU_NODE", "0"))  # 0 = no cap
AUTO_REBALANCE         = os.environ.get("AUTO_REBALANCE", "false").strip().lower() == "true"
DEEPSTREAM_SERVICE  = os.environ.get("DEEPSTREAM_SERVICE",      "deepstream_batch")
K8S_NAMESPACE       = os.environ.get("K8S_NAMESPACE",           "default")
KAFKA_SERVER        = os.environ.get("KAFKA_BOOTSTRAP_SERVERS",
                          "aksha-kafka-kafka-bootstrap.default.svc.cluster.local:9092")
DS_POD_PORT         = int(os.environ.get("DS_POD_PORT",         "8080"))
MONGODB_URI         = os.environ.get("MONGODB_URI",
                          "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false")

DS_IMAGE       = os.environ.get("DS_IMAGE",       "dockerhubalgo/deepstream_nvinfer:24072026-34")
DS_BATCH_IMAGE = os.environ.get("DS_BATCH_IMAGE", "dockerhubalgo/deepstream_batch:latest")

# ── DS pod env var overrides (match docker-compose defaults) ──────────────────
# nvinfer-specific
DS_BATCH_TIMEOUT_MS  = os.environ.get("DS_BATCH_TIMEOUT_MS",  "300")
DS_SOURCE_FPS        = os.environ.get("DS_SOURCE_FPS",        "25")
DS_INFER_INTERVAL    = os.environ.get("DS_INFER_INTERVAL",    "0")
DS_CONF_THRESHOLD    = os.environ.get("DS_CONF_THRESHOLD",    "0.35")
DS_PUBLISH_LIVE      = os.environ.get("DS_PUBLISH_LIVE_IMAGE","true")
DS_PUBLISH_RAW       = os.environ.get("DS_PUBLISH_RAW_FRAME", "false")
# batch-specific
DS_FAST_PREFILTER    = os.environ.get("DS_FAST_PREFILTER",        "true")
DS_ADAPTIVE_SKIP     = os.environ.get("DS_ADAPTIVE_SKIP_RATIO",   "4")
DS_ADAPTIVE_BURST    = os.environ.get("DS_ADAPTIVE_BURST_FRAMES", "2")
DS_ENABLE_TENSORRT   = os.environ.get("DS_ENABLE_TENSORRT",       "true")
DS_ENABLE_TRT_FP16   = os.environ.get("DS_ENABLE_TRT_FP16",       "false")

RTSP_PATH = os.path.join(AKSHA_PATH, "rtsplinks.json")

_STS_NAMES = {
    "deepstream_nvinfer": "deepstream-nvinfer",
    "deepstream_batch":   "deepstream-batch",
}

_DS_IMAGES = {
    "deepstream_nvinfer": DS_IMAGE,
    "deepstream_batch":   DS_BATCH_IMAGE,
}

# ── kubernetes API helpers ────────────────────────────────────────────────────

def _load_k8s():
    if not _K8S_AVAILABLE:
        raise RuntimeError("kubernetes package not installed")
    try:
        k8s_config.load_incluster_config()
    except k8s_config.ConfigException:
        k8s_config.load_kube_config()

def _apps_v1():
    _load_k8s()
    return k8s_client.AppsV1Api()

def _core_v1():
    _load_k8s()
    return k8s_client.CoreV1Api()

# ── volume helpers ────────────────────────────────────────────────────────────

def _aksha_volume():
    if AKSHA_PVC_NAME:
        vol = {"name": "aksha-data", "persistentVolumeClaim": {"claimName": AKSHA_PVC_NAME}}
    else:
        vol = {"name": "aksha-data", "hostPath": {"path": HOST_AKSHA_PATH, "type": "DirectoryOrCreate"}}
    mnt = {"name": "aksha-data", "mountPath": AKSHA_PATH}
    return vol, mnt

def _trt_cache_mount():
    # Same aksha-data volume/PVC, explicitly mounted at its trt_cache
    # subdirectory so it shows up as its own entry (e.g. in `kubectl describe
    # pod`) instead of being implicit inside the root AKSHA_PATH mount.
    return {"name": "aksha-data", "mountPath": f"{AKSHA_PATH}/trt_cache", "subPath": "trt_cache"}

def _tz_volumes():
    vols = [
        {"name": "tz",  "hostPath": {"path": "/etc/timezone"}},
        {"name": "lct", "hostPath": {"path": "/etc/localtime"}},
    ]
    mnts = [
        {"name": "tz",  "mountPath": "/etc/timezone",  "readOnly": True},
        {"name": "lct", "mountPath": "/etc/localtime", "readOnly": True},
    ]
    return vols, mnts

# ── batch pods — one Deployment per batch_id ──────────────────────────────────
#
# Each batch is its own single-replica Deployment, not a StatefulSet ordinal.
# Why: these pods run with hostNetwork (Calico's pod CIDR 192.168.0.0/16
# collides with the camera LAN, so overlay-routed traffic to on-LAN cameras
# was silently dropped — hostNetwork bypasses the overlay for these pods
# entirely). Under hostNetwork, every declared containerPort is a real claim
# on the node's own port space, and a StatefulSet uses ONE shared pod template
# for every ordinal — there is no way to give ordinal 0 port 8081 and ordinal
# 1 port 8082 in a single template, so a second batch pod always collided
# with the first on the same port. A separate Deployment per batch_id has its
# own manifest, so each can declare its own port (DS_POD_PORT_BASE +
# batch_id) — mirroring the old docker-compose file's 8081:8080, 8082:8080,
# ... per-container port mapping.

# 0-based ordinal, matching the old StatefulSet's pod-0/pod-1/... naming:
# batch_id=1 → deepstream-batch-0 → port 8080, batch_id=2 → deepstream-batch-1
# → port 8081, and so on.
DS_POD_PORT_BASE = DS_POD_PORT   # ordinal N's actual port = DS_POD_PORT_BASE + N

# Both deepstream_batch and deepstream_nvinfer pods are pinned to the same
# GPU_NODE_SELECTOR and run under hostNetwork, so their ports share one real
# OS port space on that node. Without a per-mode offset, mode="deepstream_batch"
# batch_id=1 and mode="deepstream_nvinfer" batch_id=1 would both compute
# DS_POD_PORT_BASE + 0 and collide the instant both modes are active at once —
# the exact class of bug the whole per-batch-Deployment redesign exists to
# prevent, just recreated across modes instead of across ordinals. 1000 is an
# arbitrary gap comfortably larger than any realistic batch count.
_MODE_PORT_OFFSET = {
    "deepstream_batch":   0,
    "deepstream_nvinfer": 1000,
}

def _gpu_node_selector() -> dict:
    """
    nodeSelector dict for GPU-capable nodes, or {} if unset (no pinning).

    GPU_NODE_LABEL="key=value" is the general form — matches any node
    carrying that label, present or future, so a node autoscaler/manually
    added GPU machine is picked up automatically as long as it's labeled the
    same way. GPU_NODE_NAME=<hostname> is kept as a shorthand for the old
    single-node pin (kubernetes.io/hostname=<hostname>) — fine for a
    single-GPU-node cluster, but note a hostname can only ever mean one
    specific machine, so it does NOT benefit from node-count autoscaling the
    way a label does.
    """
    label = os.environ.get("GPU_NODE_LABEL", "")
    if label:
        if "=" not in label:
            raise RuntimeError(f'GPU_NODE_LABEL must be "key=value", got: {label!r}')
        key, value = label.split("=", 1)
        return {key: value}
    name = os.environ.get("GPU_NODE_NAME", "")
    if name:
        return {"kubernetes.io/hostname": name}
    return {}

GPU_NODE_SELECTOR = _gpu_node_selector()

def _batch_deployment_name(deployment_mode: str, batch_id: int) -> str:
    return f"{_STS_NAMES[deployment_mode]}-{batch_id - 1}"

def _batch_port(deployment_mode: str, batch_id: int) -> int:
    return DS_POD_PORT_BASE + _MODE_PORT_OFFSET[deployment_mode] + (batch_id - 1)

def _ds_env(deployment_mode: str, batch_id: int) -> list:
    """
    Build the full env list for a DS pod. BATCH_ID and DS_POD_PORT are fixed,
    known values (one Deployment per batch) — no ordinal-derivation needed.

    GPU sharing: NVIDIA_VISIBLE_DEVICES=all (no nvidia.com/gpu resource limit)
    so multiple DS pods can share the same physical GPU simultaneously.
    """
    common = [
        {"name": "BATCH_ID",                "value": str(batch_id)},
        {"name": "DS_POD_PORT",             "value": str(_batch_port(deployment_mode, batch_id))},
        {"name": "KAFKA_BOOTSTRAP_SERVERS", "value": KAFKA_SERVER},
        {"name": "MONGODB_URI",             "value": MONGODB_URI},
        {"name": "AKSHA_PATH",              "value": AKSHA_PATH},
        {"name": "TRT_CACHE_PATH",          "value": f"{AKSHA_PATH}/trt_cache"},
        {"name": "MAX_CAMERAS",             "value": str(MAX_CAMERAS_PER_POD)},
        {"name": "BATCH_TIMEOUT_MS",        "value": DS_BATCH_TIMEOUT_MS},
        {"name": "PUBLISH_LIVE_IMAGE",      "value": DS_PUBLISH_LIVE},
        {"name": "PUBLISH_RAW_FRAME",       "value": DS_PUBLISH_RAW},
        # Tells the pod to resolve the Node backend at "node-backend" (k8s Service
        # names can't contain underscores) instead of Compose's "node_backend".
        {"name": "DEPLOYMENT_PLATFORM",     "value": "kubernetes"},
        # GPU sharing — all pods see the full GPU; no exclusive resource claim
        {"name": "NVIDIA_VISIBLE_DEVICES",      "value": "all"},
        {"name": "NVIDIA_DRIVER_CAPABILITIES",  "value": "compute,video,utility"},
        {"name": "TZ",                          "value": "Asia/Kolkata"},
    ]

    if deployment_mode == "deepstream_nvinfer":
        common += [
            {"name": "SOURCE_FPS",     "value": DS_SOURCE_FPS},
            {"name": "INFER_INTERVAL", "value": DS_INFER_INTERVAL},
            {"name": "CONF_THRESHOLD", "value": DS_CONF_THRESHOLD},
        ]

    if deployment_mode == "deepstream_batch":
        common += [
            {"name": "FAST_PREFILTER",     "value": DS_FAST_PREFILTER},
            {"name": "ADAPTIVE_SKIP_RATIO",   "value": DS_ADAPTIVE_SKIP},
            {"name": "ADAPTIVE_BURST_FRAMES", "value": DS_ADAPTIVE_BURST},
            {"name": "ENABLE_GPU",         "value": "true"},
            {"name": "ENABLE_TENSORRT",    "value": DS_ENABLE_TENSORRT},
            {"name": "ENABLE_TRT_FP16",    "value": DS_ENABLE_TRT_FP16},
        ]

    return common

def _build_batch_deployment(deployment_mode: str, batch_id: int) -> dict:
    """
    Build a single-replica Deployment for one batch_id, with its own port
    (see _batch_port) so it never collides with any other batch's Deployment
    on the same GPU node under hostNetwork.

    GPU sharing: NVIDIA_VISIBLE_DEVICES=all is set in env. No nvidia.com/gpu
    resource limit is claimed, so many batch Deployments can share the same
    physical GPU via the NVIDIA container runtime.

    Node-autoscaling implication: because no nvidia.com/gpu resource request
    exists, a batch pod that can't fit on current GPU capacity does NOT
    become "Pending: insufficient nvidia.com/gpu" — there's no k8s-visible
    signal that GPU capacity is exhausted, so cluster-autoscaler/Karpenter has
    nothing to react to on its own. GPU_NODE_SELECTOR (see _gpu_node_selector)
    only controls WHICH nodes are eligible, not WHEN more are needed — that
    part is a capacity-planning judgment call (how many batches one GPU can
    actually take) this controller does not attempt to infer automatically.
    Treat aksha_required_batches (GET /metrics) as the signal to act on
    manually, or to feed into whatever autoscaling tooling you add.
    """
    name  = _batch_deployment_name(deployment_mode, batch_id)
    image = _DS_IMAGES[deployment_mode]
    port  = _batch_port(deployment_mode, batch_id)
    aksha_vol, aksha_mnt = _aksha_volume()
    tz_vols, tz_mnts     = _tz_volumes()

    pod_spec = {
        # See the module-level comment above for why hostNetwork is needed.
        # ClusterFirstWithHostNet keeps cluster DNS (mongodb, kafka,
        # node-backend) resolvable, which plain hostNetwork alone would break.
        "hostNetwork": True,
        "dnsPolicy":   "ClusterFirstWithHostNet",
        "containers": [{
            "name":            name,
            "image":           image,
            "imagePullPolicy": "Always",
            "ports":           [{"containerPort": port, "name": "http"}],
            "env": _ds_env(deployment_mode, batch_id),
            # No nvidia.com/gpu limit — GPU is shared between pods
            # via NVIDIA_VISIBLE_DEVICES=all in env above
            "volumeMounts": [aksha_mnt, _trt_cache_mount()] + tz_mnts,
            "livenessProbe": {
                "httpGet": {"path": "/health", "port": port},
                "initialDelaySeconds": 1200,  # TRT engine compile time
                "periodSeconds": 30,
                "timeoutSeconds": 5,
                "failureThreshold": 3,
            },
            "readinessProbe": {
                "httpGet": {"path": "/health", "port": port},
                "initialDelaySeconds": 30,
                "periodSeconds": 15,
                "timeoutSeconds": 5,
                "failureThreshold": 5,
            },
        }],
        "volumes": [aksha_vol] + tz_vols,
    }
    if GPU_NODE_SELECTOR:
        # Restrict every batch pod to GPU-capable nodes — without this the
        # scheduler may try a node with no GPU at all (fails permanently, see
        # the algo23/algo40 2-node cluster case) or thrash between nodes. A
        # label selector (vs. a hardcoded hostname) is what lets a newly added
        # GPU machine actually receive batch pods without a config change.
        pod_spec["nodeSelector"] = GPU_NODE_SELECTOR

    return {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {
            "name": name, "namespace": K8S_NAMESPACE,
            "labels": {"app": name, "managed-by": "aksha-controller",
                       "mode": deployment_mode, "batch_id": str(batch_id)},
        },
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name, "mode": deployment_mode,
                                         "batch_id": str(batch_id)}},
                "spec": pod_spec,
            },
        },
    }

def _list_batch_ids(deployment_mode: str) -> list:
    """All batch_ids that currently have a Deployment, ascending."""
    try:
        deps = _apps_v1().list_namespaced_deployment(
            K8S_NAMESPACE,
            label_selector=f"mode={deployment_mode},managed-by=aksha-controller",
        ).items
    except k8s_client.ApiException:
        return []
    ids = []
    for d in deps:
        bid = (d.metadata.labels or {}).get("batch_id")
        if bid is not None:
            ids.append(int(bid))
    return sorted(ids)

def _batch_is_healthy(deployment_mode: str, batch_id: int) -> bool:
    """True once the batch's Deployment reports at least one Ready replica."""
    try:
        dep = _apps_v1().read_namespaced_deployment(
            _batch_deployment_name(deployment_mode, batch_id), K8S_NAMESPACE
        )
        return (dep.status.ready_replicas or 0) >= 1
    except k8s_client.ApiException:
        return False

# Generous — a cold pod may need to compile a TRT engine from scratch (up to
# ~20 min per the liveness probe's initialDelaySeconds), so this can't be a
# short bounded wait. It only backstops the immediate /reload already sent
# right after creation (which fails harmlessly if the pod isn't up yet) —
# it's not the only way cameras reach a new batch.
_NEW_BATCH_READY_TIMEOUT = 1500

def _wait_then_reload(deployment_mode: str, batch_id: int):
    """
    PHASE 2 safe scale-up, step 2/2: poll a brand-new batch until it's Ready,
    then send /reload. Runs in a background thread (started by
    _ensure_batch_deployment right after creation) so the HTTP request that
    triggered the new batch doesn't block on a potentially 20-minute cold
    start. Bounded by _NEW_BATCH_READY_TIMEOUT so a permanently-unschedulable
    pod doesn't leak a thread forever.
    """
    deadline = time.monotonic() + _NEW_BATCH_READY_TIMEOUT
    while time.monotonic() < deadline:
        if _batch_is_healthy(deployment_mode, batch_id):
            logger.info(
                f"[SAFE-SCALE-UP] Batch ready — reloading | "
                f"mode={deployment_mode} batch={batch_id}"
            )
            signal_pods(deployment_mode, {batch_id}, "/reload")
            return
        time.sleep(5)
    logger.warning(
        f"[SAFE-SCALE-UP] Gave up waiting for batch to become ready after "
        f"{_NEW_BATCH_READY_TIMEOUT}s | mode={deployment_mode} batch={batch_id}"
    )

def _total_batch_count() -> int:
    """Batches across BOTH modes combined — they share the same GPU node pool,
    so the capacity cap applies to the pool as a whole, not per mode."""
    return sum(len(_list_batch_ids(m)) for m in _BATCH_MODES)

def _gpu_node_selector_string() -> str:
    """GPU_NODE_SELECTOR as a Kubernetes label-selector query string, or "" if unset."""
    return ",".join(f"{k}={v}" for k, v in GPU_NODE_SELECTOR.items())

def _gpu_node_is_healthy() -> bool:
    """
    True if at least one node matching GPU_NODE_SELECTOR reports Ready=True,
    DiskPressure=False, and MemoryPressure=False.

    Fails OPEN (returns True) if GPU_NODE_SELECTOR isn't set (nothing specific
    to check) or if listing nodes itself errors — most likely because the
    controller's ClusterRole doesn't grant "nodes" list/get yet. This check is
    an extra safety net, not a hard boundary; a missing RBAC rule permanently
    blocking every future batch creation would be a worse failure mode than
    occasionally spawning a batch without having confirmed node health.
    """
    selector = _gpu_node_selector_string()
    if not selector:
        return True
    try:
        nodes = _core_v1().list_node(label_selector=selector).items
    except k8s_client.ApiException as e:
        logger.warning(f"[NODE-HEALTH] Could not list nodes ({selector}): {e} — proceeding anyway")
        return True
    for node in nodes:
        conditions = {c.type: c.status for c in (node.status.conditions or [])}
        if (conditions.get("Ready") == "True"
                and conditions.get("DiskPressure", "False") != "True"
                and conditions.get("MemoryPressure", "False") != "True"):
            return True
    logger.warning(f"[NODE-HEALTH] No healthy node matches '{selector}' — refusing to spawn a new batch")
    return False

def _ensure_batch_deployment(deployment_mode: str, batch_id: int):
    """
    Create the Deployment for `batch_id` if it doesn't already exist.

    PHASE 2 safe scale-up, step 1/2: on actual creation, also kick off a
    background wait-for-Ready-then-/reload follow-up (_wait_then_reload) —
    the camera(s) landing on this batch get an immediate best-effort /reload
    right after this returns (from the caller), but that will fail if the pod
    isn't scheduled/ready yet; this is what makes sure they get picked up once
    it actually is, instead of only being caught by self-heal on some later
    unrelated call.

    Before actually creating anything new: MAX_BATCHES_PER_GPU_NODE (if set)
    caps total batches so this doesn't spawn unlimited DeepStream pods onto
    one GPU node, and the target node must report healthy (_gpu_node_is_healthy)
    — creating a pod that can never actually run doesn't help anyone.
    """
    name = _batch_deployment_name(deployment_mode, batch_id)
    apps = _apps_v1()
    try:
        apps.read_namespaced_deployment(name, K8S_NAMESPACE)
    except k8s_client.ApiException as e:
        if e.status == 404:
            if MAX_BATCHES_PER_GPU_NODE and _total_batch_count() >= MAX_BATCHES_PER_GPU_NODE:
                raise RuntimeError(
                    f"MAX_BATCHES_PER_GPU_NODE={MAX_BATCHES_PER_GPU_NODE} reached — "
                    f"refusing to create batch={batch_id} for mode={deployment_mode}"
                )
            if not _gpu_node_is_healthy():
                raise RuntimeError(
                    f"No healthy GPU node available — refusing to create "
                    f"batch={batch_id} for mode={deployment_mode}"
                )
            apps.create_namespaced_deployment(
                K8S_NAMESPACE, _build_batch_deployment(deployment_mode, batch_id)
            )
            logger.info(f"Deployment created | name={name}")
            threading.Thread(
                target=_wait_then_reload, args=(deployment_mode, batch_id),
                daemon=True, name=f"ds-safe-scaleup-{name}",
            ).start()
        else:
            raise

def _drain_batch(deployment_mode: str, batch_id: int) -> int:
    """
    PHASE 2 safe scale-down, step 1/2: move every running camera off
    `batch_id` onto another batch with room (spawning a new one — via the
    same _ensure_batch_deployment safe-scale-up path — only if every other
    existing batch is already full), then /reload both the drained batch and
    every destination batch. Returns how many cameras were moved; 0 means
    there was nothing to drain.
    """
    with _rtsp_lock:
        data = _load_rtsp()
        movers = [
            (link, info) for link, info in data.items()
            if isinstance(info, dict) and info.get("running_status")
            and int(info.get("batch_id", -1)) == batch_id
        ]
        if not movers:
            return 0

        other_batches = [b for b in _list_batch_ids(deployment_mode) if b != batch_id]
        counts: dict = {}
        for info in data.values():
            if isinstance(info, dict) and info.get("running_status") and "batch_id" in info:
                bid = int(info["batch_id"])
                if bid != batch_id:
                    counts[bid] = counts.get(bid, 0) + 1

        affected = {batch_id}
        for _link, info in movers:
            dest = next((b for b in other_batches if counts.get(b, 0) < MAX_CAMERAS_PER_POD), None)
            if dest is None:
                dest = max([batch_id] + other_batches) + 1
                _ensure_batch_deployment(deployment_mode, dest)
                other_batches.append(dest)
                logger.info(
                    f"[DRAIN] All other batches full — spawned batch={dest} "
                    f"to receive drained cameras | mode={deployment_mode}"
                )
            logger.info(
                f"[DRAIN] Moving camera | cam={info.get('cam_name')} "
                f"mode={deployment_mode} {batch_id} -> {dest}"
            )
            # Clear the OLD source_id before reassigning batch_id, then compute
            # a fresh one scoped to `dest` — carrying the old value over would
            # collide the moment two batches with overlapping source_ids (e.g.
            # both starting from 1) get merged into one. _assign_source_id
            # re-scans `data` live, so this sees every camera already placed in
            # `dest` earlier in this same loop, not just what was there before
            # the drain started.
            info.pop("source_id", None)
            info["batch_id"] = dest
            info["source_id"] = _assign_source_id(data, dest)
            info["rev"] = int(info.get("rev", 0)) + 1
            counts[dest] = counts.get(dest, 0) + 1
            affected.add(dest)

        _save_rtsp_atomic(data)

    signal_pods(deployment_mode, affected, "/reload")
    return len(movers)

def _scale_down_batch(deployment_mode: str, batch_id: Optional[int] = None, drain: bool = False) -> int:
    """
    Delete a batch's Deployment. Defaults to the highest existing batch_id
    (mirrors the old "/pods/{mode}/scale_down" behaviour); pass batch_id to
    target a specific one. Unlike the old StatefulSet, batches are independent
    Deployments now, so ANY batch can be removed on its own, not just the
    highest one.

    drain=False (default): refuses (409) if the batch still has cameras
    marked running — the original, conservative behaviour.
    drain=True: PHASE 2 safe scale-down — _drain_batch moves any running
    cameras onto other batches first, every destination batch's health is
    confirmed (_batch_is_healthy), and only then is this one removed.
    """
    ids = _list_batch_ids(deployment_mode)
    if not ids:
        raise HTTPException(400, f"{deployment_mode}: no pods to scale down")
    target = batch_id if batch_id is not None else ids[-1]
    if target not in ids:
        raise HTTPException(404, f"{deployment_mode}: batch_id={target} has no running Deployment")

    if drain:
        moved = _drain_batch(deployment_mode, target)
        if moved:
            destinations = [b for b in _list_batch_ids(deployment_mode) if b != target]
            unhealthy = [b for b in destinations if not _batch_is_healthy(deployment_mode, b)]
            if unhealthy:
                raise HTTPException(
                    503,
                    f"batch_id={target} drained {moved} camera(s) but destination "
                    f"batch(es) {unhealthy} aren't Ready yet — retry scale-down shortly",
                )

    with _rtsp_lock:
        data = _load_rtsp()
    still_running = [
        info.get("cam_name", "?") for info in data.values()
        if isinstance(info, dict) and info.get("running_status")
        and int(info.get("batch_id", -1)) == target
    ]
    if still_running:
        raise HTTPException(
            409,
            f"batch_id={target} still has running camera(s) {still_running} "
            f"— stop them before scaling down",
        )

    _delete_deployment(_batch_deployment_name(deployment_mode, target))
    return target

def _maybe_scale_down_after_delete(deployment_mode: str, batch_id: int):
    """
    Called after a camera delete leaves `batch_id` with no running cameras.
    Each batch is an independent Deployment now, so — unlike the old
    StatefulSet-ordinal model — any batch can be removed on its own; there's
    no "must be the highest ordinal" restriction to check first.
    """
    if not _K8S_AVAILABLE:
        return
    try:
        _scale_down_batch(deployment_mode, batch_id)
        logger.info(f"[AUTO-SCALE-DOWN] Pod removed | mode={deployment_mode} batch={batch_id}")
    except HTTPException as e:
        logger.info(f"[AUTO-SCALE-DOWN] Skipped | mode={deployment_mode} batch={batch_id}: {e.detail}")

# ── batch_id assignment — dynamic spawn ───────────────────────────────────────

def _restart_all_batches(deployment_mode: str):
    """
    Rolling-restart every batch Deployment for a mode so already-running pods
    pick up a newly pushed image (needed for :latest-tagged images like
    deepstream_batch, which imagePullPolicy: Always alone won't re-pull on
    existing pods) — same mechanism _restart_deployment uses for single
    camera Deployments.
    """
    for bid in _list_batch_ids(deployment_mode):
        _restart_deployment(_batch_deployment_name(deployment_mode, bid))

def _delete_all_batches(deployment_mode: str):
    """
    Delete every batch Deployment for a mode — full decommission, e.g. before
    dropping deepstream_batch entirely. Does not touch rtsplinks.json; cameras
    still marked running there will just fail /reload until their batch is
    recreated by a fresh _assign_batch_id call (starting a camera with no
    batch_id yet).
    """
    for bid in _list_batch_ids(deployment_mode):
        _delete_deployment(_batch_deployment_name(deployment_mode, bid))

# ── PHASE 2 — camera-count based autoscaling ──────────────────────────────────
#
# The controller (not KEDA/HPA) remains the sole owner of camera assignment,
# rebalancing, and safe drain-before-removal. KEDA/HPA may independently watch
# the metrics below to scale cluster/node capacity (e.g. the GPU node
# autoscaler adding a machine) — but they only ever change what capacity
# *exists*; which camera lands on which batch, and whether a batch is safe to
# remove, is decided here.

def _active_camera_count(deployment_mode: str) -> int:
    """Cameras currently running_status=true, attributed to this mode via the
    per-entry deployment_mode field written by update_rtsp_status."""
    with _rtsp_lock:
        data = _load_rtsp()
    return sum(
        1 for info in data.values()
        if isinstance(info, dict) and info.get("running_status")
        and info.get("deployment_mode", DEEPSTREAM_SERVICE) == deployment_mode
    )

def _required_batches(deployment_mode: str) -> int:
    """required = ceil(active_cameras / MAX_CAMERAS_PER_POD); 0 if no cameras."""
    active = _active_camera_count(deployment_mode)
    return math.ceil(active / MAX_CAMERAS_PER_POD) if active else 0

def _reconcile_batches(deployment_mode: str):
    """
    Consolidate down to exactly the number of batches actually needed for the
    current active camera count — safely draining (not just refusing) any
    excess ones. Call this after anything that could reduce camera count
    (a delete, a stop) so batch count actually shrinks as load drops, not only
    when a batch happens to hit exactly zero.
    """
    if not _K8S_AVAILABLE:
        return
    required = _required_batches(deployment_mode)
    excess = len(_list_batch_ids(deployment_mode)) - required
    for _ in range(max(0, excess)):
        try:
            removed = _scale_down_batch(deployment_mode, drain=True)
            logger.info(
                f"[RECONCILE] Consolidated — batch removed | "
                f"mode={deployment_mode} batch={removed} required={required}"
            )
        except HTTPException as e:
            logger.info(f"[RECONCILE] Stopped | mode={deployment_mode}: {e.detail}")
            break
        except Exception as e:
            # Best-effort background consolidation — a drain hitting the new
            # MAX_BATCHES_PER_GPU_NODE/node-health guards (RuntimeError) or
            # anything else unexpected must never propagate out of here, since
            # callers run this after already-successful camera operations and
            # a crash here would turn those into a spurious 500.
            logger.warning(f"[RECONCILE] Stopped on unexpected error | mode={deployment_mode}: {e}")
            break

def _assign_batch_id(data: dict, deployment_mode: str) -> int:
    """
    Find a batch with < MAX_CAMERAS_PER_POD running cameras.
    If all batches are full (or none exist), spawn a new one and return its id.
    """
    # Count running cameras per batch from rtsplinks.json
    counts: dict = {}
    for info in data.values():
        if isinstance(info, dict) and info.get("running_status") and "batch_id" in info:
            bid = int(info["batch_id"])
            counts[bid] = counts.get(bid, 0) + 1

    existing = _list_batch_ids(deployment_mode)

    if not existing:
        # No pods at all — spawn first one
        _ensure_batch_deployment(deployment_mode, 1)
        logger.info(f"[SPAWN] First pod | mode={deployment_mode} batch_id=1")
        return 1

    # Find a batch with available space
    for bid in existing:
        if counts.get(bid, 0) < MAX_CAMERAS_PER_POD:
            return bid

    # All batches full — spawn one more
    new_bid = max(existing) + 1
    _ensure_batch_deployment(deployment_mode, new_bid)
    logger.info(
        f"[SPAWN] All {len(existing)} pods full ({MAX_CAMERAS_PER_POD} cams each) "
        f"— spawning pod {new_bid} | mode={deployment_mode}"
    )
    return new_bid

# ── rtsplinks.json — atomic write with revision ───────────────────────────────

_rtsp_lock = threading.Lock()

def _load_rtsp() -> dict:
    if os.path.exists(RTSP_PATH):
        with open(RTSP_PATH) as f:
            return json.load(f)
    return {}

def _save_rtsp_atomic(data: dict):
    """
    Write rtsplinks.json via write-tmp + fsync + atomic rename, so a reader
    (this process or a DS pod's own reload()) never observes a partially
    written file, and the write survives a crash/power-loss right after the
    rename — os.replace() alone only guarantees atomicity of the rename
    itself, not that the tmp file's contents actually hit disk beforehand.
    """
    data.pop("__meta__", None)   # legacy field — no longer written, strip if present
    dir_ = os.path.dirname(RTSP_PATH)
    with tempfile.NamedTemporaryFile("w", dir=dir_, delete=False, suffix=".tmp") as tf:
        json.dump(data, tf, indent=4)
        tf.flush()
        os.fsync(tf.fileno())
        tmp = tf.name
    os.replace(tmp, RTSP_PATH)

def _assign_source_id(data: dict, batch_id: int) -> int:
    used = {
        int(info.get("source_id", 0))
        for info in data.values()
        if isinstance(info, dict)
        and info.get("running_status")
        and int(info.get("batch_id", 0)) == batch_id
    }
    sid = 1
    while sid in used:
        sid += 1
    return sid

def update_rtsp_status(
    rtsp_link: str,
    cam_name: str,
    running_status: bool,
    rtsp_id: Optional[str] = None,
    deployment_mode: Optional[str] = None,
    pinned_batch_id: Optional[int] = None,
) -> int:
    """
    Atomically update rtsplinks.json.
    Assigns batch_id dynamically (spawning a new pod if needed) on first start.
    Returns the assigned batch_id.
    """
    with _rtsp_lock:
        data = _load_rtsp()

        if rtsp_link not in data:
            if not running_status:
                # Stopping/deleting a camera that was never actually started
                # used to silently fabricate a brand-new rtsplinks.json entry
                # for it (cam_name, running_status=False, batch_id defaulting
                # later) — a phantom record for something that never ran.
                # Raise instead so the caller reports a clear error for this
                # one camera; ValueError (not HTTPException) so the per-camera
                # loop in /Surveillance catches it and continues with the
                # rest of the batch instead of aborting the whole request.
                raise ValueError(f"camera not found: {cam_name}")
            data[rtsp_link] = {}
        entry = data[rtsp_link]
        entry["cam_name"]       = cam_name
        entry["running_status"] = running_status
        # Bumped on every write to this entry — lets a reader/log line tell
        # two writes apart even when every other field ends up identical, and
        # gives a stable counter for anyone debugging "which write actually
        # landed last" without needing timestamps.
        entry["rev"] = int(entry.get("rev", 0)) + 1

        if rtsp_id is not None:
            entry["rtsp_id"] = str(rtsp_id)

        mode = deployment_mode or DEEPSTREAM_SERVICE
        # Stored so active-camera counts can be attributed to the right mode
        # (aksha_active_cameras / aksha_required_batches) — batch_id numbering
        # alone is ambiguous across modes since each mode assigns 1, 2, 3, ...
        # independently.
        entry["deployment_mode"] = mode

        if running_status:
            if pinned_batch_id is not None:
                # Caller explicitly pinned a pod
                entry["batch_id"] = int(pinned_batch_id)
            elif "batch_id" not in entry:
                # First time this camera is started — assign dynamically
                # _assign_batch_id may create a new batch Deployment (outside
                # lock is fine; k8s API call is idempotent)
                entry["batch_id"] = _assign_batch_id(data, mode)

            bid = int(entry["batch_id"])

            # Self-heal: a camera that already has a batch_id skips
            # _assign_batch_id above, so if that batch's Deployment was
            # deleted or otherwise fell behind since this camera last ran,
            # nothing would otherwise notice — it would just /reload a pod
            # that doesn't exist, forever. Make sure that batch's Deployment
            # actually exists every time, not only on first assignment.
            if mode in _STS_NAMES and _K8S_AVAILABLE:
                if bid not in _list_batch_ids(mode):
                    logger.warning(
                        f"[HEAL] Batch Deployment missing | mode={mode} batch={bid} — creating"
                    )
                    _ensure_batch_deployment(mode, bid)

            if "source_id" not in entry:
                entry["source_id"] = _assign_source_id(data, bid)
        else:
            # 0 (not a real batch_id — those are 1-based) means "this camera
            # was never actually started, so it was never really assigned
            # anywhere." Returning a fabricated 1 here used to make the
            # caller /reload and scale-down-check batch 1 for a camera that
            # was never on it — harmless in practice (those checks just no-op
            # or get refused), but pure noise. 0 lets _mark skip it entirely.
            bid = int(entry.get("batch_id", 0))
            entry.pop("source_id", None)   # free the slot

        _save_rtsp_atomic(data)
        logger.info(
            f"rtsplinks.json | cam={cam_name} running={running_status} "
            f"batch={bid} rev={entry['rev']}"
        )
        return bid

def _rename_in_rtsp(old_name: str, new_name: str, rtsp_link: str) -> int:
    with _rtsp_lock:
        data = _load_rtsp()
        entry = data.get(rtsp_link) or next(
            (v for v in data.values() if isinstance(v, dict) and v.get("cam_name") == old_name),
            None,
        )
        bid = 0   # 0 = no real batch (camera not found, or never assigned one)
        rev = None
        if entry:
            entry["cam_name"] = new_name
            entry["rev"] = rev = int(entry.get("rev", 0)) + 1
            bid = int(entry.get("batch_id", 0))
        _save_rtsp_atomic(data)
    logger.info(f"rtsplinks.json renamed {old_name} → {new_name} | batch={bid} rev={rev}")
    return bid

# ── pod signalling ────────────────────────────────────────────────────────────

def _pod_url(deployment_mode: str, batch_id: int) -> Optional[str]:
    """
    http://<node the pod actually landed on>:<that batch's port>.

    hostNetwork pods have no Service/DNS identity of their own — the pod's
    real address is whatever node it was scheduled to, so this looks up the
    live pod's status.hostIP rather than building a fixed hostname. Returns
    None if the batch's pod isn't found or hasn't been scheduled yet.
    """
    name = _batch_deployment_name(deployment_mode, batch_id)
    try:
        pods = _core_v1().list_namespaced_pod(
            K8S_NAMESPACE, label_selector=f"app={name}"
        ).items
    except k8s_client.ApiException:
        return None
    for p in pods:
        if p.status and p.status.host_ip:
            return f"http://{p.status.host_ip}:{_batch_port(deployment_mode, batch_id)}"
    return None

def _delete_pod(deployment_mode: str, batch_id: int):
    """
    Force batch `batch_id`'s pod to restart and re-pull its image — same
    mechanism _restart_deployment uses for single-camera Deployments. Only
    that one batch's cameras are interrupted; other batches are untouched.
    """
    _restart_deployment(_batch_deployment_name(deployment_mode, batch_id))

def signal_pods(deployment_mode: str, batch_ids: set, endpoint: str = "/reload"):
    def _one(bid):
        url = _pod_url(deployment_mode, bid)
        if url is None:
            logger.warning(
                f"Signal skipped | mode={deployment_mode} batch={bid}: "
                f"pod not found or not scheduled yet"
            )
            return
        try:
            r = _req.post(url + endpoint, timeout=5)
            logger.info(f"Signal | mode={deployment_mode} batch={bid} status={r.status_code}")
        except Exception as e:
            logger.warning(f"Signal failed | mode={deployment_mode} batch={bid}: {e}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(batch_ids))) as ex:
        list(ex.map(_one, sorted(batch_ids)))

# ── k8s Deployment CRUD (frame_reader / deepstream_single) ───────────────────

def _build_deployment(name: str, image: str, env: dict, gpu: bool = False) -> dict:
    aksha_vol, aksha_mnt = _aksha_volume()
    tz_vols, tz_mnts     = _tz_volumes()
    container: dict = {
        "name": name, "image": image, "imagePullPolicy": "Always",
        "env":  [{"name": k, "value": str(v)} for k, v in env.items()],
        "volumeMounts": [aksha_mnt] + tz_mnts,
    }
    if gpu:
        container["resources"] = {"limits": {"nvidia.com/gpu": "1"}}
    return {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {
            "name": name, "namespace": K8S_NAMESPACE,
            "labels": {"app": name, "managed-by": "aksha-controller"},
        },
        "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name}},
                "spec": {
                    "containers": [container],
                    "volumes": [aksha_vol] + tz_vols,
                },
            },
        },
    }

def _upsert_deployment(manifest: dict):
    apps = _apps_v1()
    name, ns = manifest["metadata"]["name"], manifest["metadata"]["namespace"]
    try:
        apps.read_namespaced_deployment(name, ns)
        apps.replace_namespaced_deployment(name, ns, manifest)
        logger.info(f"Deployment replaced | name={name}")
    except k8s_client.ApiException as e:
        if e.status == 404:
            apps.create_namespaced_deployment(ns, manifest)
            logger.info(f"Deployment created | name={name}")
        else:
            raise

def _delete_deployment(name: str):
    try:
        _apps_v1().delete_namespaced_deployment(
            name, K8S_NAMESPACE,
            body=k8s_client.V1DeleteOptions(propagation_policy="Foreground"),
        )
        logger.info(f"Deployment deleted | name={name}")
    except k8s_client.ApiException as e:
        if e.status != 404:
            logger.warning(f"Delete deployment {name}: {e}")

def _restart_deployment(name: str):
    patch = {"spec": {"template": {"metadata": {"annotations": {
        "kubectl.kubernetes.io/restartedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }}}}}
    try:
        _apps_v1().patch_namespaced_deployment(name, K8S_NAMESPACE, patch)
        logger.info(f"Deployment restarted | name={name}")
    except k8s_client.ApiException as e:
        if e.status != 404:
            logger.warning(f"Restart deployment {name}: {e}")

def _common_env(item) -> dict:
    return {
        "KAFKA_BOOTSTRAP_SERVERS":              KAFKA_SERVER,
        "CAMERA_NAME":                          item.camera_name,
        "RTSP_ID":                              str(item.rtsp_id or item.camera_name),
        "RTSP_URL":                             item.rtsp_link,
        "OUTPUT_WIDTH":                         str(item.output_width),
        "OUTPUT_HEIGHT":                        str(item.output_height),
        "FPS":                                  str(item.fps or 1.0),
        "SSIM_THRESH":                          str(item.prefilter_threshold),
        "MY_ALERTS":                            " ".join(item.alerts) if item.alerts else " ",
        "ANOMALY_DETECTION":                    str(item.anomaly_detection).lower(),
        "OBJECT_DETECTION":                     str(item.object_detection).lower(),
        "AKSHA_PATH":                           AKSHA_PATH,
        "DEPLOYMENT_PLATFORM":                  "kubernetes",
        "AUTOALERT_EMAIL_NOTIFICATION_SERVICE": str(item.email_auto_alert).lower(),
        "AUTOALERT_DISPLAY":                    str(item.display_auto_alert).lower(),
        "EMAIL_ALERT":                          str(item.email_alert).lower(),
        "ALERT_DISPLAY":                        str(item.display_alert).lower(),
    }

def start_frame_reader(item):
    _upsert_deployment(_build_deployment(
        f"{item.camera_name}-rtsp", "dockerhubalgo/frame_reader:latest",
        _common_env(item), gpu=False,
    ))

def start_deepstream_single(item):
    env = {**_common_env(item), "ENABLE_GPU": "true", "ENABLE_TENSORRT": "true",
           "TRT_CACHE_PATH": f"{AKSHA_PATH}/trt_cache"}
    _upsert_deployment(_build_deployment(
        f"{item.camera_name}-deepstream", "dockerhubalgo/deepstream_service:latest",
        env, gpu=True,
    ))

def stop_frame_reader(cam_name: str):      _delete_deployment(f"{cam_name}-rtsp")
def stop_deepstream_single(cam_name: str): _delete_deployment(f"{cam_name}-deepstream")

def restart_frame_reader(item):
    new = item.update_camera_name
    if new and new != item.camera_name:
        _delete_deployment(f"{item.camera_name}-rtsp")
        start_frame_reader(item.copy(update={"camera_name": new}))
    else:
        _restart_deployment(f"{item.camera_name}-rtsp")

def restart_deepstream_single(item):
    new = item.update_camera_name
    if new and new != item.camera_name:
        _delete_deployment(f"{item.camera_name}-deepstream")
        start_deepstream_single(item.copy(update={"camera_name": new}))
    else:
        _restart_deployment(f"{item.camera_name}-deepstream")

# Jewelry: same lightweight per-camera pattern as frame_reader (no
# TensorRT-warmup liveness delay) — deliberately NOT the batch-Deployment
# machinery below, which is DeepStream/TensorRT-specific and the wrong shape
# for a small per-camera service. Behind JEWELRY_DETECTION.
#
# GPU is optional, same idea as deepstream_batch's own approach (see
# _build_batch_deployment's docstring): no nvidia.com/gpu resource limit is
# claimed (gpu=False) — that would leave the pod permanently Pending on a
# node with no GPU capacity. Instead the NVIDIA env vars below just make a
# GPU visible *if* the node happens to expose one via the device plugin; the
# jewelry container itself detects and uses it (torch.cuda.is_available()),
# falling back to CPU otherwise. Schedulable on any node either way.
def start_jewelry(item):
    env = {
        **_common_env(item),
        "NVIDIA_VISIBLE_DEVICES": "all",
        "NVIDIA_DRIVER_CAPABILITIES": "compute,video,utility",
    }
    _upsert_deployment(_build_deployment(
        f"{item.camera_name}-jewelry", "dockerhubalgo/jewelry_container:latest",
        env, gpu=False,
    ))

def stop_jewelry(cam_name: str): _delete_deployment(f"{cam_name}-jewelry")

def restart_jewelry(item):
    new = item.update_camera_name
    if new and new != item.camera_name:
        _delete_deployment(f"{item.camera_name}-jewelry")
        start_jewelry(item.copy(update={"camera_name": new}))
    else:
        _restart_deployment(f"{item.camera_name}-jewelry")

# ── models ────────────────────────────────────────────────────────────────────

class Operation(str, Enum):
    create  = "start"
    update  = "update"
    restart = "restart"
    delete  = "stop"

class Item(BaseModel):
    camera_name:         str
    update_camera_name:  Optional[str]   = None
    rtsp_link:           str
    rtsp_id:             Optional[int]   = None
    alerts:              List            = []
    fps:                 Optional[float] = 1.0
    email_auto_alert:    bool            = True
    display_auto_alert:  bool            = True
    email_alert:         bool            = True
    display_alert:       bool            = True
    output_height:       int             = 360
    output_width:        int             = 640
    object_detection:    bool            = True
    anomaly_detection:   bool            = True
    face_rec:            bool            = False
    anpr:                bool            = False
    prefilter_threshold: float           = 0.95
    # frame_reader | deepstream_single | deepstream_batch | deepstream_nvinfer | jewelry
    # (jewelry is behind the JEWELRY_DETECTION feature flag)
    deployment_mode:     str             = "deepstream_batch"
    batch_id:            Optional[int]   = None   # None = auto-assign; set to pin a pod

    class Config:
        extra = "ignore"

class Surveillance(BaseModel):
    type:        Operation
    camera_list: List[Item]

class Insight(BaseModel):
    camera_name: str
    start_date: str; start_time: str
    end_date:   str; end_time:   str

class ImageAnalysis(BaseModel):
    question: str; image: str; model_option: str; chat_history: list

class DownloadImageAnalysisChat(BaseModel):
    image: str; chat_history: list

class AlertReportAnalyzer(BaseModel):
    filtered_data: dict
    start_date: str; end_date: str; model_option: str; lang_option: str

# ── app ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Aksha Controller (Kubernetes)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def _startup():
    os.makedirs(AKSHA_PATH,  exist_ok=True)
    os.makedirs(logger_path, exist_ok=True)
    if not os.path.exists(RTSP_PATH):
        _save_rtsp_atomic({})
    logger.info(
        f"Controller-k8s ready | MAX_CAMERAS_PER_POD={MAX_CAMERAS_PER_POD} "
        f"| SERVICE={DEEPSTREAM_SERVICE} | K8S={_K8S_AVAILABLE} | PVC={AKSHA_PVC_NAME or 'hostPath'}"
    )

# ── health & registry ─────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "Aksha Controller (Kubernetes) is running"}

@app.get("/health")
def health():
    return {"ok": True, "k8s": _K8S_AVAILABLE,
            "max_cameras_per_pod": MAX_CAMERAS_PER_POD, "aksha_path": AKSHA_PATH}

@app.get("/rtsplinks.json")
def get_rtsp_links():
    with _rtsp_lock:
        return _load_rtsp()

@app.get("/pods/{deployment_mode}")
def get_pods(deployment_mode: str):
    """Return current batch count and camera distribution per batch."""
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    ids = _list_batch_ids(deployment_mode)
    with _rtsp_lock:
        data = _load_rtsp()
    counts = {}
    for info in data.values():
        if isinstance(info, dict) and info.get("running_status") and "batch_id" in info:
            bid = int(info["batch_id"])
            counts[bid] = counts.get(bid, 0) + 1
    return {
        "deployment_mode": deployment_mode,
        "pods": len(ids),
        "batch_ids": ids,
        "max_cameras_per_pod": MAX_CAMERAS_PER_POD,
        "cameras_per_pod": {f"pod_{bid}": counts.get(bid, 0) for bid in ids},
        "active_cameras": _active_camera_count(deployment_mode),
        "required_batches": _required_batches(deployment_mode),
    }

@app.get("/metrics")
def metrics():
    """
    PHASE 2 — Prometheus exposition format for KEDA/HPA (or any Prometheus-
    based external scaler) to consume: aksha_active_cameras,
    aksha_required_batches, aksha_current_batches, aksha_batch_camera_count,
    aksha_batch_ready, aksha_capacity_available, and the global
    aksha_max_cameras_per_batch. The controller itself still owns camera
    assignment/rebalancing/drain — this is read-only observability, not a
    control channel.
    """
    with _rtsp_lock:
        data = _load_rtsp()
    lines = [
        "# HELP aksha_active_cameras Cameras with running_status=true for this mode",
        "# TYPE aksha_active_cameras gauge",
        "# HELP aksha_required_batches ceil(active_cameras / MAX_CAMERAS_PER_POD)",
        "# TYPE aksha_required_batches gauge",
        "# HELP aksha_current_batches Batch Deployments that actually exist for this mode",
        "# TYPE aksha_current_batches gauge",
        "# HELP aksha_batch_camera_count Running cameras currently assigned to this batch",
        "# TYPE aksha_batch_camera_count gauge",
        "# HELP aksha_batch_ready 1 if this batch's Deployment has a Ready replica, else 0",
        "# TYPE aksha_batch_ready gauge",
        "# HELP aksha_capacity_available Free camera slots across Ready batches for this mode",
        "# TYPE aksha_capacity_available gauge",
        "# HELP aksha_max_cameras_per_batch Configured MAX_CAMERAS_PER_POD (global, not per-mode)",
        "# TYPE aksha_max_cameras_per_batch gauge",
        f"aksha_max_cameras_per_batch {MAX_CAMERAS_PER_POD}",
    ]
    for mode in sorted(_BATCH_MODES):
        active = sum(
            1 for info in data.values()
            if isinstance(info, dict) and info.get("running_status")
            and info.get("deployment_mode", DEEPSTREAM_SERVICE) == mode
        )
        required = math.ceil(active / MAX_CAMERAS_PER_POD) if active else 0
        batch_ids = _list_batch_ids(mode) if _K8S_AVAILABLE else []
        lines.append(f'aksha_active_cameras{{mode="{mode}"}} {active}')
        lines.append(f'aksha_required_batches{{mode="{mode}"}} {required}')
        lines.append(f'aksha_current_batches{{mode="{mode}"}} {len(batch_ids)}')

        counts: dict = {}
        for info in data.values():
            if (isinstance(info, dict) and info.get("running_status")
                    and info.get("deployment_mode", DEEPSTREAM_SERVICE) == mode
                    and "batch_id" in info):
                bid = int(info["batch_id"])
                counts[bid] = counts.get(bid, 0) + 1

        capacity_available = 0
        for bid in batch_ids if batch_ids else sorted(counts):
            ready = _batch_is_healthy(mode, bid) if _K8S_AVAILABLE else False
            lines.append(
                f'aksha_batch_camera_count{{mode="{mode}",batch_id="{bid}"}} {counts.get(bid, 0)}'
            )
            lines.append(
                f'aksha_batch_ready{{mode="{mode}",batch_id="{bid}"}} {1 if ready else 0}'
            )
            if ready:
                capacity_available += max(0, MAX_CAMERAS_PER_POD - counts.get(bid, 0))
        lines.append(f'aksha_capacity_available{{mode="{mode}"}} {capacity_available}')
    return PlainTextResponse("\n".join(lines) + "\n")

@app.post("/pods/{deployment_mode}/restart")
def restart_pods(deployment_mode: str):
    """
    Force a rolling restart of every batch Deployment so already-running pods
    pick up a newly pushed image (needed for :latest-tagged images like
    deepstream_batch, which imagePullPolicy: Always alone won't re-pull on
    existing pods).
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    _restart_all_batches(deployment_mode)
    return {"deployment_mode": deployment_mode, "restarted": True}

@app.post("/pods/{deployment_mode}/{batch_id}/restart")
def restart_pod(deployment_mode: str, batch_id: int):
    """
    Restart just batch `batch_id`'s Deployment, re-pulling the image fresh.
    Only that one batch's cameras get interrupted; other batches are untouched.
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    _delete_pod(deployment_mode, batch_id)
    return {"deployment_mode": deployment_mode, "batch_id": batch_id, "restarted": True}

@app.delete("/pods/{deployment_mode}")
def delete_pods(deployment_mode: str):
    """
    Delete every batch Deployment for a mode — full decommission, not a
    refresh. Cameras still marked running in rtsplinks.json won't be
    reachable until their batch is recreated (a fresh camera start).
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    _delete_all_batches(deployment_mode)
    return {"deployment_mode": deployment_mode, "deleted": True}

@app.post("/pods/{deployment_mode}/scale_down")
def scale_down_pods(deployment_mode: str, drain: bool = False):
    """
    Remove the highest batch_id's Deployment (unlike /restart, which recreates
    a pod in place). By default refuses with 409 if that batch still has
    running cameras — stop them first. Pass ?drain=true for PHASE 2 safe
    scale-down: cameras are moved onto other batches first, every destination
    is health-checked, and only then is this batch removed.
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    removed = _scale_down_batch(deployment_mode, drain=drain)
    return {"deployment_mode": deployment_mode, "removed_batch_id": removed}

@app.post("/pods/{deployment_mode}/{batch_id}/scale_down")
def scale_down_pod(deployment_mode: str, batch_id: int, drain: bool = False):
    """
    Delete batch `batch_id`'s Deployment. Each batch is an independent
    Deployment, so — unlike the old StatefulSet-ordinal model — any batch_id
    can be targeted directly. By default refuses (409) if that batch still
    has cameras marked running in rtsplinks.json; pass ?drain=true for PHASE 2
    safe scale-down (see scale_down_pods).
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    removed = _scale_down_batch(deployment_mode, batch_id, drain=drain)
    return {"deployment_mode": deployment_mode, "batch_id": removed}

@app.post("/pods/{deployment_mode}/reconcile")
def reconcile_pods(deployment_mode: str):
    """
    PHASE 2 — manually trigger the same consolidation _reconcile_batches runs
    automatically after every camera delete: safely drain and remove however
    many batches are currently in excess of ceil(active_cameras /
    MAX_CAMERAS_PER_POD). Useful for KEDA/cron to call directly, or to
    re-check after e.g. a manual rtsplinks.json edit.
    """
    if deployment_mode not in _STS_NAMES:
        raise HTTPException(400, f"Unknown deployment_mode: {deployment_mode}")
    if not _K8S_AVAILABLE:
        raise HTTPException(503, "Kubernetes client not available")
    before = _list_batch_ids(deployment_mode)
    _reconcile_batches(deployment_mode)
    after = _list_batch_ids(deployment_mode)
    return {
        "deployment_mode": deployment_mode,
        "required_batches": _required_batches(deployment_mode),
        "batches_before": before,
        "batches_after": after,
    }

# ── /Surveillance ─────────────────────────────────────────────────────────────

_BATCH_MODES = {"deepstream_batch", "deepstream_nvinfer"}

@app.post("/Surveillance")
async def surveillance(surv: Surveillance):
    logger.info(f"POST /Surveillance | op={surv.type} | cameras={len(surv.camera_list)}")
    results          = []
    affected_batches: dict = {}   # mode → set[batch_id]

    def _mark(mode: str, bid: int):
        # bid=0 means "no real batch" (see update_rtsp_status/_rename_in_rtsp)
        # — nothing to /reload or scale-down-check.
        if bid:
            affected_batches.setdefault(mode, set()).add(bid)

    for it in surv.camera_list:
        mode = it.deployment_mode
        cam  = it.camera_name
        new  = it.update_camera_name or cam
        # rtsp_id must stay a real numeric id or None — never fall back to the
        # camera name. rtsplinks.json's rtsp_id gets read back by the frontend
        # and resubmitted to the Node backend, whose Mongoose schema requires
        # Number; a name string there throws a CastError.
        rid  = str(it.rtsp_id) if it.rtsp_id is not None else None

        try:
            if surv.type == Operation.create:
                if mode == "frame_reader":
                    start_frame_reader(it)
                elif mode == "deepstream_single":
                    start_deepstream_single(it)
                elif mode == "jewelry":
                    start_jewelry(it)
                elif mode in _BATCH_MODES:
                    bid = update_rtsp_status(it.rtsp_link, cam, True, rid, mode, it.batch_id)
                    _mark(mode, bid)
                else:
                    raise HTTPException(400, f"Unknown mode: {mode}")
                results.append({"camera": cam, "status": "started", "mode": mode})

            elif surv.type == Operation.update:
                if mode == "frame_reader":
                    start_frame_reader(it)
                elif mode == "deepstream_single":
                    start_deepstream_single(it)
                elif mode == "jewelry":
                    start_jewelry(it)
                elif mode in _BATCH_MODES:
                    bid = update_rtsp_status(it.rtsp_link, cam, True, rid, mode, it.batch_id)
                    _mark(mode, bid)
                results.append({"camera": cam, "status": "updated", "mode": mode})

            elif surv.type == Operation.restart:
                if mode == "frame_reader":
                    restart_frame_reader(it)
                elif mode == "deepstream_single":
                    restart_deepstream_single(it)
                elif mode == "jewelry":
                    restart_jewelry(it)
                elif mode in _BATCH_MODES:
                    bid = (_rename_in_rtsp(cam, new, it.rtsp_link) if new != cam
                           else update_rtsp_status(it.rtsp_link, cam, True, rid, mode))
                    _mark(mode, bid)
                results.append({"camera": new, "status": "restarted", "mode": mode})

            elif surv.type == Operation.delete:
                if mode == "frame_reader":
                    stop_frame_reader(cam)
                    update_rtsp_status(it.rtsp_link, cam, False, rid)
                elif mode == "deepstream_single":
                    stop_deepstream_single(cam)
                    update_rtsp_status(it.rtsp_link, cam, False, rid)
                elif mode == "jewelry":
                    stop_jewelry(cam)
                    update_rtsp_status(it.rtsp_link, cam, False, rid)
                elif mode in _BATCH_MODES:
                    bid = update_rtsp_status(it.rtsp_link, cam, False, rid, mode)
                    _mark(mode, bid)
                cam_dir = os.path.join(AKSHA_PATH, cam)
                shutil.rmtree(cam_dir, ignore_errors=True)
                logger.info(f"Camera folder deleted | camera={cam} path={cam_dir}")
                results.append({"camera": cam, "status": "stopped", "mode": mode})

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Camera op failed | cam={cam} op={surv.type}: {e}")
            results.append({"camera": cam, "status": "error", "error": str(e)})

    # Signal affected pods once, after all rtsplinks.json writes are done
    for mode, bids in affected_batches.items():
        signal_pods(mode, bids, "/reload")
        logger.info(f"Reload sent | mode={mode} batches={sorted(bids)}")

    # Deleting a camera can leave its batch pod idle — remove it if so. This
    # only ever removes an already-empty batch (no cameras moved), so it runs
    # regardless of AUTO_REBALANCE.
    if surv.type == Operation.delete:
        for mode, bids in affected_batches.items():
            for bid in bids:
                _maybe_scale_down_after_delete(mode, bid)
            # Full consolidation (draining/moving cameras off OTHER batches
            # too, not just the one that just emptied) is the part that
            # actually rebalances — gated behind AUTO_REBALANCE so you can
            # test it manually via POST /pods/{mode}/reconcile before turning
            # it on for every delete.
            if AUTO_REBALANCE:
                _reconcile_batches(mode)

    return {"ok": True, "results": results}

# ── /Insight, /AlertReportAnalyzer, /ImageAnalysis ───────────────────────────

@app.post("/Insight")
def insight_endpoint(item: Insight):
    from . import insight
    try:
        result = insight.create_heatmap(
            Start_date=item.start_date, Start_time=item.start_time,
            End_date=item.end_date, End_time=item.end_time,
            Camera_name=item.camera_name, work_dir=AKSHA_PATH, logger=logger,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Insight failed: {e}")
    if result and result.startswith(("No frames found", "Failed to")):
        raise HTTPException(status_code=422, detail=result)
    return "Result processed for Insight (Heatmap)"

@app.post("/AlertReportAnalyzer")
def alert_report(req: AlertReportAnalyzer):
    try:
        from . import alert_report_analyzer
        result, mimetype, code = alert_report_analyzer.alert_report_analyzer(
            filtered_data=req.filtered_data, start_date=req.start_date,
            end_date=req.end_date, model_option=req.model_option, lang_option=req.lang_option,
        )
        return JSONResponse(content=result, status_code=code, media_type=mimetype)
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/ImageAnalysis")
def image_analysis_endpoint(req: ImageAnalysis):
    try:
        from . import image_analysis
        result, mimetype, code = image_analysis.imageanalysis(
            question=req.question, image=req.image,
            model_option=req.model_option, chat_history=req.chat_history or None,
        )
        return JSONResponse(content=result, status_code=code, media_type=mimetype)
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/DownloadImageAnalysisChat")
def download_chat(req: DownloadImageAnalysisChat):
    try:
        from . import image_analysis
        buf, headers, code = image_analysis.download_image_analysis_chat_logs(
            b64img=req.image, chat_history=req.chat_history or None,
        )
        if code == 200:
            return StreamingResponse(buf, headers=headers, media_type="application/zip")
        raise HTTPException(code, buf)
    except Exception as e:
        raise HTTPException(500, str(e))

# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=4000)
