"""
Aksha Notification Service — main.py
=====================================

Architecture Overview
---------------------
This service is the final delivery stage of the Aksha alert pipeline.  It
consumes the ``notification_service`` Kafka topic, which is written by the
post_processor service, and fans the payloads out to email (Gmail API) and
Telegram channels.  An optional result acknowledgement is published back to
the ``notification_results`` Kafka topic so upstream consumers can track
delivery.

Pipeline Diagram
~~~~~~~~~~~~~~~~
::

    post_processor
         |
         |  (Kafka topic: notification_service)
         v
    ┌─────────────────────────────────────────────────────────┐
    │          notification service  (this file)             │
    │                                                         │
    │   _poll_kafka  ──► asyncio.Queue ──► _process_single   │
    │                                           |             │
    │                          ┌────────────────┴──────────┐  │
    │                          │  individual notify        │  │
    │                          │  send_notifications()     │  │
    │                          │    └─► email_gmail()      │  │
    │                          │    └─► telegram()         │  │
    │                          ├───────────────────────────┤  │
    │                          │  group notify             │  │
    │                          │  notify_groups()          │  │
    │                          │    └─► notify_single_group│  │
    │                          │          └─► email_gmail()│  │
    │                          │          └─► telegram()   │  │
    │                          │          └─► expo()       │  │
    │                          │               ├─► S3 img  │  │
    │                          │               └─► DynamoDB│  │
    │                          │                  alert row│  │
    │                          └───────────────────────────┘  │
    │                                   |                     │
    │             Kafka topic: notification_results ◄──────── │
    └─────────────────────────────────────────────────────────┘

Concurrency Model
-----------------
A single ``asyncio`` event loop drives all I/O.  CPU-blocking work (Kafka
poll, MongoDB queries) is offloaded via ``loop.run_in_executor`` so they
never stall the event loop.

``WORKER_COUNT`` controls how many messages may be processed simultaneously
via an ``asyncio.Semaphore``.  ``QUEUE_MAXSIZE`` creates back-pressure so a
burst of Kafka messages cannot exhaust memory — the poll coroutine will
block on ``await queue.put(msg)`` once the queue is full.

Key Tuning Parameters
---------------------
* ``WORKER_COUNT   = 8``   — max simultaneous in-flight notification tasks
* ``QUEUE_MAXSIZE  = 50``  — asyncio queue depth; limits memory under burst
* ``GROUP_CACHE_TTL = 60`` — seconds before MongoDB group config is re-fetched
* ``GROUP_TG_RATE_LIMIT = 30`` — minimum seconds between Telegram messages
  sent to the same (group_id, camera) pair; prevents Telegram bot rate-limit
  errors (HTTP 429) during sustained alert bursts

Stale-Notification Drop
-----------------------
After dequeuing a message, ``_process_single`` computes
``age = now - message_timestamp``.  If ``age > 120 seconds`` the message is
silently discarded and a warning is logged.  This prevents a backlog drain
from delivering hundreds of stale alerts after a service restart.

Mobile push / alert-history (new)
----------------------------------
Camera groups with ``mobile_app.enabled`` now carry both the resolved Expo
``push_tokens`` *and* the raw ``mobile_ids`` they came from (see
``fetch_group_notifications``). ``notify_single_group`` forwards
``mobile_ids`` together with ``group_id``, ``group_name``, and ``DataPath``
into ``expo()`` (see ``socialPlatforms/expo.py``), which uses them to
upload the alert image to S3 and persist a per-group alert-history row to
DynamoDB (with a TTL controlled by ``ALERTS_TTL_DAYS``) before sending the
push — matching what the legacy ``notifications.py`` did in
``send_mobile_push_async``.
"""

import numpy as np
from kafka import KafkaConsumer, KafkaProducer
import cv2, datetime as dt, os, json, asyncio, yaml, configparser, time
import logging
import sys
from utils import send, error_notification, NotificationUtils
from socialPlatforms.email import email_gmail
from socialPlatforms.telegram import telegram
from socialPlatforms.expo import expo, fetch_expo_tokens_from_dynamo
from dotenv import load_dotenv
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

# -------------------- STARTUP CONFIG --------------------

WORKER_COUNT = 8       # concurrent notification workers
QUEUE_MAXSIZE = 50     # back-pressure buffer — keep small so stale burst can't queue 500 messages
GROUP_CACHE_TTL = 60   # seconds to cache MongoDB group lookups
GROUP_TG_RATE_LIMIT = 30  # minimum seconds between group telegram sends per (group_id, camera)

# In-process rate-limit tracker: maps (group_id, camera) -> last send epoch (float).
# Checked and updated inside notify_single_group() before each Telegram dispatch.
_group_tg_last_sent: dict = {}  # (group_id, camera) -> last send epoch

main_dir = os.environ.get("AKSHA_PATH")
if main_dir and not main_dir.endswith("/"):
    main_dir = main_dir + "/"
camera_name = "notification_service"
logger_path = f"{main_dir}/log"
os.makedirs(logger_path, exist_ok=True)

# -------------------- LOGGER --------------------

