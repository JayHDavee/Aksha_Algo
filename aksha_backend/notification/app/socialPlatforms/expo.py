"""
expo.py — Expo Push Notification Sender
========================================

Sends push notifications to Expo-managed React Native apps via the Expo
Push API (https://exp.host/--/api/v2/push/send).

Each device is identified by an ExponentPushToken stored in MongoDB.
Tokens are typically registered by the mobile app on first launch and
resolved from mobile_id -> token via DynamoDB (see
``fetch_expo_tokens_from_dynamo``).

Orchestration (new)
--------------------
Before sending a push, ``expo()`` now reproduces what the legacy
``notifications.py`` did in ``send_mobile_push_async``:

1. Upload the alert image to S3 (``upload_image_to_s3``), per mobile_id,
   so the push payload can carry a real ``imageUrl``.
2. Persist one alert-history row per group to DynamoDB
   (``save_group_alert_details``), BEFORE sending the push, so the alert
   is durably recorded even if the push fails or every device is offline
   or has a stale token.
3. Send the push (``send_expo_push``) with the resulting ``imageUrl`` in
   the data payload.

Both step 1 and step 2 are best-effort: failures are logged and swallowed
so an S3/DynamoDB hiccup never blocks the push notification itself.
Alert history can later be read back with ``get_alerts_for_group``.

Send helpers
------------
``send_expo_push(push_tokens, title, body, data, logger)``
    Sends ONE request per token (never batched — Expo rejects an entire
    batch with PUSH_TOO_MANY_EXPERIENCE_IDS if tokens belong to different
    Expo projects), all fired concurrently via ``asyncio.gather``. Payload
    is data-only (title/body nested inside ``data``) so Android always
    wakes the app's background task instead of silently auto-displaying
    the notification via the OS. Returns the list of per-token ticket
    dicts from the API. Errors for individual tokens are logged without
    raising so a bad token never blocks notifications to other devices.

``expo(...)``
    High-level dispatcher matching the signature convention of telegram.py
    and slack.py.  Builds the title/body from the alert type, orchestrates
    the S3 upload + DynamoDB save described above, and calls
    ``send_expo_push``.
"""

import aiohttp
import asyncio
import textwrap
import os
import json
import time
import datetime
import uuid
import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key
import threading
from dataclasses import dataclass, asdict
from pathlib import Path

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

# -------------------- CONFIG CONSTANTS --------------------
# Pulled from environment with sane defaults so this file never fails to
# import in a fresh environment that hasn't set every var explicitly.
_EXPO_TOKEN_TTL = int(os.getenv("EXPO_TOKEN_TTL_SECONDS", 3600))  # re-fetch from DynamoDB once per hour
_EXPO_TOKEN_FILENAME = os.getenv("EXPO_TOKEN_CACHE_FILENAME", "expo_tokens.json")
_DYNAMO_TABLE_NAME = os.getenv("EXPO_DYNAMO_TABLE", "mobile-users")
_DYNAMO_INDEX_NAME = os.getenv("EXPO_DYNAMO_INDEX", "mobile_id-index")
_DYNAMO_REGION = os.getenv("AWS_REGION", "ap-south-1")

# S3 bucket for alert images referenced in push payloads (imageUrl), and the
# DynamoDB table used to persist a per-group alert-history row so the mobile
# app can fetch past alerts (e.g. after being offline) instead of relying
# solely on the ephemeral push notification. ALERTS_TTL_DAYS controls how
# long each row survives before DynamoDB's native TTL auto-deletes it
# (TTL must also be enabled on the table itself, on the `expiresAt` attribute).
_S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")
_ALERTS_TABLE_NAME = os.getenv("ALERTS_TABLE_NAME", "alerts")
_ALERTS_TTL_DAYS = int(os.getenv("ALERTS_TTL_DAYS", 1))

# Local file cache: mobile_id -> {"token": str, "fetched_at": float}
_BASE_DIR = Path(__file__).resolve().parent
_EXPO_TOKEN_FILE = _BASE_DIR / _EXPO_TOKEN_FILENAME


# -------------------- CACHE ENTRY --------------------

