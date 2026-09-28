"""
Aksha Health Agent
===================

Runs alongside the rest of the Aksha stack (see deployment/docker-compose.yml
and its docker-compose-*.yml variants). Every CHECK_INTERVAL_SECONDS:

  1. Confirms the core Aksha containers are running (frontend, backend, mongo,
     kafka, redis — fixed-name containers present in every deployment variant).
  2. Confirms at least one detection-pipeline container is running, matched by
     name pattern so this works across deployment versions without change:
     "object_detection"/"ppe_detection" (CPU-only v1 pipeline) or "deepstream"
     (any GPU/DeepStream v2 variant — deepstream-batch*, deepstream-nvinfer*,
     deepstream_cam*, etc. all contain "deepstream").
  3. Confirms outbound internet connectivity (a stopped/unreachable router
     upstream is itself a "system down" condition worth alerting on).

If everything is up, refreshes a heartbeat timestamp (system_up_timestamp) in
the Aksha_System_Health DynamoDB table for this site (SITE_ID); if any check
fails, that write is skipped so the timestamp ages naturally and the
EventBridge-triggered health-check Lambda alerts the configured emergency
contacts once it's stale for more than 15 minutes.

Separately, a per-cycle diagnostic snapshot (core_containers_ok,
missing_core_containers, pipeline_running, internet_reachable,
failed_checks, last_check_at) is written to the same item on *every* cycle,
healthy or not — this is what lets the alert email report *why* the system
is down, not just *that* it's stale (system_up_timestamp alone stops
updating once something fails, so it can't carry that detail on its own).
"""

import logging
import os
import socket
import time

import boto3
import docker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("health_agent")

AWS_REGION = os.getenv("AWS_REGION", "ap-south-1")
SITE_ID = os.getenv("SITE_ID")
HEALTH_TABLE_NAME = os.getenv("HEALTH_TABLE_NAME", "Aksha_System_Health")
CHECK_INTERVAL_SECONDS = int(os.getenv("CHECK_INTERVAL_SECONDS", "300"))

# Fixed-name containers present in every deployment variant (v1 CPU-only and
# every v2 GPU/DeepStream compose file) — see deployment/docker-compose*.yml.
CORE_CONTAINERS = [
    name.strip()
    for name in os.getenv(
        "CORE_CONTAINERS",
        "react_frontend,node_backend,mongodb,broker,redis",
    ).split(",")
    if name.strip()
]

# Name substrings for the detection pipeline — version-agnostic on purpose:
# "object_detection"/"ppe_detection" cover the CPU-only pipeline, "deepstream"
# covers every GPU variant (deepstream-batch*, deepstream-nvinfer*, deepstream_cam*).
# At least one container matching any one of these patterns must be running.
PIPELINE_CONTAINER_PATTERNS = [
    name.strip()
    for name in os.getenv(
        "PIPELINE_CONTAINER_PATTERNS",
        "object_detection,ppe_detection,deepstream",
    ).split(",")
    if name.strip()
]

INTERNET_CHECK_HOST = os.getenv("INTERNET_CHECK_HOST", "8.8.8.8")
INTERNET_CHECK_PORT = int(os.getenv("INTERNET_CHECK_PORT", "53"))
INTERNET_CHECK_TIMEOUT_SECONDS = float(os.getenv("INTERNET_CHECK_TIMEOUT_SECONDS", "3"))

if not SITE_ID:
    raise RuntimeError("SITE_ID env var is required — identifies this deployment's row in Aksha_System_Health")

dynamo = boto3.client(
    "dynamodb",
    region_name=AWS_REGION,
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)
docker_client = docker.from_env()


def _has_running_container_matching(name: str) -> bool:
    try:
        # containers.list() defaults to running containers only; the name
        # filter is a substring match, so this also covers replicated
        # services (Compose won't let those have a fixed container_name) and
        # numbered pods like deepstream-nvinfer1..10.
        return bool(docker_client.containers.list(filters={"name": name}))
    except docker.errors.APIError as exc:
        logger.warning("Error checking container %r: %s", name, exc)
        return False


def core_containers_missing() -> list:
    missing = [name for name in CORE_CONTAINERS if not _has_running_container_matching(name)]
    if missing:
        logger.warning("Missing/stopped core containers: %s", missing)
    return missing


def pipeline_is_running() -> bool:
    if any(_has_running_container_matching(pattern) for pattern in PIPELINE_CONTAINER_PATTERNS):
        return True
    logger.warning("No running detection-pipeline container found (checked patterns: %s)", PIPELINE_CONTAINER_PATTERNS)
    return False


def internet_is_reachable() -> bool:
    try:
        with socket.create_connection((INTERNET_CHECK_HOST, INTERNET_CHECK_PORT), timeout=INTERNET_CHECK_TIMEOUT_SECONDS):
            return True
    except OSError as exc:
        logger.warning("Internet connectivity check failed (%s:%s): %s", INTERNET_CHECK_HOST, INTERNET_CHECK_PORT, exc)
        return False


def write_status(*, healthy: bool, missing_containers: list, pipeline_ok: bool, internet_ok: bool, failed_checks: list) -> None:
    now_epoch = int(time.time())

    # Diagnostic snapshot — written every cycle, healthy or not, so the alert
    # email can explain *why* the system is down.
    update_expression = (
        "SET last_check_at = :now, "
        "core_containers_ok = :core_ok, "
        "missing_core_containers = :missing, "
        "pipeline_running = :pipeline_ok, "
        "internet_reachable = :internet_ok, "
        "failed_checks = :failed"
    )
    expression_values = {
        ":now": {"N": str(now_epoch)},
        ":core_ok": {"BOOL": not missing_containers},
        ":missing": {"S": ",".join(missing_containers)},
        ":pipeline_ok": {"BOOL": pipeline_ok},
        ":internet_ok": {"BOOL": internet_ok},
        ":failed": {"S": ",".join(failed_checks)},
    }

    # Heartbeat — only advances when every check passes; this is the field
    # the health-check Lambda compares against the 15-minute staleness window.
    if healthy:
        update_expression += ", system_up_timestamp = :now"

    dynamo.update_item(
        TableName=HEALTH_TABLE_NAME,
        Key={"siteId": {"S": SITE_ID}},
        UpdateExpression=update_expression,
        ExpressionAttributeValues=expression_values,
    )

    if healthy:
        logger.info("Heartbeat written (system_up_timestamp=%s)", now_epoch)
    else:
        logger.warning("Diagnostic snapshot written — failed checks: %s", ", ".join(failed_checks))


def run_forever() -> None:
    logger.info(
        "Starting health agent — site=%s table=%s interval=%ss core=%s pipeline_patterns=%s",
        SITE_ID, HEALTH_TABLE_NAME, CHECK_INTERVAL_SECONDS, CORE_CONTAINERS, PIPELINE_CONTAINER_PATTERNS,
    )
    while True:
        try:
            missing_containers = core_containers_missing()
            pipeline_ok = pipeline_is_running()
            internet_ok = internet_is_reachable()

            failed_checks = []
            if missing_containers:
                failed_checks.append("core containers")
            if not pipeline_ok:
                failed_checks.append("detection pipeline")
            if not internet_ok:
                failed_checks.append("internet")

            write_status(
                healthy=not failed_checks,
                missing_containers=missing_containers,
                pipeline_ok=pipeline_ok,
                internet_ok=internet_ok,
                failed_checks=failed_checks,
            )
        except Exception:
            logger.exception("Health check cycle failed")

        time.sleep(CHECK_INTERVAL_SECONDS)


if __name__ == "__main__":
    run_forever()