def define_logger(logger_path):
    """Configure and return a rotating, gzip-compressed file logger.

    Creates one log file per hostname so multiple containers writing to a
    shared volume do not interleave writes.  Files rotate at midnight;
    completed log files are gzip-compressed by a custom rotator and kept
    for 30 days (``backupCount=30``).

    Args:
        logger_path (str): Directory in which log files will be written.
            Created automatically if it does not exist.

    Returns:
        logging.Logger: Configured logger instance named
        ``"notification<hostname>"``.
    """
    import logging.handlers, gzip, shutil, socket
    os.makedirs(logger_path, exist_ok=True)

    # Use the container/machine hostname so log filenames are unique per node.
    _hostname = socket.gethostname()
    log_file = f"{logger_path}/notification{_hostname}.log"

    # Standard timestamped formatter for every log record.
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

    # Rotate at midnight, keep 30 compressed backups, use UTF-8 encoding.
    handler = logging.handlers.TimedRotatingFileHandler(
        filename=log_file, when='midnight', interval=1, backupCount=30, encoding='utf-8'
    )

    # Custom rotator: gzip-compress the rolled file and delete the uncompressed source.
    def _rotator(source, dest):
        with open(source, 'rb') as f_in, gzip.open(dest, 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)
        os.remove(source)

    handler.rotator = _rotator                    # override default plain-copy rotator
    handler.namer = lambda n: n + ".gz"           # append .gz extension to rotated filenames
    handler.setFormatter(fmt)

    logger = logging.getLogger(f"notification{_hostname}")
    logger.setLevel(logging.INFO)
    logger.propagate = False                       # prevent double-logging via root logger

    # Guard against duplicate handlers if define_logger() is called more than once.
    if not logger.handlers:
        logger.addHandler(handler)
    return logger

logger = define_logger(logger_path)

# -------------------- KAFKA CONFIG --------------------

def load_kafka_config():
    """Resolve the Kafka bootstrap server address from the environment.

    Applies the same three-tier resolution strategy used by post_processor:

    1. ``KAFKA_BOOTSTRAP_SERVERS`` environment variable — used if set (covers
       both Docker Compose and Kubernetes deployments where the variable is
       injected).
    2. Docker fallback — if ``/.dockerenv`` is present the service is running
       inside Docker without the env var; use the Compose service name
       ``broker:9092``.
    3. Local dev fallback — use ``localhost:9092``.

    Returns:
        str: Kafka bootstrap server string, e.g. ``"broker:9092"``.
    """
    # Diagnostic prints are intentionally flush=True so they appear immediately
    # in container stdout logs even when Python's buffering is active.
    print(f"KAFKA_BOOTSTRAP_SERVERS env: {os.environ.get('KAFKA_BOOTSTRAP_SERVERS')}", flush=True)
    print(f"Running in Docker: {os.path.exists('/.dockerenv')}", flush=True)

    KAFKA_SERVER = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not KAFKA_SERVER:
        print("KAFKA_BOOTSTRAP_SERVERS not set in environment, using fallback...", flush=True)
        if os.path.exists("/.dockerenv"):
            # Inside Docker Compose network — the broker is reachable by its service name.
            KAFKA_SERVER = "broker:9092"
        else:
            # Local development machine with a locally-running Kafka.
            KAFKA_SERVER = "localhost:9092"
    else:
        print(f"Using KAFKA_SERVER from environment: {KAFKA_SERVER}", flush=True)
    return KAFKA_SERVER


KAFKA_SERVER = load_kafka_config()

# Topic this service reads alert payloads from (written by post_processor).
INPUT_TOPIC = "notification_service"
# Topic this service writes delivery acknowledgements to.
OUTPUT_TOPIC = "notification_results"
# MongoDB connection string injected at runtime; used for group config lookups.
MONGODB_URI = os.environ.get("MONGODB_URI")

logger.info(
    f"Notification service starting | KAFKA={KAFKA_SERVER} | MONGODB_URI={MONGODB_URI} "
    f"| main_dir={main_dir} | WORKER_COUNT={WORKER_COUNT} | QUEUE_MAXSIZE={QUEUE_MAXSIZE}"
)

# -------------------- KAFKA CLIENTS --------------------

def create_kafka_clients():
    """Create and return a connected Kafka producer and consumer pair.

    Blocks in a retry loop until the Kafka broker accepts connections.
    This is necessary because in Docker Compose the broker container may
    still be initialising when the notification service starts.

    Consumer configuration notes:
    * ``group_id="notification_group"`` — all replicas of this service share
      the same consumer group so messages are load-balanced, not duplicated.
    * ``auto_offset_reset="earliest"`` — on first start (or after an offset
      reset) consume from the beginning of the topic so no alerts are missed.
    * ``max_poll_records=10`` — limits batch size per poll to avoid very large
      in-memory buffers when the topic has a deep backlog.
    * ``fetch_max_bytes=52428800`` — 50 MB fetch limit; each message carries a
      JPEG path reference so actual sizes are small, but headroom is generous.

    Returns:
        tuple[KafkaProducer, KafkaConsumer]: Ready-to-use producer and
        consumer instances.
    """
    # Stage: retry loop — Kafka may not be ready at container startup
    while True:
        try:
            logger.info(f"Creating Kafka producer and consumer | server={KAFKA_SERVER} | input_topic={INPUT_TOPIC}")

            # Producer serialises Python dicts to JSON bytes automatically.
            producer = KafkaProducer(
                bootstrap_servers=KAFKA_SERVER,
                value_serializer=lambda v: json.dumps(v).encode("utf-8")
            )

            # Consumer reads notification payloads; JSON bytes are decoded to dicts.
            consumer = KafkaConsumer(
                INPUT_TOPIC,
                bootstrap_servers=KAFKA_SERVER,
                group_id="notification_group",
                auto_offset_reset="earliest",
                enable_auto_commit=True,     # offsets committed automatically after each poll
                max_poll_records=10,
                fetch_max_bytes=52428800,
                value_deserializer=lambda x: json.loads(x.decode("utf-8"))
            )

            logger.info(f"Connected to Kafka successfully | input={INPUT_TOPIC} | output={OUTPUT_TOPIC}")
            return producer, consumer

        except Exception as e:
            logger.error(f"Kafka not ready, retrying in 5s... {e}")
            time.sleep(5)

# -------------------- HELPERS --------------------

class NotificationNamespace:
    """Lightweight mutable carrier for the Gmail thread ID.

    Gmail reply-chaining requires the same ``threadId`` to be passed with
    every message in a conversation.  Because ``send_notifications`` is an
    async coroutine that may run concurrently with other coroutines, passing
    the thread ID through this namespace object (rather than a plain string)
    lets the email coroutine write back the newly-assigned thread ID via
    attribute mutation, which the caller can then persist.

    Attributes:
        threadId (str | None): The Gmail thread ID for reply chaining.
            ``None`` means no thread has been started yet (first email in a
            new conversation).
    """

    def __init__(self, thread_id=None):
        # Initialise with the current known thread ID (may be None for first email).
        self.threadId = thread_id

    def __repr__(self):
        return f"NotificationNamespace(threadId={self.threadId})"