@dataclass
class TokenCacheEntry:
    """One cached Expo token resolution for a single mobile_id."""
    token: str
    fetched_at: float

    def is_fresh(self, ttl_seconds: float) -> bool:
        return (time.time() - self.fetched_at) < ttl_seconds


_expo_token_store: dict[str, TokenCacheEntry] = {}
_expo_token_lock = threading.Lock()


# -------------------- FILE PERSISTENCE --------------------

def _load_expo_token_file() -> None:
    """Load the on-disk token cache into memory at module startup.

    Populates the module-level ``_expo_token_store`` dict from
    ``_EXPO_TOKEN_FILE`` if it exists and is valid JSON. Any read or
    parse failure (missing file, corrupted JSON, permissions issue)
    is treated as an empty cache rather than raised, since a cold
    cache is a safe, low-cost starting state — the next lookup will
    simply re-fetch from DynamoDB.
    """
    global _expo_token_store
    try:
        if _EXPO_TOKEN_FILE.exists():
            raw = json.loads(_EXPO_TOKEN_FILE.read_text())
            _expo_token_store = {
                mobile_id: TokenCacheEntry(**entry) for mobile_id, entry in raw.items()
            }

    except Exception:
        _expo_token_store = {}


def _save_expo_token_file() -> None:
    """Persist the in-memory token cache to disk.

    Called after any cache update (new fetch or stale-fallback) so the
    cache survives a container restart instead of forcing a full
    DynamoDB re-fetch for every mobile_id on next startup. Failures are
    swallowed intentionally — losing the on-disk cache is not fatal,
    it just means the next cold start re-fetches from DynamoDB.
    """
    try:
        serializable = {mid: asdict(entry) for mid, entry in _expo_token_store.items()}
        _EXPO_TOKEN_FILE.write_text(json.dumps(serializable))

    except Exception:
        pass


_load_expo_token_file()


# ==================== CACHE LAYER (DynamoDB fetch) ====================
#
# Cache flow (memory -> file -> DynamoDB -> stale fallback):
#   1. On module load, the on-disk cache file is read into the in-memory
#      dict `_expo_token_store` (mobile_id -> TokenCacheEntry).
#   2. Every lookup first checks memory. If an entry exists and is younger
#      than _EXPO_TOKEN_TTL, it's used as-is (no network call).
#   3. Anything missing or expired is batched into a DynamoDB query.
#   4. If DynamoDB itself fails (network blip, throttling, credentials
#      issue), we deliberately fall back to whatever stale token we had
#      cached — even though it's expired — rather than sending zero
#      notifications. A stale token is far more likely to still work than
#      not attempting delivery at all; this trade-off favors availability
#      over strict freshness.
#   5. Any successful fetch (fresh or stale-fallback) is written back to
#      the file so the cache survives a service restart.

def _partition_cache(mobile_ids: list, now: float) -> tuple[list, list, dict]:
    """Split mobile_ids into (fresh tokens, ids needing re-fetch, stale fallback map).

    Isolated so cache-lookup logic can be tested independently of any
    network call.
    """
    tokens = []
    ids_to_fetch = []
    stale_tokens = {}

    with _expo_token_lock:
        for mid in mobile_ids:
            entry = _expo_token_store.get(mid)
            if entry and entry.is_fresh(_EXPO_TOKEN_TTL):
                tokens.append(entry.token)
            else:
                ids_to_fetch.append(mid)
                if entry:
                    stale_tokens[mid] = entry.token

    return tokens, ids_to_fetch, stale_tokens