def load_config():
    """Load service credentials from ``dev.json`` located next to this file.

    ``dev.json`` contains secrets such as Azure Blob Storage connection
    strings, OAuth client IDs, and app-specific IDs used for Google Drive
    folder resolution.  The file is not committed to source control and must
    be present at runtime.

    Returns:
        dict: Parsed JSON credentials dictionary, or an empty dict if the
        file is missing.
    """
    # Stage: load dev.json service credentials (blob storage, OAuth keys, etc.)
    p = os.path.join(os.path.dirname(__file__), "dev.json")
    if not os.path.exists(p):
        logger.error(f"Config file not found: {p}")
        return {}
    with open(p) as f:
        return json.load(f)

def get_thread_id_from_config():
    """Read the current Gmail thread ID from ``app.config``.

    Gmail reply-chaining works by including the previous message's
    ``threadId`` in the ``send`` request.  The thread ID is persisted in
    ``[Client_data] threadId`` inside ``app.config`` so it survives service
    restarts.

    Returns:
        str | None: The stored Gmail thread ID, or ``None`` if the file does
        not exist or the key is absent.
    """
    # Stage: read Gmail thread ID from app.config to chain notification emails in one thread
    try:
        p = f"{main_dir}/app.config"
        if os.path.exists(p):
            c = configparser.RawConfigParser(strict=False)
            c.read(p)
            tid = c.get("Client_data", "threadId", fallback=None)
            logger.info(f"Read threadId from config: {tid}")
            return tid
    except Exception as e:
        logger.error(e)
    return None

def update_thread_id_in_config(thread_id):
    """Persist a new Gmail thread ID to ``app.config``.

    Called after each successful email send so the next notification is
    dispatched as a reply in the same Gmail thread rather than opening a new
    conversation.  The ``[Client_data]`` section is created if absent.

    Args:
        thread_id (str): The Gmail thread ID returned by the Gmail API after
            the most recent send.

    Returns:
        bool: ``True`` on success, ``False`` if writing the config file
        failed for any reason.
    """
    # Stage: persist new Gmail thread ID so subsequent emails reply in the same thread
    try:
        p = f"{main_dir}/app.config"
        c = configparser.RawConfigParser()
        if os.path.exists(p):
            c.read(p)          # preserve any existing keys in the file
        if not c.has_section("Client_data"):
            c.add_section("Client_data")
        c.set("Client_data", "threadId", str(thread_id))
        with open(p, "w") as f:
            c.write(f)
        logger.info(f"Updated threadId in app.config: {thread_id}")
        return True
    except Exception as e:
        logger.error(e)
        return False

# -------------------- GROUP NOTIFICATIONS --------------------

def fetch_group_notifications(db, camera_name=None):
    """Query MongoDB and return all camera groups that should receive an alert.

    Performs a three-collection join:

    1. ``camera_notification_managers`` — top-level documents that record
       which groups have ``alerts_enabled: True`` and carry per-channel
       (email/mobile/telegram) configuration.
    2. ``camera_groups`` — resolves a ``camera_group_id`` to the list of
       camera IDs that belong to the group.
    3. ``config`` — resolves each camera ID to its ``Camera_Name`` and
       ``Rtsp_Link`` so the result can be filtered by the incoming camera
       name.

    If ``camera_name`` is supplied, only groups that contain a camera with
    that exact name are returned.  This prevents spurious notifications to
    groups that are not watching the triggering camera.

    Each returned group dict contains:
    * ``camera_group_id``, ``group_name``, ``priority_type``, timestamps
    * ``cameras`` — list of ``{camera_id, camera_name, rtsp_link}``
    * ``email`` (optional) — ``{email_list}`` if the email channel is enabled
    * ``mobile`` (optional) — ``{mobile_numbers}`` if mobile channel enabled
    * ``telegram`` (optional) — ``{bot_token, chat_id}`` if telegram enabled
    * ``mobile_app`` (optional) — ``{enabled, push_tokens, mobile_ids}`` if
      the Expo push channel is enabled and at least one push token
      resolved. ``mobile_ids`` is the raw, comma-split ID list the tokens
      were resolved from — kept alongside ``push_tokens`` so downstream
      code (S3 upload / DynamoDB alert-history save in ``expo()``) can key
      off the original mobile_ids rather than the opaque tokens.

    Args:
        db: PyMongo ``Database`` instance pointing at the Aksha database.
        camera_name (str | None): Name of the camera that triggered the
            alert.  Pass ``None`` to return groups for all cameras.

    Returns:
        list[dict]: Zero or more group configuration dicts ready for use by
        ``notify_single_group``.
    """
    # Stage: query MongoDB for all camera groups with alerts enabled, filter by camera
    try:
        from bson import ObjectId

        # The three collections involved in the join.
        notification_collection = db["camera_notification_managers"]
        group_collection = db["camera_groups"]
        camera_collection = db["config"]

        # Fetch all alert-enabled notification manager documents.
        cursor = notification_collection.find({"alerts_enabled": True})
        all_docs = list(cursor)

        groups = []

        for doc in all_docs:
            camera_group_id = doc["camera_group_id"]

            # Resolve group_id -> group document to access the camera list.
            group_doc = group_collection.find_one({"_id": ObjectId(camera_group_id)})

            if not group_doc:
                logger.warning(f"[group] group_id={camera_group_id} not found in camera_groups")
                continue

            # Extract the list of camera ObjectIds stored inside the group.
            camera_ids = [
                cam["camera_id"]
                for cam in group_doc.get("cameras", [])
            ]

            # Stage: fetch camera names from config collection to match against incoming camera
            group_cameras = []
            if camera_ids:
                # Batch-fetch only the fields we need to minimise network transfer.
                cameras_cursor = camera_collection.find(
                    {"_id": {"$in": camera_ids}},
                    {"Camera_Name": 1, "Rtsp_Link": 1}
                )
                for cam in cameras_cursor:
                    group_cameras.append({
                        "camera_id": str(cam["_id"]),
                        "camera_name": cam.get("Camera_Name"),
                        "rtsp_link": cam.get("Rtsp_Link"),
                    })

            cam_names_in_group = [c["camera_name"] for c in group_cameras]
            logger.info(f"[group] group_id={camera_group_id} | cameras_in_group={cam_names_in_group}")

            # Skip this group if the triggering camera is not in the group's camera list.
            if camera_name and camera_name not in cam_names_in_group:
                logger.info(f"[group] camera={camera_name} not in group={camera_group_id}, skipping")
                continue

            # Stage: build group dict with email/mobile/telegram channels if enabled
            group = {
                "camera_group_id": str(camera_group_id),
                "group_name": group_doc.get("group_name"),
                "priority_type": group_doc.get("priority_type"),
                "alerts_enabled": True,
                "created_at": doc.get("created_at"),
                "updated_at": doc.get("updated_at"),
                "cameras": group_cameras
            }

            # Attach email config only when the channel is explicitly enabled.
            email_cfg = doc.get("email")
            if email_cfg and email_cfg.get("enabled"):
                group["email"] = {
                    "email_list": email_cfg.get("email_list", "")
                }
                logger.info(f"[group] MATCHED group_id={camera_group_id} camera={camera_name} | email={email_cfg.get('email_list')}")

            # Attach mobile config only when the channel is explicitly enabled.
            mobile_cfg = doc.get("mobile")
            if mobile_cfg and mobile_cfg.get("enabled"):
                group["mobile"] = {
                    "mobile_numbers": mobile_cfg.get("mobile_numbers", "")
                }

            # Attach telegram config only when the channel is explicitly enabled.
            telegram_cfg = doc.get("telegram")
            if telegram_cfg and telegram_cfg.get("enabled"):
                group["telegram"] = {
                    "bot_token": telegram_cfg.get("bot_token", ""),
                    "chat_id": telegram_cfg.get("chat_id", "")
                }
                logger.info(f"[group] MATCHED group_id={camera_group_id} camera={camera_name} | telegram chat_id={telegram_cfg.get('chat_id')}")

            # Attach mobile_app (Expo push) config only when enabled.
            # `mobile_ids` is kept alongside the resolved `push_tokens` (not
            # just the tokens) so notify_single_group() can forward the raw
            # IDs into expo() — they're required for the S3 key layout and
            # the DynamoDB alert-history row's `mobileIds` field.
            mobile_app_cfg = doc.get("mobile_app")
            if mobile_app_cfg and mobile_app_cfg.get("enabled"):
                raw_ids = mobile_app_cfg.get("mobile_ids", "")
                mobile_ids = [t.strip() for t in raw_ids.split(",") if t.strip()]

                push_tokens = fetch_expo_tokens_from_dynamo(mobile_ids, logger)
                if push_tokens:
                    group["mobile_app"] = {
                        "enabled":      True,
                        "push_tokens":  push_tokens,
                        "mobile_ids":   mobile_ids,
                    }
                    logger.info(f"[group] MATCHED group_id={camera_group_id} camera={camera_name} | expo tokens={len(push_tokens)} mobile_ids={len(mobile_ids)}")
                else:
                    logger.warning(f"[group] group_id={camera_group_id} mobile_app enabled but no resolvable tokens for mobile_ids={mobile_ids}")

            groups.append(group)

        logger.info(f"[group] camera={camera_name} | total matched groups={len(groups)}")
        return groups

    except Exception as e:
        logger.error(f"[group] fetch_group_notifications failed: {e}", exc_info=True)
        return []


# Module-level cache: camera_name -> (cached_at_epoch, groups_list).
# Populated by fetch_group_notifications_cached() and invalidated on TTL expiry.
_group_cache: dict = {}

def fetch_group_notifications_cached(db, camera_name):
    """Return group notification config for a camera, using a TTL in-memory cache.

    MongoDB group lookups involve three collections and can be slow under
    concurrent load.  This wrapper caches the result per camera name for
    ``GROUP_CACHE_TTL`` seconds.  After expiry, the next call re-fetches from
    MongoDB and refreshes the cache entry.

    Cache misses are logged at INFO level; cache hits include the age of the
    cached entry for diagnostic purposes.

    Args:
        db: PyMongo ``Database`` instance.
        camera_name (str): Camera name used as the cache key.

    Returns:
        list[dict]: Cached or freshly-fetched group configuration list.
    """
    # Stage: return cached group list if fresh (< GROUP_CACHE_TTL seconds), else re-fetch
    now = time.time()
    if camera_name in _group_cache:
        cached_at, groups = _group_cache[camera_name]
        if now - cached_at < GROUP_CACHE_TTL:
            logger.info(f"[group_cache] HIT camera={camera_name} | age={now - cached_at:.1f}s < ttl={GROUP_CACHE_TTL}s")
            return groups
    logger.info(f"[group_cache] MISS camera={camera_name} — fetching from MongoDB")
    groups = fetch_group_notifications(db, camera_name)
    # Store the current timestamp alongside the result so future calls can compute age.
    _group_cache[camera_name] = (now, groups)
    return groups