def _query_dynamo_tokens(ids_to_fetch: list, logger) -> dict:
    """Query DynamoDB for expoToken values for the given mobile_ids.

    Pure network I/O — no cache reads or writes here, so this can be
    tested/mocked independently of the in-memory or on-disk cache.

    Returns:
        dict[str, str]: mobile_id -> token, only for ids that resolved.
    """
    dynamodb = boto3.resource(
        'dynamodb',
        region_name=_DYNAMO_REGION,
        aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    )
    table = dynamodb.Table(_DYNAMO_TABLE_NAME)

    resolved = {}
    for mobile_id in ids_to_fetch:
        response = table.query(
            IndexName=_DYNAMO_INDEX_NAME,
            KeyConditionExpression=Key('mobile_id').eq(mobile_id),
            Limit=1
        )
        items = response.get('Items', [])
        if not items:
            logger.info("fetch_expo_tokens_from_dynamo: mobile_id %s not found", mobile_id)
            continue
        token = items[0].get('expoToken')
        if token:
            resolved[mobile_id] = token
            logger.info("fetch_expo_tokens_from_dynamo: fetched token for %s", mobile_id)
        else:
            logger.info("fetch_expo_tokens_from_dynamo: no expoToken for %s", mobile_id)

    return resolved


def _apply_stale_fallback(stale_tokens: dict, now: float, logger) -> list:
    """Restore expired cached tokens when DynamoDB is unreachable.

    Step 4: DynamoDB unreachable (network blip, throttling, bad
    credentials) — fall back to whatever stale token we had cached
    rather than sending zero notifications. A stale token is more
    likely to still work than not attempting delivery at all.
    """
    tokens = []
    with _expo_token_lock:
        for mid, token in stale_tokens.items():
            _expo_token_store[mid] = TokenCacheEntry(token=token, fetched_at=now)
            tokens.append(token)
        _save_expo_token_file()
    logger.warning("fetch_expo_tokens_from_dynamo: using %s stale token(s) after DynamoDB failure", len(tokens))
    return tokens


def fetch_expo_tokens_from_dynamo(mobile_ids: list, logger) -> list:
    """Resolve mobile_ids to Expo push tokens via DynamoDB, with a 1-hour
    local cache and stale-token fallback if DynamoDB is unreachable.
    """
    now = time.time()

    # Step 1-2: memory cache check.
    tokens, ids_to_fetch, stale_tokens = _partition_cache(mobile_ids, now)

    if not ids_to_fetch:
        # Everything resolved from memory — skip DynamoDB entirely.
        return tokens

    try:
        # Step 3: cache miss/expired — batch-query DynamoDB for the rest.
        resolved = _query_dynamo_tokens(ids_to_fetch, logger)

        with _expo_token_lock:
            for mid, token in resolved.items():
                _expo_token_store[mid] = TokenCacheEntry(token=token, fetched_at=now)
            # Step 5: persist fresh fetches to disk.
            _save_expo_token_file()

        tokens.extend(resolved.values())
        return tokens

    except Exception as e:
        logger.error("fetch_expo_tokens_from_dynamo: DynamoDB fetch failed: %s", e, exc_info=True)
        tokens.extend(_apply_stale_fallback(stale_tokens, now, logger))
        return tokens


def invalidate_expo_tokens(bad_tokens: list, logger) -> None:
    """Remove tokens Expo reports as no longer registered from the cache.

    Called after a push attempt when Expo returns a ``DeviceNotRegistered``
    error for one or more tokens. Dropping them here forces the next
    alert for that mobile_id to re-fetch from DynamoDB rather than
    repeatedly retrying a dead token.

    Args:
        bad_tokens: Token strings Expo reported as unregistered.
        logger: Logger instance for diagnostics.
    """
    removed = []
    with _expo_token_lock:
        for mid, entry in list(_expo_token_store.items()):
            if entry.token in bad_tokens:
                del _expo_token_store[mid]
                removed.append(mid)
    if removed:
        with _expo_token_lock:
            _save_expo_token_file()
        logger.info("invalidate_expo_tokens: removed stale tokens for %s", removed)

# -------------------- S3 IMAGE UPLOAD --------------------
#
# Per-thread S3 client — boto3 clients are not thread-safe when shared
# across threads, so each executor thread gets its own (same pattern the
# legacy notifications.py used for its S3/DynamoDB clients).
_s3_thread_local = threading.local()


def _get_s3_client():
    """Return this thread's boto3 S3 client, creating it on first use.

    boto3 clients hold internal HTTP connection state and are documented
    as not safe to share across threads. Because upload_image_to_s3() is
    always invoked via loop.run_in_executor() (i.e. on a thread-pool
    worker, never the event-loop thread), a shared module-level client
    would risk connection-state corruption under concurrent alerts. Using
    threading.local() gives each worker thread its own lazily-created
    client instead, at the cost of one extra client per thread (cheap —
    boto3 clients are lightweight to construct).

    Returns:
        botocore.client.S3: A cached client for this thread, configured
        from AWS_REGION (falling back to AWS_REGION/_DYNAMO_REGION) and
        the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars.
    """
    if not hasattr(_s3_thread_local, "client"):
        _s3_thread_local.client = boto3.client(
            "s3",
            region_name=_DYNAMO_REGION,
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )
    return _s3_thread_local.client


def upload_image_to_s3(image_path, camera, timestamp, group_id, mobile_id_list, logger):
    """Upload an alert image to S3 under each mobile_id's folder.

    Mirrors the legacy ``notifications.py`` behaviour: one object is written
    per mobile_id under ``alerts/{mobile_id}/{group_id}/{camera}/{date}/...``
    so per-device access patterns stay consistent with the rest of the
    system. S3 needs no explicit "folder" creation — key prefixes with '/'
    work natively.

    This is a synchronous, blocking boto3 call and MUST be invoked via
    ``loop.run_in_executor`` from async callers so it doesn't stall the
    event loop.

    Args:
        image_path (str): Local filesystem path to the JPEG to upload.
        camera (str): Camera name, used in the S3 key.
        timestamp (str): Human-readable timestamp string, e.g.
            ``"2026-07-23 10:15:00"``. Used for both the date partition and
            the object's filename (colons/spaces are sanitised).
        group_id (str): Camera group ID, used in the S3 key.
        mobile_id_list (list[str]): mobile_ids to upload a copy for.
        logger: Logger instance.

    Returns:
        str: Presigned URL (24h) for the last mobile_id uploaded, or ``""``
        if the bucket isn't configured, the image is missing, or the
        upload failed.
    """
    if not os.path.exists(image_path):
        logger.warning(f"upload_image_to_s3: image not found at {image_path}")
        return ""

    try:
        s3_client = _get_s3_client()
        image_date = timestamp.split(" ")[0]
        safe_ts = timestamp.replace(" ", "_").replace(":", "-")
        image_url = ""

        with open(image_path, "rb") as f:
            image_data = f.read()

        for mobile_id in mobile_id_list:
            s3_key = f"alerts/{mobile_id}/{group_id}/{camera}/{image_date}/{safe_ts}_alert.jpg"
            s3_client.put_object(
                Bucket=os.getenv("S3_BUCKET_NAME"),
                Key=s3_key,
                Body=image_data,
                ContentType="image/jpeg",
            )
            logger.info(f"upload_image_to_s3: uploaded | key={s3_key}")

            image_url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": os.getenv("S3_BUCKET_NAME"), "Key": s3_key},
                ExpiresIn=86400,
            )

        return image_url

    except ClientError as e:
        logger.error(f"upload_image_to_s3: S3 ClientError | {e}")
        return ""
    except Exception as e:
        logger.error(f"upload_image_to_s3: failed | {e}")
        return ""


# -------------------- DYNAMODB ALERT HISTORY --------------------
#
# Per-thread DynamoDB resource — same rationale as the S3 client above.
# boto3 resources aren't thread-safe, and save_group_alert_details() /
# get_alerts_for_group() both run inside loop.run_in_executor() threads.

_dynamo_resource_thread_local = threading.local()


def _get_dynamo_resource():
    """Return this thread's boto3 DynamoDB resource, creating it on first use.

    Backs both save_group_alert_details() (writes the per-group
    alert-history row) and get_alerts_for_group() (reads it back). Kept
    separate from the token-cache DynamoDB client in _query_dynamo_tokens()
    (which queries the 'mobile-users' table) since this one targets the
    'alerts' table (name configurable via ALERTS_TABLE_NAME) — different
    table, so a distinct thread-local avoids any accidental cross-use.

    Returns:
        boto3.resources.factory.dynamodb.ServiceResource: A cached
        DynamoDB resource for this thread, configured from AWS_REGION
        (falling back to _DYNAMO_REGION) and the AWS_ACCESS_KEY_ID /
        AWS_SECRET_ACCESS_KEY env vars.
    """
    if not hasattr(_dynamo_resource_thread_local, "resource"):
        _dynamo_resource_thread_local.resource = boto3.resource(
            "dynamodb",
            region_name=_DYNAMO_REGION,
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )
    return _dynamo_resource_thread_local.resource