async def notify_single_group(group, camera, Type, sender, DataPath, timestamp, namespace, logger):
    """Dispatch email, Telegram, and/or Expo push notifications for one camera group.

    Builds a task list from the channels enabled in the group configuration
    dict and runs them concurrently via ``asyncio.gather``.

    Telegram rate-limiting: before queuing the Telegram task, the
    ``(group_id, camera)`` pair is looked up in ``_group_tg_last_sent``.  If
    fewer than ``GROUP_TG_RATE_LIMIT`` seconds have passed since the last
    send, the Telegram task is skipped for this cycle to avoid HTTP 429
    responses from the Telegram Bot API.

    Email recipients are parsed from the comma-separated
    ``group["email"]["email_list"]`` string.  Entries that are empty after
    stripping whitespace are filtered out.

    Mobile push (Expo): ``group_id``, ``group_name``, and ``DataPath`` are
    passed into ``expo()`` alongside the group's resolved ``push_tokens``
    and raw ``mobile_ids``, so ``expo()`` can upload the alert image to S3
    and save a DynamoDB alert-history row before sending the push — see
    ``socialPlatforms/expo.py``.

    Args:
        group (dict): Group config as returned by ``fetch_group_notifications``.
        camera (str): Camera name that triggered the alert.
        Type (str): Alert type string (e.g. ``"Alert"``, ``"AutoAlert"``).
        sender (str): Gmail sender address used by ``email_gmail``.
        DataPath (str): Path to the notification image / data directory.
        timestamp (str): Human-readable timestamp for the alert.
        namespace (NotificationNamespace): Mutable thread-ID carrier for
            Gmail reply chaining.
        logger: Logger instance (passed explicitly so group helpers share the
            main service logger rather than creating their own).
    """
    # Stage: dispatch email and/or telegram notifications for one camera group
    tasks = []
    gid = group.get("camera_group_id", "unknown")

    # Parse the comma-separated email list; filter blanks produced by trailing commas.
    recipients = [
        e.strip()
        for e in group.get("email", {}).get("email_list", "").split(",")
        if e.strip()
    ]

    logger.info(
        f"[group_notify] group_id={gid} camera={camera} Type={Type} "
        f"email_recipients={recipients} "
        f"telegram_enabled={bool(group.get('telegram', {}).get('bot_token') and group.get('telegram', {}).get('chat_id'))}"
    )

    if recipients:
        tasks.append(
            email_gmail(
                subscription=gid,
                recipients=recipients,
                sender_email=sender,
                camera=camera,
                Type=Type,
                DataPath=DataPath,
                Timestamp=timestamp,
                RTSP_Link=None,
                RTSP_bool=True,
                logger=logger,
                alert_notification_validity=[True],
                alert=["Alert"],
                description=[f"Group alert {camera}"],
                namespace=namespace,
            )
        )
    else:
        logger.warning(f"[group_notify] group_id={gid} has no email recipients, skipping email")

    tg = group.get("telegram", {})
    if tg.get("bot_token") and tg.get("chat_id"):
        now = time.time()
        # Rate-limit key is (group_id, camera) so different cameras in the
        # same group each have an independent rate-limit bucket.
        rate_key = (gid, camera)
        last = _group_tg_last_sent.get(rate_key, 0)
        elapsed = now - last
        if elapsed < GROUP_TG_RATE_LIMIT:
            # Too soon after the last send — skip to avoid Telegram 429 errors.
            logger.info(f"[group_notify] skipping telegram group_id={gid} camera={camera} rate_limit elapsed={elapsed:.1f}s < {GROUP_TG_RATE_LIMIT}s")
        else:
            # Record the current timestamp before dispatching so concurrent
            # coroutines for the same key also see the rate limit immediately.
            _group_tg_last_sent[rate_key] = now
            logger.info(f"[group_notify] queuing telegram task group_id={gid} chat_id={tg.get('chat_id')}")
            tasks.append(
                telegram(
                    subscription=gid,
                    camera=camera,
                    Type=Type,
                    DataPath=DataPath,
                    Timestamp=timestamp,
                    RTSP_Link=None,
                    RTSP_bool=True,
                    logger=logger,
                    alert_notification_validity=[True],
                    alert=["Alert"],
                    description=[f"Group alert {camera}"],
                    telegram_service={
                        "service_status": True,
                        "chat_ids": [tg.get("chat_id")],
                        "bot_token": tg.get("bot_token")
                    }
                )
            )
    else:
        logger.info(f"[group_notify] group_id={gid} telegram not configured, skipping")

    mobile_app = group.get("mobile_app", {})
    if mobile_app.get("enabled") and mobile_app.get("push_tokens"):
        tasks.append(
            expo(
                subscription=gid,
                camera=camera,
                Type=Type,
                Timestamp=timestamp,
                logger=logger,
                alert_notification_validity=[True],
                alert=["Alert"],
                description=[f"Group alert {camera}"],
                expo_service={
                    "service_status": True,
                    "push_tokens": mobile_app["push_tokens"],
                    "mobile_ids": mobile_app.get("mobile_ids", []),
                },
                # Threaded through so expo() can upload the alert image to
                # S3 and save a DynamoDB alert-history row (save_group_alert_details)
                # before sending the push — see socialPlatforms/expo.py.
                group_id=gid,
                group_name=group.get("group_name"),
                DataPath=DataPath,
            )
        )
    else:
        logger.info(f"[group_notify] group_id={gid} mobile_app not configured or disabled, skipping expo push")

    if not tasks:
        logger.warning(f"[group_notify] group_id={gid} no tasks to run (no email, telegram, or expo push)")
        return

    # Run all channels concurrently; capture exceptions so one failing channel
    # does not prevent the others from delivering.
    logger.info(f"[group_notify] running {len(tasks)} task(s) for group_id={gid}")
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            logger.error(f"[group_notify] task[{i}] group_id={gid} FAILED: {r}", exc_info=r)
        else:
            logger.info(f"[group_notify] task[{i}] group_id={gid} OK result={r}")