def save_group_alert_details(group_id, group_name, mobile_id_list, camera, Timestamp,
                             valid_alerts, valid_descriptions, image_url, logger):
    """Persist one alert-history row per group to DynamoDB.

    Written BEFORE the push is sent by the caller (see ``expo()``), so the
    alert is durably recorded even if the Expo push itself fails or every
    device is offline / has a stale token — the mobile app can always
    recover the alert via a history fetch regardless of push delivery.

    Schema matches the legacy ``notifications.py`` / getMobileAlert Lambda
    convention:

        Table: alerts  (override via ALERTS_TABLE_NAME env var)
            Partition key: groupId (String)
            Sort key:      alertId (String) — not filtered on by the
                            Lambda, but keeps rows unique per group
            TTL attribute: expiresAt (Number, epoch seconds) — controlled
                            by ALERTS_TTL_DAYS (default 30); TTL must also
                            be enabled on the table itself for DynamoDB to
                            auto-delete expired rows.

    ``mobile_id_list`` is folded into the ``data`` JSON blob (not stored as
    its own top-level attribute) since the getMobileAlert Lambda's
    AlertItem type doesn't expose a separate mobileIds field — only
    ``data`` as a JSON blob.

    This is a synchronous, blocking boto3 call — invoke via
    ``loop.run_in_executor`` from async callers.

    Args:
        group_id (str): Camera group ID — DynamoDB partition key.
        group_name (str | None): Human-readable group name for display.
        mobile_id_list (list[str]): mobile_ids this alert was pushed to.
        camera (str): Camera name that generated the alert.
        Timestamp (str): Human-readable incident timestamp.
        valid_alerts (list[str]): Alert name strings that passed validity.
        valid_descriptions (list[str]): Matching description strings.
        image_url (str): Presigned S3 URL from ``upload_image_to_s3``, or
            ``""`` if the upload was skipped/failed.
        logger: Logger instance.

    Returns:
        str | None: The generated ``alertId`` on success, ``None`` on failure.
    """
    try:
        dynamodb = _get_dynamo_resource()
        table = dynamodb.Table(_ALERTS_TABLE_NAME)

        alert_id = str(uuid.uuid4())
        created_at = datetime.datetime.utcnow().isoformat()
        expires_at = int(time.time()) + _ALERTS_TTL_DAYS * 86400

        title = f"Aksha Alert - {camera}"
        body = ", ".join(valid_alerts) if valid_alerts else "Alert detected"
        data = {
            "groupId":          str(group_id),
            "groupName":        str(group_name) if group_name else "",
            "cameraName":       str(camera),
            "alertName":        ", ".join(valid_alerts) if valid_alerts else "",
            "alertDescription": ", ".join(valid_descriptions) if valid_descriptions else "",
            "incidentTime":     str(Timestamp),
            "imageUrl":         str(image_url) if image_url else "",
            "mobileIds":        list(mobile_id_list) if mobile_id_list else [],
        }

        item = {
            "groupId":      str(group_id),
            "alertId":      alert_id,
            "cameraName":   str(camera),
            "incidentTime": str(Timestamp),
            "title":        title,
            "body":         body,
            "data":         json.dumps(data),
            "createdAt":    created_at,
            "expiresAt":    expires_at,
        }
        table.put_item(Item=item)
        logger.info(f"save_group_alert_details: saved | table={_ALERTS_TABLE_NAME} groupId={group_id} alertId={alert_id}")
        return alert_id

    except ClientError as e:
        logger.error(f"save_group_alert_details: ClientError | group={group_id} | {e}")
        return None
    except Exception as e:
        logger.error(f"save_group_alert_details: failed | group={group_id} | {e}")
        return None


def get_alerts_for_group(group_id, logger, limit=50):
    """Fetch recent, non-expired alert history for a group, newest first.

    Mirrors the getMobileAlert Lambda's query pattern (partition key
    ``groupId`` only, no sort-key filter, client-side sort + TTL guard) so
    it can be reused directly from Python — e.g. for a REST endpoint or the
    daily summary job — without duplicating the Lambda's logic.

    Args:
        group_id (str): Camera group ID to fetch history for.
        logger: Logger instance.
        limit (int): Maximum number of rows to return (default 50).

    Returns:
        list[dict]: Non-expired alert rows, newest ``incidentTime`` first.
    """
    try:
        dynamodb = _get_dynamo_resource()
        table = dynamodb.Table(_ALERTS_TABLE_NAME)

        response = table.query(KeyConditionExpression=Key("groupId").eq(group_id))
        items = response.get("Items", [])

        now = int(time.time())
        items = [i for i in items if int(i.get("expiresAt", 0)) > now]
        items.sort(key=lambda i: i.get("incidentTime", ""), reverse=True)
        return items[:limit]
    except Exception as e:
        logger.error(f"get_alerts_for_group: query failed | group_id={group_id} | {e}")
        return []


# -------------------- EXPO PUSH API --------------------

async def send_expo_push(push_tokens: list, title: str, body: str,
                         data: dict, logger) -> list:
    """POST a push notification to one or more Expo push tokens.

    Sends ONE HTTP request PER TOKEN rather than batching all of a
    group's tokens into a single request. Expo's push API requires every
    token in a batch to belong to the same Expo project ("experience
    ID") and rejects the ENTIRE request with PUSH_TOO_MANY_EXPERIENCE_IDS
    if they don't — e.g. a group with one production token and one stray
    token from a developer's personal test build would silently fail
    delivery to everyone, not just the mismatched token. Per-token
    requests isolate failures so one bad token can't block the rest of
    the group. All tokens are sent concurrently via ``asyncio.gather``.
 
    Sent as a DATA-ONLY push (no top-level ``title``/``body``) so that
    Android always wakes the app's JS background task, even when the app
    is fully killed. If ``title``/``body`` were sent at the top level,
    Android would treat this as a "notification" message and display it
    directly via the OS — silently skipping the background task, which
    means the alert would never get written to local storage and the
    app's UI would look stale until the next foreground refresh. Title
    and body are still delivered, just nested inside ``data`` so the
    client can build the visible notification itself after saving the
    alert.

    Args:
        push_tokens (list[str]): Expo push token strings, e.g.
            ``["ExponentPushToken[xxxxxx]", ...]``.
        title (str): Notification title shown in the OS notification shade.
        body (str): Notification body text.
        data (dict): Arbitrary JSON payload delivered to the app's
            notification handler (camera name, alert type, timestamp,
            imageUrl, etc.).
        logger: Logger instance for diagnostic messages.

    Returns:
        list[dict]: Per-token ticket dicts from the Expo API, in the same
        order as ``push_tokens``. Each dict contains ``"status"``
        (``"ok"`` or ``"error"``) and, on success, an ``"id"`` receipt ID
        for later delivery verification.
    """
    if not push_tokens:
        logger.info("expo: no push tokens — skipping")
        return []

    image_url = data.get("imageUrl")
 
    async def send_one(session, token):
        message = {
            "to":        token,
            "sound":     "default",
            "priority":  "high",
            "channelId": "alerts",
            "ttl":       300,
            "data":      {**data, "title": title, "body": body},
        }
        if image_url:
            message["richContent"] = {"image": image_url}
            message["mutableContent"] = True
 
        headers = {
            "Accept":          "application/json",
            "Content-Type":    "application/json",
            "Accept-Encoding": "gzip, deflate",
        }
        try:
            async with session.post(EXPO_PUSH_URL, json=[message],
                                    headers=headers) as resp:
                result = await resp.json()
        except Exception as e:
            logger.error("expo: HTTP request failed | token=%s | %s", token, e)
            return {"status": "error", "details": {"error": str(e)}}
 
        items = result.get("data") if isinstance(result, dict) else None
        ticket = items[0] if items else {"status": "error", "details": {"error": result}}
 
        status = ticket.get("status")
        if status == "ok":
            logger.info("expo: token OK | token=%s", token)
        elif ticket.get("details", {}).get("error") == "DeviceNotRegistered":
            logger.error("expo: DeviceNotRegistered | token=%s", token)
        else:
            logger.warning(
                "expo: token error | token=%s | status=%s | details=%s",
                token, status, ticket.get("details")
            )
        return ticket
 
    logger.info("send_expo_push: dispatching | tokens=%d", len(push_tokens))
    try:
        async with aiohttp.ClientSession() as session:
            tickets = await asyncio.gather(*(send_one(session, token) for token in push_tokens))
    except Exception as e:
        logger.error("send_expo_push: request batch failed: %s", e)
        return []
 
    return list(tickets)