async def notify_groups(groups, camera, Type, sender, DataPath, timestamp, namespace, logger):
    """Fan out a single alert to all matched camera groups concurrently.

    Creates one ``notify_single_group`` coroutine per group and gathers them
    with ``asyncio.gather(..., return_exceptions=True)`` so a failure in one
    group's delivery does not prevent other groups from receiving the alert.

    Args:
        groups (list[dict]): Group config list as returned by
            ``fetch_group_notifications_cached``.
        camera (str): Camera name that triggered the alert.
        Type (str): Alert type string.
        sender (str): Gmail sender address.
        DataPath (str): Path to notification image / data directory.
        timestamp (str): Human-readable alert timestamp.
        namespace (NotificationNamespace): Mutable Gmail thread-ID carrier.
        logger: Shared logger instance.
    """
    # Stage: fan out to all matched camera groups concurrently
    logger.info(f"[group_notify] notify_groups camera={camera} Type={Type} groups={len(groups)}")
    tasks = [
        notify_single_group(g, camera, Type, sender, DataPath, timestamp, namespace, logger)
        for g in groups
    ]
    # return_exceptions=True ensures all group tasks run even if some raise.
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            logger.error(f"[group_notify] group[{i}] camera={camera} FAILED: {r}", exc_info=r)

# -------------------- SEND NOTIFICATIONS (INDIVIDUAL) --------------------

async def send_notifications(
    camera_name, timestamp, Type,
    recipients, sender_email,
    DataPath, thread_id=None
):
    """Build and dispatch individual (non-group) email and Telegram notifications.

    This function handles notifications for a single camera's alert.  It is
    distinguished from the group notification path in that recipients and
    Telegram credentials come from the globally-initialised ``notif_utils``
    and ``telegram_service`` objects (loaded from MongoDB ``Resource``
    collection at startup) rather than from per-group MongoDB documents.

    A ``NotificationNamespace`` is created to carry the Gmail thread ID so
    the email coroutine can write back a new thread ID after the first send.
    The updated thread ID is persisted to ``app.config`` after the gather
    completes.

    Args:
        camera_name (str): Name of the camera that generated the alert.
        timestamp (datetime.datetime): Alert event time.
        Type (str): Alert type string (e.g. ``"Alert"``).
        recipients (list[str]): Email addresses to notify.
        sender_email (str): Gmail sender address (must match the OAuth token
            stored in ``keys.yaml``).
        DataPath (str): Filesystem path to the notification image directory.
        thread_id (str | None): Gmail thread ID for reply chaining.  ``None``
            starts a new conversation.

    Returns:
        str | None: The Gmail thread ID returned by the email coroutine, or
        ``None`` if no thread ID was produced.
    """
    # Stage: build and dispatch notification tasks for email + telegram (individual, not group)
    logger.info(
        f"send_notifications | camera={camera_name} | Type={Type} "
        f"| recipients={recipients} | thread_id={thread_id}"
    )
    if not recipients:
        logger.error("No recipients configured")
        return None

    # Namespace carries thread_id; the email coroutine may mutate namespace.threadId
    # after sending so we can persist the new ID.
    namespace = NotificationNamespace(thread_id)
    tasks = []

    # Stage: always queue email task
    logger.info(f"Queuing email task | camera={camera_name} | to={recipients}")
    tasks.append(
        email_gmail(
            subscription="notification_results",
            recipients=recipients,
            sender_email=sender_email,
            camera=camera_name,
            Type=Type,
            DataPath=DataPath,
            Timestamp=str(timestamp)[:-4],   # trim microseconds for display
            RTSP_Link=None,
            RTSP_bool=True,
            logger=logger,
            alert_notification_validity=["valid"],
            alert=["Alert"],
            description=[f"Notification sent for camera {camera_name}"],
            namespace=namespace,
            main_dir=main_dir
        )
    )

    # Stage: queue telegram task if service is active
    # Both the module-level notif_utils flag AND the telegram_service dict must
    # confirm the service is active before queueing.
    if notif_utils.telegram_service_status and telegram_service.get("service_status"):
        logger.info(f"Queuing telegram task | camera={camera_name} | chat_ids={telegram_service.get('chat_ids')}")
        tasks.append(
            telegram(
                subscription="notification_results",
                camera=camera_name,
                Type=Type,
                DataPath=DataPath,
                Timestamp=str(timestamp)[:-4],   # trim microseconds for display
                RTSP_Link=None,
                RTSP_bool=True,
                logger=logger,
                alert_notification_validity=["valid"],
                alert=["Alert"],
                description=[f"Notification sent for camera {camera_name}"],
                telegram_service={
                    "service_status": telegram_service.get("service_status"),
                    "chat_ids": telegram_service.get("chat_ids"),
                    "bot_token": telegram_service.get("bot_token")
                }
            )
        )

    logger.info(f"Running {len(tasks)} notification task(s) | camera={camera_name}")
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results:
        if isinstance(r, Exception):
            logger.error(r)

    # If the email coroutine populated namespace.threadId, persist it for the next send.
    if namespace.threadId:
        update_thread_id_in_config(namespace.threadId)
        return namespace.threadId

    return None

# -------------------- PROCESS SINGLE MESSAGE --------------------