# -------------------- HIGH-LEVEL DISPATCHER --------------------

async def expo(subscription: str, camera: str, Type: str, Timestamp: str,
               logger, alert_notification_validity: list = None,
               alert: list = None, description: list = None,
               expo_service: dict = None, invalidate_tokens_fn=None,
               group_id: str = None, group_name: str = None,
               DataPath: str = None) -> list:
    """High-level Expo push dispatcher — matches the telegram/slack convention.

    Before sending, this orchestrates the same S3 upload + DynamoDB
    alert-history save that the legacy ``notifications.py`` did in
    ``send_mobile_push_async``:

    1. Upload the alert image to S3, per mobile_id (``upload_image_to_s3``).
    2. Save one alert-history row to DynamoDB (``save_group_alert_details``)
       — BEFORE sending the push, so the alert is durably recorded even if
       the push fails or every device is offline / has a stale token.
    3. Send the push with the resulting ``imageUrl`` included in the data
       payload.

    Steps 1-2 are best-effort and only run when ``group_id``, ``DataPath``,
    and ``expo_service["mobile_ids"]`` are all supplied — callers that
    don't provide them (e.g. individual, non-group notifications) still
    get a plain push with no ``imageUrl``, and a failure in either step is
    logged and swallowed rather than blocking the push itself.

    The ``expo_service`` dict must have:
        service_status (bool): ``True`` to send, ``False``/``None`` to skip.
        push_tokens (list[str]): Expo push token strings.
        mobile_ids (list[str], optional): Raw mobile_id strings that
            ``push_tokens`` were resolved from — needed for the S3 key
            layout and the DynamoDB ``mobileIds`` field. Omit to skip the
            S3/DynamoDB orchestration entirely.

    Args:
        subscription (str): Tenant identifier (included in push data payload).
        camera (str): Camera name that generated the alert.
        Type (str): Alert type string (e.g. ``"Alert"``, ``"AutoAlert"``).
        Timestamp (str): Human-readable timestamp string.
        logger: Logger instance.
        alert_notification_validity (list | None): Validity flags — only
            alerts where the corresponding flag is truthy are included.
        alert (list | None): Alert name strings.
        description (list | None): Alert description strings.
        expo_service (dict | None): Service config dict.  Defaults to
            disabled if ``None``.
        invalidate_tokens_fn (callable | None): Optional callback with
            signature ``fn(bad_tokens: list, logger)``, called with any
            tokens Expo reports as no longer registered.  Pass ``None`` to
            skip invalidation (e.g. if the caller doesn't maintain a cache).
        group_id (str | None): Camera group ID — S3 key prefix and
            DynamoDB partition key. Required (along with DataPath and
            mobile_ids) to enable the image upload + alert-history save.
        group_name (str | None): Human-readable group name, stored in the
            DynamoDB row for display.
        DataPath (str | None): Base path to the notification image
            directory; the alert image is expected at
            ``{DataPath}{camera}/alerts/{date}/{Timestamp}_alert.jpg``.

    Returns:
        list[dict]: Expo ticket list from ``send_expo_push``, or ``[]``
        if the service is disabled.
    """
    if expo_service is None:
        expo_service = {"service_status": False, "push_tokens": []}

    if not expo_service.get("service_status"):
        logger.info("expo: service not activated")
        return []

    push_tokens = expo_service.get("push_tokens", [])
    mobile_ids = expo_service.get("mobile_ids", [])
    if not push_tokens:
        logger.info("expo: no push tokens configured")
        return []

    logger.info(
        "expo: dispatching | camera=%s | Type=%s | tokens=%d | mobile_ids=%d",
        camera, Type, len(push_tokens), len(mobile_ids)
    )

    try:
        # Stage: compute the valid (name, description) pairs once — reused
        # for both the push body text and the DynamoDB alert-history row.
        valid_alert_names = []
        valid_descs = []
        if alert and description and alert_notification_validity:
            for a, d, v in zip(alert, description, alert_notification_validity):
                if v:
                    valid_alert_names.append(a)
                    valid_descs.append(d)

        if Type in ("Alert", "No Object Alert"):
            combined = [f"{n}: {d}" for n, d in zip(valid_alert_names, valid_descs)]
            title = f"Aksha Alert — {camera}"
            body  = textwrap.shorten(
                ", ".join(combined) if combined else Type,
                width=178, placeholder="…"
            )

        elif Type == "AutoAlert":
            title = f"Aksha AutoAlert — {camera}"
            body  = f"Unusual activity detected at {Timestamp}"

        elif Type in ("RTSP working", "RTSP Error"):
            title = f"Aksha Camera — {camera}"
            body  = ("Camera is back online." if Type == "RTSP working"
                     else "Camera connection lost. Please check RTSP link.")

        elif Type == "DailyReport":
            title = "Aksha Daily Report"
            body  = f"Daily alert summary for {camera} is ready."

        else:
            title = f"Aksha — {camera}"
            body  = Type

        # Stage: upload alert image to S3 + save alert-history row to
        # DynamoDB, BEFORE sending the push. Best effort — never blocks
        # the push itself if either step fails.
        image_url = ""
        if group_id and DataPath and mobile_ids:
            loop = asyncio.get_running_loop()
            try:
                normalized_data_path = DataPath if DataPath.endswith("/") else DataPath + "/"
                image_date = Timestamp.split(" ")[0]
                image_path = f"{normalized_data_path}{camera}/alerts/{image_date}/{Timestamp}_alert.jpg"
                image_url = await loop.run_in_executor(
                    None, upload_image_to_s3,
                    image_path, camera, Timestamp, group_id, mobile_ids, logger
                )
                logger.info("The image path is as mentioned %s path",image_path)
                logger.info("The image date is as mentioned %s date",image_date)
                logger.info("The image url is as mentioned %s url",image_url)
            except Exception as e:
                logger.error(f"expo: S3 upload step failed | camera={camera} | {e}")
                image_url = ""

            try:
                await loop.run_in_executor(
                    None, save_group_alert_details,
                    group_id, group_name, mobile_ids, camera, Timestamp,
                    valid_alert_names, valid_descs, image_url, logger
                )
            except Exception as e:
                logger.error(f"expo: DynamoDB alert-history save failed | camera={camera} | {e}")
        else:
            logger.info(
                "expo: skipping S3 upload / DynamoDB save | group_id=%s DataPath=%s mobile_ids=%d",
                group_id, bool(DataPath), len(mobile_ids)
            )

        data = {
            "subscription": subscription,
            "camera":       camera,
            "type":         Type,
            "timestamp":    Timestamp,
            "imageUrl":     image_url,
        }

        tickets = await send_expo_push(push_tokens, title, body, data, logger)
        logger.info("expo: sent | tickets=%s | camera=%s | imageUrl=%s", tickets, camera, image_url)
        logger.info("The expo sent tickets %s tickets",tickets)
        # Identify tokens Expo reports as no longer registered, and let the
        # caller's cache (if any) drop them so the next alert re-fetches.
        if invalidate_tokens_fn is not None:
            bad_tokens = [
                token for token, ticket in zip(push_tokens, tickets)
                if isinstance(ticket, dict)
                and ticket.get("details", {}).get("error") == "DeviceNotRegistered"
            ]
            if bad_tokens:
                invalidate_tokens_fn(bad_tokens, logger)

        return tickets

    except Exception as e:
        logger.error("expo: dispatch failed | camera=%s | %s", camera, e)
        return []