async def _process_single(msg, recipients, sender, thread_id_ref, db, sem):
    """Core per-message handler: validate, staleness-check, notify, acknowledge.

    This coroutine is created as an ``asyncio.Task`` for every message
    dequeued from the internal queue.  The semaphore ``sem`` bounds the number
    of simultaneously running coroutines to ``WORKER_COUNT``, providing both
    concurrency and back-pressure.

    Processing pipeline
    ~~~~~~~~~~~~~~~~~~~
    1. **Deserialise** — extract ``frame_id``, ``camera``, ``Type``,
       ``Timestamp`` from ``msg.value``.
    2. **Validate** — drop messages missing required fields.
    3. **Staleness check** — if the alert timestamp is more than 120 seconds
       in the past, discard with a warning.  This prevents a backlog drain
       from sending hundreds of outdated alerts after a service restart.
    4. **Notify concurrently** — ``_individual()`` and ``_group()`` run
       together via ``asyncio.gather`` so slow SMTP delivery does not delay
       Telegram group messages.
    5. **Persist thread ID** — if ``send_notifications`` returned a new Gmail
       thread ID, update the shared ``thread_id_ref`` list so the next
       message continues the same reply thread.
    6. **Acknowledge** — publish a ``{"status": "success", ...}`` record to
       ``OUTPUT_TOPIC`` so upstream consumers can confirm delivery.

    Args:
        msg: A Kafka ``ConsumerRecord`` whose ``.value`` is a dict containing
            ``frame_id``, ``camera``, ``Type``, and ``Timestamp``.
        recipients (list[str]): Email addresses for individual notifications.
        sender (str): Gmail sender address.
        thread_id_ref (list): Single-element mutable list holding the current
            Gmail thread ID.  Using a list allows workers to share and update
            the value without a global variable.
        db: PyMongo ``Database`` instance for group config lookups.
        sem (asyncio.Semaphore): Concurrency gate; set to ``WORKER_COUNT``.
    """
    async with sem:
        try:
            p = msg.value
            frame_id = p.get("frame_id")
            cam = p.get("camera")
            Type = p.get("Type")
            ts = p.get("Timestamp")

            # Stage: validate required fields before processing
            if not all([cam, Type, ts]) or (Type != "PPE Alert" and not frame_id):
                logger.warning(f"[RECEIVED] incomplete message — frame_id={frame_id} cam={cam} Type={Type} ts={ts}, skipping")
                return

            try:
                # Parse ISO-format timestamp with microseconds; fall back to now on error.
                timestamp = dt.datetime.strptime(ts, "%Y-%m-%d %H:%M:%S.%f")
            except Exception:
                timestamp = dt.datetime.now()

            logger.info(
                f"[NOTIFICATION RECEIVED] frame_id={frame_id} | camera={cam} "
                f"| Type={Type} | timestamp={timestamp}"
            )

            # Stage: drop stale notifications — if incident time is >120s old, skip sending
            # to prevent delayed delivery of alerts from backlog drain periods.
            try:
                notification_age = (dt.datetime.now() - timestamp).total_seconds()
                if notification_age > 120:
                    logger.warning(
                        f"[STALE NOTIFICATION DROPPED] frame_id={frame_id} | camera={cam} "
                        f"| age={notification_age:.1f}s — skipped"
                    )
                    return
            except Exception as e:
                logger.warning(f"Staleness check failed in notification: {e}")

            # Create a fresh namespace for this message; seed it with the current thread ID
            # so any email sent by this message continues the existing Gmail thread.
            namespace = NotificationNamespace(thread_id_ref[0])
            loop = asyncio.get_event_loop()

            # Stage: run individual notify + group fetch concurrently so slow email
            # SMTP does not delay group Telegram delivery.
            async def _individual():
                # Only send individual notifications for plain "Alert" type events.
                if Type in ["Alert", "PPE Alert"]:
                    return await send_notifications(
                        cam, timestamp, Type,
                        recipients, sender,
                        main_dir, thread_id_ref[0]
                    )
                return None

            async def _group():
                # Group notifications cover a wider set of alert types including
                # "No Object Alert" and "AutoAlert" in addition to standard "Alert".
                if Type in ["Alert", "No Object Alert", "AutoAlert"]:
                    logger.info(f"[group_notify] fetching groups for camera={cam} Type={Type}")
                    # run_in_executor offloads the blocking MongoDB call so the event loop
                    # remains responsive during the network round-trip.
                    groups = await loop.run_in_executor(
                        None, fetch_group_notifications_cached, db, cam
                    )
                    logger.info(f"[group_notify] camera={cam} fetched groups={len(groups)}")
                    if groups:
                        await notify_groups(
                            groups, cam, Type, sender,
                            main_dir, str(timestamp)[:-4], namespace, logger
                        )

            # Gather individual and group notify coroutines; both paths run concurrently.
            new_thread_id, _ = await asyncio.gather(_individual(), _group(), return_exceptions=False)

            # Update the shared thread_id_ref if a new Gmail thread ID was produced.
            if new_thread_id:
                thread_id_ref[0] = new_thread_id

            # Stage: publish result to notification_results topic
            producer.send(
                OUTPUT_TOPIC,
                {
                    "status": "success",
                    "frame_id": frame_id,
                    "camera": cam,
                    "thread_id": thread_id_ref[0]
                },
                key=(frame_id or cam).encode("utf-8")   # partition by frame_id for ordered delivery; PPE messages have no frame_id, fall back to camera name # partition by frame_id for ordered delivery
            )
            logger.info(
                f"[NOTIFICATION SENT] frame_id={frame_id} | camera={cam} "
                f"| Type={Type} | topic={OUTPUT_TOPIC}"
            )
        except Exception as e:
            logger.error(e)

# -------------------- KAFKA POLL LOOP --------------------

async def _poll_kafka(queue):
    """Poll Kafka in a thread executor and feed messages into the asyncio queue.

    Kafka's Python client (``confluent-kafka`` / ``kafka-python``) uses a
    blocking ``poll()`` call.  Running it directly in the event loop would
    stall all other coroutines for up to ``timeout_ms`` milliseconds.  This
    coroutine avoids that by wrapping each poll in
    ``loop.run_in_executor(None, ...)`` which executes it in the default
    thread-pool executor, keeping the event loop free.

    When no messages are available, ``await asyncio.sleep(0)`` yields control
    back to the event loop so other tasks (worker coroutines, Telegram sends)
    can make progress.

    The ``queue`` provides back-pressure: if the queue is full (``QUEUE_MAXSIZE``
    messages), ``await queue.put(msg)`` blocks this coroutine until a worker
    dequeues a message.  This prevents unbounded memory growth during alert bursts.

    Args:
        queue (asyncio.Queue): Bounded queue shared with the dispatch loop in
            ``process_messages``.
    """
    logger.info(f"_poll_kafka started | input_topic={INPUT_TOPIC} | queue_maxsize={QUEUE_MAXSIZE}")
    loop = asyncio.get_event_loop()
    while True:
        # Stage: poll Kafka for new notification messages, enqueue for worker tasks
        # max_records=50 limits how many messages are returned in a single poll batch.
        records = await loop.run_in_executor(
            None, lambda: consumer.poll(timeout_ms=200, max_records=50)
        )
        if records:
            total = sum(len(msgs) for msgs in records.values())
            logger.info(f"_poll_kafka: {total} message(s) received from Kafka")
        # records is a dict of {TopicPartition: [ConsumerRecord, ...]};
        # flatten and enqueue each message individually.
        for tp_msgs in records.values():
            for msg in tp_msgs:
                await queue.put(msg)    # blocks if queue is at QUEUE_MAXSIZE
        if not records:
            # No messages available — yield to the event loop to prevent spin-waiting.
            await asyncio.sleep(0)

# -------------------- PROCESS MESSAGES (MAIN ASYNC ENTRY) --------------------

async def process_messages():
    """Main async entry point: initialise all services, then run the dispatch loop.

    Sequence of initialisation steps:

    1. **Kafka** — ``create_kafka_clients()`` retries until the broker is ready.
    2. **Config** — ``load_config()`` reads ``dev.json`` credentials; exits if
       the file is missing.
    3. **NotificationUtils** — wraps credential loading and per-service status
       flags.  WhatsApp and Slack are disabled; Telegram is enabled.
    4. **MongoDB** — connects to the Aksha database and calls
       ``notif_utils.notif_setup_email`` / ``notif_setup_telegram`` to load
       recipients, sender address, Gmail thread ID, and Telegram bot config.
    5. **Worker pool** — an ``asyncio.Semaphore(WORKER_COUNT)`` gates concurrent
       processing; an ``asyncio.Queue(QUEUE_MAXSIZE)`` buffers incoming messages.
    6. **Kafka poll task** — ``_poll_kafka(queue)`` runs as a background task.
    7. **Dispatch loop** — dequeues messages and creates a ``_process_single``
       task for each.

    The ``thread_id_ref`` list is a one-element mutable reference shared across
    all worker tasks so they all read and write the same Gmail thread ID without
    requiring a global variable or lock (Python's GIL protects simple list
    element writes from data races in this single-threaded asyncio context).

    Global state written:
        notif_utils (NotificationUtils): Loaded credentials and service flags.
        telegram_service (dict): Telegram bot config used by ``send_notifications``.
        producer (KafkaProducer): Used by ``_process_single`` to publish results.
        consumer (KafkaConsumer): Used by ``_poll_kafka`` to read alerts.
    """
    global notif_utils, telegram_service, producer, consumer

    # Stage: initialise Kafka clients with retry
    producer, consumer = create_kafka_clients()

    # Stage: load service credentials config
    config = load_config()
    if not config:
        logger.error("Failed to load configuration")
        sys.exit(1)

    # Instantiate the utility wrapper; set per-service status flags explicitly.
    # WhatsApp and Slack are disabled for this deployment; only Telegram is active.
    notif_utils = NotificationUtils(config=config, main_dir=main_dir, logger=logger)
    notif_utils.whats_app_service_status = False
    notif_utils.telegram_service_status = True
    notif_utils.slack_service_status = False
    logger.info(
        f"NotificationUtils created | whatsapp={notif_utils.whats_app_service_status} "
        f"| telegram={notif_utils.telegram_service_status} | slack={notif_utils.slack_service_status}"
    )

    recipients = []
    sender= None
    threadId = get_thread_id_from_config()

    # Stage: connect to MongoDB and load email/telegram setup from Resource collection
    try:
        from pymongo import MongoClient
        db = MongoClient(MONGODB_URI)["Aksha"]
        logger.info(f"MongoDB connected | db=Aksha")

        # notif_setup_email returns (recipients, subscription, sender, threadId).
        r, _, s, t = notif_utils.notif_setup_email(db["Resource"])
        # notif_setup_telegram returns (subscription, telegram_service_dict).
        _, telegram_service = notif_utils.notif_setup_telegram(db["Resource"])

        if r: recipients = r
        if s: sender = s
        # Prefer the thread ID from MongoDB Resource over the local config file.
        if t: threadId = t

        logger.info(
            f"Notification setup complete | recipients={len(recipients)} | sender={sender} "
            f"| threadId={threadId} | telegram_service_status={telegram_service.get('service_status')}"
        )
    except Exception as e:
        logger.error(f"MongoDB error: {e}")
        sys.exit(1)

    if not recipients:
        logger.warning("No email recipients configured — email notifications disabled, group/telegram may still work")

    # Stage: create worker pool, queue, and start Kafka poll task
    # Wrap thread_id in a list so workers can mutate it via index assignment
    # (simple strings are immutable in Python; a list element is mutable).
    thread_id_ref = [threadId]  # mutable reference shared across workers
    sem = asyncio.Semaphore(WORKER_COUNT)
    queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    logger.info(
        f"Notification worker pool ready | workers={WORKER_COUNT} | queue_maxsize={QUEUE_MAXSIZE}"
    )

    # Start the Kafka poll coroutine as a background task; it runs until the
    # process exits, continuously feeding the queue.
    asyncio.create_task(_poll_kafka(queue))
    logger.info("_poll_kafka task created — entering message dispatch loop")

    while True:
        # Stage: dequeue one message and dispatch to a worker task (bounded by semaphore)
        # await queue.get() suspends here when the queue is empty, yielding the
        # event loop to poll tasks and in-flight notification coroutines.
        msg = await queue.get()
        asyncio.create_task(
            _process_single(msg, recipients, sender, thread_id_ref, db, sem)
        )

# -------------------- ENTRYPOINT --------------------

def main():
    """Synchronous entrypoint: start the asyncio event loop.

    Called by ``__main__`` and (optionally) by a Docker/systemd process
    manager.  All async initialisation and the infinite dispatch loop run
    inside ``asyncio.run(process_messages())``.
    """
    logger.info("Starting Notification Service")
    asyncio.run(process_messages())

if __name__ == "__main__":
    main()