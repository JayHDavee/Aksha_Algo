"""
telegram.py — Async Telegram Bot API Notification Sender
=========================================================

Role
----
This module is responsible for dispatching Aksha V2.1 alert and status
notifications to one or more Telegram chats via the official Telegram Bot API
(HTTPS REST endpoints).  All network I/O is fully async, built on ``aiohttp``,
so it integrates cleanly with the asyncio-based notification service without
blocking the event loop.

Send Helpers
------------
Three low-level coroutines handle the actual HTTP calls:

* ``send_to_telegram_async0(chat_id, bot_token, message, logger)``
    Sends a plain-text Markdown message via ``/sendMessage``.  Used when no
    image is available (text-only fallback) or for RTSP status notifications.

* ``send_to_telegram_async(image_path, chat_id, bot_token, caption, logger)``
    Sends a single JPEG image with a Markdown caption via ``/sendPhoto``,
    uploaded as multipart/form-data.  Used for individual alert snapshots.

* ``send_to_telegram_async2(bot_token, chat_id, images, caption, logger)``
    Sends a media group of multiple JPEG images (up to 10) via
    ``/sendMediaGroup``, with the caption attached to the first item.  Used for
    AutoAlert notifications where both a raw frame image and an annotated alert
    image are available.  File handles are opened before the request and always
    closed in a ``finally`` block to prevent descriptor leaks even on retry.

Rate Limiting
-------------
Telegram enforces a per-chat flood-control limit of roughly 1 message/second.
Exceeding it causes the API to return HTTP 429 with a ``retry_after`` parameter
indicating how many seconds the bot must wait before the next message to that
chat.  Sustained violations escalate to longer bans.

``_tg_next_send`` is a module-level ``dict[str, float]`` that tracks, for each
``chat_id``, the earliest monotonic-clock time at which the next message may
be sent.  The helper ``_tg_wait(chat_id)`` computes the remaining wait and
suspends the coroutine for exactly that duration before every send attempt,
enforcing a minimum inter-message gap of ``_TG_MIN_INTERVAL`` (1.1 s) per chat.

Retry Logic
-----------
Each send helper accepts an internal ``_retry`` flag (default ``True``).  If
the Telegram API returns a 429 error code:

* ``retry_after <= 60 s`` — the coroutine sleeps for ``retry_after`` seconds
  and then calls itself once more with ``_retry=False`` to prevent infinite
  loops.
* ``retry_after > 60 s`` — the message is dropped (to avoid blocking the
  notification pipeline for over a minute) and the error is logged at ERROR
  level.

All other Telegram API errors (non-OK responses with codes other than 429) are
logged at ERROR level without retry.

Alert Image Path Resolution
---------------------------
Timestamps stored in the database may contain colons (``:``) and spaces, which
are illegal in most file system paths on Windows and cause issues in URL paths.
When alert images are saved to disk the notification writer substitutes colons
with hyphens and spaces with underscores.  The dispatcher therefore constructs
two candidate paths:

1. ``clean_timestamp`` path — colons replaced with ``-``, spaces with ``_``
   (matches the filename convention used by the frame writer).
2. ``Timestamp`` path — the raw timestamp string used verbatim as the filename
   prefix (legacy fallback for older stored frames).

The first path that ``os.path.exists()`` confirms is used; if neither exists
the notification falls back to a text-only message.

Alert Types Handled by ``telegram()``
--------------------------------------
* ``"Alert"`` / ``"No Object Alert"``
    Filters ``alert_notification_validity`` to include only active alerts,
    builds a per-alert summary block, then:
    - If the alert JPEG exists → sends photo + caption via
      ``send_to_telegram_async``.
    - Otherwise → sends text-only caption via ``send_to_telegram_async0``.

* ``"AutoAlert"``
    Collects the raw frame JPEG and the annotated autoalert JPEG, then:
    - Both images found → sends as a two-photo media group via
      ``send_to_telegram_async2``.
    - One image found → sends single photo via ``send_to_telegram_async``.
    - No images → sends text-only message via ``send_to_telegram_async0``.

* Any other ``Type`` (RTSP notifications)
    Builds a status message whose wording depends on ``RTSP_bool`` (``True``
    = camera is back in service; ``False`` = camera is experiencing connection
    issues) and sends it as plain text via ``send_to_telegram_async0``.
"""

import os
import time
import asyncio
import textwrap
import json
from pathlib import Path
import aiohttp

# -------------------- PER-CHAT RATE LIMITER --------------------
# Telegram enforces max 1 message/second per chat. Bursting past this triggers
# flood control bans that can last tens of minutes (or hours).
_tg_next_send: dict[str, float] = {}
_TG_MIN_INTERVAL = 1.1  # seconds between messages to the same chat_id

async def _tg_wait(chat_id):
    """Per-chat rate limiter using the monotonic clock.

    Computes how many seconds remain before the next send is allowed for
    ``chat_id`` and suspends the current coroutine for that duration.  After
    waking (or immediately if no wait is needed) it records the next allowed
    send time as ``now + _TG_MIN_INTERVAL``, ensuring at least 1.1 s between
    consecutive messages to the same chat.

    This function must be awaited before every Telegram API call to prevent
    hitting Telegram's per-chat flood-control limit (≈1 msg/s).  It is safe
    to call from multiple concurrent coroutines; Python's GIL ensures the
    dict read-modify-write is atomic at the bytecode level.

    Args:
        chat_id (str | int): The Telegram chat identifier.  Converted to
            ``str`` internally so integer and string forms are treated as the
            same key.
    """
    key = str(chat_id)
    wait = _tg_next_send.get(key, 0.0) - time.monotonic()
    if wait > 0:
        await asyncio.sleep(wait)
    _tg_next_send[key] = time.monotonic() + _TG_MIN_INTERVAL

# -------------------- RESPONSE CHECK --------------------

def _check_tg_response(result, chat_id, logger):
    """Parse a Telegram Bot API JSON response and surface error information.

    Telegram always returns a JSON object with at minimum an ``"ok"`` boolean
    field.  When ``ok`` is ``False`` the response also carries ``"error_code"``
    and ``"description"``.  For flood-control errors (error_code 429) the
    ``"parameters"`` sub-object contains a ``"retry_after"`` integer.

    Args:
        result (dict): Decoded JSON response from the Telegram API.
        chat_id (str | int): The target chat identifier, used only for log
            messages.
        logger: A standard Python logger instance.

    Returns:
        int | None: The ``retry_after`` value (in seconds) if the response
        indicates a 429 flood-control error and the field is present; ``None``
        for any other outcome (success, different error code, or malformed
        response).

    Side Effects:
        Logs a WARNING for 429 errors and an ERROR for all other non-OK
        responses.

    Returns retry_after seconds if 429 flood control, else None."""
    if isinstance(result, dict) and not result.get("ok", True):
        code = result.get("error_code")
        desc = result.get("description", "")
        retry = result.get("parameters", {}).get("retry_after")
        if code == 429:
            logger.warning(f"Telegram flood control chat_id={chat_id} retry_after={retry}s: {desc}")
            return retry
        else:
            logger.error(f"Telegram API error chat_id={chat_id} code={code}: {desc}")
    return None

# -------------------- LOW-LEVEL SEND HELPERS --------------------

async def send_to_telegram_async0(chat_id, bot_token, message, logger, _retry=True):
    """Send a plain-text Markdown message to a single Telegram chat.

    Posts to the ``/sendMessage`` Bot API endpoint with ``parse_mode`` set to
    ``"Markdown"``, allowing bold/italic/code formatting in the message body.

    Rate Limiting:
        Awaits ``_tg_wait(chat_id)`` before the HTTP request to respect the
        per-chat 1.1 s minimum inter-message interval.

    Retry Logic:
        If the API returns a 429 flood-control error and ``_retry`` is ``True``:
        - ``retry_after <= 60 s`` → sleeps for ``retry_after`` seconds, then
          recurses once with ``_retry=False`` to send a single retry attempt.
        - ``retry_after > 60 s`` → logs an ERROR and returns the raw API
          response without retrying (message dropped to avoid pipeline stall).

    Args:
        chat_id (str | int): Telegram chat or channel identifier.
        bot_token (str): Bot authentication token issued by @BotFather.
        message (str): The text to send.  Markdown formatting is supported.
        logger: A standard Python logger instance.
        _retry (bool): Internal flag; callers should leave this at its default
            ``True``.  Set to ``False`` on the recursive retry call to prevent
            infinite retry loops.

    Returns:
        dict: The decoded JSON response from the Telegram API, e.g.
        ``{"ok": True, "result": {...}}`` on success or
        ``{"ok": False, "error": "..."}`` on failure.
    """
    # Stage: send plain-text message to a single Telegram chat
    logger.info(f"send_to_telegram_async0 | chat_id={chat_id} | message_len={len(message)}")
    try:
        await _tg_wait(chat_id)
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            'chat_id': chat_id,
            'text': message,
            'parse_mode': 'Markdown'
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                result = await response.json()
                retry_after = _check_tg_response(result, chat_id, logger)
                if retry_after is not None and _retry:
                    if retry_after <= 60:
                        logger.warning(f"Retrying after {retry_after}s | chat_id={chat_id}")
                        await asyncio.sleep(retry_after)
                        return await send_to_telegram_async0(chat_id, bot_token, message, logger, _retry=False)
                    else:
                        logger.error(f"Flood control retry_after={retry_after}s too long — message dropped | chat_id={chat_id}")
                        return result
                logger.info(f"send_to_telegram_async0 complete | chat_id={chat_id} | ok={result.get('ok')}")
                return result
    except Exception as e:
        logger.error(f"Failed to send Telegram message: {e}")
        return {"ok": False, "error": str(e)}


async def send_to_telegram_async(image_path, chat_id, bot_token, caption, logger, _retry=True):
    """Send a single JPEG image with a Markdown caption to a Telegram chat.

    Opens the image file at ``image_path`` and posts it to the ``/sendPhoto``
    Bot API endpoint as a ``multipart/form-data`` body, alongside ``chat_id``
    and ``caption`` fields.  Telegram will display the image inline in the chat
    with the caption rendered below it.

    Rate Limiting:
        Awaits ``_tg_wait(chat_id)`` before opening the HTTP connection.

    Retry Logic:
        Identical to ``send_to_telegram_async0``: on a 429 response with
        ``retry_after <= 60 s``, sleeps and recurses once with
        ``_retry=False``; for longer delays the message is dropped and the
        error is logged.

    Args:
        image_path (str | Path): Absolute path to the JPEG file to upload.
        chat_id (str | int): Telegram chat or channel identifier.
        bot_token (str): Bot authentication token.
        caption (str): Markdown-formatted caption shown beneath the photo.
        logger: A standard Python logger instance.
        _retry (bool): Internal retry guard; leave at default ``True`` for
            normal use.

    Returns:
        dict: Decoded Telegram API JSON response.
    """
    # Stage: send a single photo with caption to a Telegram chat
    logger.info(f"send_to_telegram_async | chat_id={chat_id} | image_path={image_path}")
    try:
        await _tg_wait(chat_id)
        url = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
        async with aiohttp.ClientSession() as session:
            with open(image_path, 'rb') as image_file:
                form_data = aiohttp.FormData()
                form_data.add_field('photo', image_file, filename=os.path.basename(image_path))
                form_data.add_field('chat_id', chat_id)
                form_data.add_field('caption', caption)
                async with session.post(url, data=form_data) as response:
                    result = await response.json()
                    retry_after = _check_tg_response(result, chat_id, logger)
                    if retry_after is not None and _retry:
                        if retry_after <= 60:
                            logger.warning(f"Retrying after {retry_after}s | chat_id={chat_id}")
                            await asyncio.sleep(retry_after)
                            return await send_to_telegram_async(image_path, chat_id, bot_token, caption, logger, _retry=False)
                        else:
                            logger.error(f"Flood control retry_after={retry_after}s too long — message dropped | chat_id={chat_id}")
                            return result
                    logger.info(f"send_to_telegram_async complete | chat_id={chat_id} | ok={result.get('ok')}")
                    return result
    except Exception as e:
        logger.error(f"Failed to send Telegram photo: {e}")
        return {"ok": False, "error": str(e)}


async def send_to_telegram_async2(bot_token, chat_id, images, caption, logger, _retry=True):
    """Send a media group (multiple photos) to a single Telegram chat.

    Uses the ``/sendMediaGroup`` Bot API endpoint, which accepts a JSON array
    of ``InputMediaPhoto`` objects under the ``media`` field.  Each image file
    is attached to the multipart/form-data body using the ``attach://``
    pseudo-scheme so Telegram's API can reference the uploaded bytes from the
    ``media`` JSON descriptor.

    The caption (Markdown-formatted) is placed only on the first item in the
    ``media`` array, as Telegram's API only allows a caption on the first item
    of a media group.

    File Handle Management:
        All file handles are opened *before* the HTTP request in a plain dict
        (``{filename: file_obj}``).  A ``try/finally`` block guarantees they
        are closed after the request completes or fails — including in the
        retry path, where the handles are closed before the recursive call so
        the recursive invocation opens fresh handles.

    Rate Limiting:
        Awaits ``_tg_wait(chat_id)`` before the HTTP request.

    Retry Logic:
        On 429 with ``retry_after <= 60 s``: closes all open file handles,
        sleeps, then recurses once with ``_retry=False``.  For longer delays
        the group is dropped.

    Args:
        bot_token (str): Bot authentication token.
        chat_id (str | int): Telegram chat identifier.
        images (list[str]): Ordered list of absolute paths to JPEG files.
            Telegram supports 2–10 items in a single media group.
        caption (str): Markdown caption for the first image in the group.
        logger: A standard Python logger instance.
        _retry (bool): Internal retry guard.

    Returns:
        dict | None: Decoded Telegram API JSON response, or ``None`` if an
        unexpected exception prevented the request from completing.
    """
    # Stage: send a media group (multiple photos) to a single Telegram chat
    logger.info(f"send_to_telegram_async2 | chat_id={chat_id} | image_count={len(images)}")
    try:
        await _tg_wait(chat_id)
        url = f"https://api.telegram.org/bot{bot_token}/sendMediaGroup"
        media = []
        for image_path in images:
            media.append({
                'type': 'photo',
                'media': f'attach://{os.path.basename(image_path)}',
            })
        media[0]['caption'] = caption

        files = {os.path.basename(img): open(img, 'rb') for img in images}
        result = None
        try:
            async with aiohttp.ClientSession() as session:
                form_data = aiohttp.FormData()
                form_data.add_field('media', json.dumps(media))
                form_data.add_field('chat_id', chat_id)
                for filename, file_obj in files.items():
                    form_data.add_field(filename, file_obj, filename=filename)
                async with session.post(url, data=form_data) as response:
                    result = await response.json()
                    retry_after = _check_tg_response(result, chat_id, logger)
                    if retry_after is not None and _retry:
                        if retry_after <= 60:
                            logger.warning(f"Retrying after {retry_after}s | chat_id={chat_id}")
                            await asyncio.sleep(retry_after)
                            for f in files.values():
                                f.close()
                            return await send_to_telegram_async2(bot_token, chat_id, images, caption, logger, _retry=False)
                        else:
                            logger.error(f"Flood control retry_after={retry_after}s too long — message dropped | chat_id={chat_id}")
                            return result
                    logger.info(f"send_to_telegram_async2 complete | chat_id={chat_id}")
        finally:
            for file_obj in files.values():
                file_obj.close()

        return result
    except Exception as e:
        logger.error(f"Failed to send Telegram media group: {e}")
        return {"ok": False, "error": str(e)}

# -------------------- MAIN TELEGRAM FUNCTION --------------------

async def telegram(subscription: str, camera: str, Type: str, DataPath: str, Timestamp: str,
                   RTSP_Link: str, RTSP_bool: bool, logger, alert_notification_validity: list = None,
                   alert: list = None, description: list = None,
                   telegram_service: dict = None):
    """Main Telegram notification dispatcher — routes by alert type and sends to all configured chats.

    This is the primary entry point called by the notification service for every
    outbound Telegram notification.  It inspects ``Type`` to determine the
    notification category, constructs the appropriate message text and resolves
    any associated image paths, then iterates over all configured ``chat_ids``
    to deliver the notification.

    Routing Logic
    -------------
    ``Type == "Alert"`` or ``Type == "No Object Alert"``:
        Loops through the parallel ``alert`` / ``description`` /
        ``alert_notification_validity`` lists and appends a summary block for
        each alert whose validity flag is ``True``.  Attempts to resolve the
        alert snapshot JPEG using the ``clean_timestamp`` filename first, then
        falls back to the raw ``Timestamp`` string.  Sends photo+caption if an
        image is found, otherwise plain text.

    ``Type == "AutoAlert"``:
        Collects two images — a raw frame JPEG and an annotated autoalert JPEG
        — applying the same dual-path resolution strategy.  Sends a two-photo
        media group if both images exist, a single photo if only one is found,
        or plain text if neither is found.

    Any other ``Type`` (RTSP notifications):
        Determines a human-readable ``status`` string from ``RTSP_bool``
        (``True`` → "back in service", ``False`` → "facing connection issues")
        and selects the appropriate message template.  Sends text-only.

    Args:
        subscription (str): The subscription/tenant identifier, used for
            logging context.
        camera (str): Camera name, used both in log messages and as a path
            component under ``DataPath``.
        Type (str): Notification category — ``"Alert"``, ``"No Object Alert"``,
            ``"AutoAlert"``, or an RTSP status string.
        DataPath (str): Root directory under which per-camera frame and alert
            images are stored (e.g. ``/data/aksha``).
        Timestamp (str): ISO-8601-ish timestamp string for the event.  May
            contain ``T`` or a space as the date/time separator; colons in the
            time component make it unsuitable for use as a filename directly.
        RTSP_Link (str): The RTSP stream URL for the camera, included in RTSP
            status notifications.
        RTSP_bool (bool): ``True`` if the camera stream has just come back
            online; ``False`` if it has gone offline.
        logger: A standard Python logger instance provided by the caller.
        alert_notification_validity (list[bool] | None): Parallel list to
            ``alert`` and ``description`` indicating whether each alert is
            currently active and should be included in the notification.
        alert (list[str] | None): Alert names, one per detected alert class.
        description (list[str] | None): Human-readable descriptions, one per
            alert class.
        telegram_service (dict | None): Configuration dict with keys:
            - ``"service_status"`` (bool): Whether Telegram notifications are
              enabled for this subscription.
            - ``"chat_ids"`` (list[str]): Telegram chat/channel identifiers.
            - ``"bot_token"`` (str): Bot API token.

    Returns:
        str: A status string describing the outcome, e.g.
        ``"Telegram notifications sent"``, ``"Telegram service not activated"``,
        ``"Missing Telegram configuration"``, or an error message.
    """

    if telegram_service is None:
        telegram_service = {"service_status": False, "chat_ids": None, "bot_token": None}

    logger.info(
        f"telegram() | camera={camera} | Type={Type} | subscription={subscription} "
        f"| service_status={telegram_service.get('service_status')} "
        f"| chat_ids={telegram_service.get('chat_ids')}"
    )

    if not telegram_service.get("service_status"):
        logger.info("Telegram service not activated")
        return 'Telegram service not activated'

    try:
        chat_ids = telegram_service.get("chat_ids", [])
        bot_token = telegram_service.get("bot_token", "")

        if not chat_ids or not bot_token:
            logger.error("Missing chat_ids or bot_token for Telegram")
            return "Missing Telegram configuration"

        # Parse the timestamp string to extract just the date component for
        # constructing subdirectory paths.  Timestamps may arrive either in
        # ISO-8601 format with a 'T' separator (e.g. "2024-05-20T14:30:00")
        # or with a space separator (e.g. "2024-05-20 14:30:00").
        timestamp_str = str(Timestamp)
        if 'T' in timestamp_str:
            # ISO-8601 format: split on 'T' and take the date portion
            date_part = timestamp_str.split('T')[0]
        else:
            # Space-separated format: split on ' ' and take the date portion
            date_part = timestamp_str.split(' ')[0]

        # Build a filesystem-safe version of the timestamp by replacing colons
        # (illegal in Windows paths and awkward in URLs) with hyphens and
        # spaces with underscores.  This matches the naming convention used by
        # the frame-writer service when it saves alert snapshots to disk.
        # Example: "2024-05-20 14:30:00" → "2024-05-20_14-30-00"
        clean_timestamp = timestamp_str.replace(':', '-').replace(' ', '_')

        # Construct the root path for all images belonging to this camera.
        # Expected directory layout: {DataPath}/{camera}/alerts/{date_part}/
        # and {DataPath}/{camera}/frame/{date_part}/
        base_path = f'{DataPath}/{camera}'

        if Type in ["Alert", "No Object Alert"]:
            # Stage: build alert message text and locate alert image
            logger.info(f"telegram() | Alert/No-Object path | camera={camera} | timestamp={Timestamp}")

            # Build the initial caption block with camera name and incident time.
            # textwrap.dedent removes leading indentation so the message renders
            # cleanly in Telegram without unwanted leading whitespace.
            telegram_comment = textwrap.dedent(f"""
                🚨 Aksha  V2.1 Alert Notification

                My Alert
                Camera: {camera}
                Incident Time: {Timestamp}
            """)

            # Iterate over each detected alert in parallel with its description
            # and validity flag.  Only alerts with validity=True are included —
            # validity=False means the alert was detected but not configured for
            # notification delivery, so it should be silently skipped.
            has_valid_alerts = False
            if alert and description and alert_notification_validity:
                for alert_name, alert_details, validity in zip(alert, description, alert_notification_validity):
                    if validity:
                        # Mark that at least one valid alert was found so we know
                        # whether to attempt image delivery or fall back to text.
                        has_valid_alerts = True
                        # Append a detail block for this specific alert to the
                        # running caption string.
                        telegram_comment += textwrap.dedent(f"""
                            Alert Name: {alert_name}
                            Alert description: {alert_details}
                        """)

            if has_valid_alerts:
                # Primary path: try the clean_timestamp filename (colons
                # replaced) which matches the frame-writer naming convention.
                alert_image_path = f"{base_path}/alerts/{date_part}/{clean_timestamp}_alert.jpg"

                # Fallback path: try the raw Timestamp string verbatim in case
                # older saved frames used the original timestamp as the prefix.
                alt_alert_image_path = f"{base_path}/alerts/{date_part}/{Timestamp}_alert.jpg"

                # Select whichever candidate path actually exists on disk;
                # if neither is present, image_to_send remains None and the
                # code falls through to the text-only fallback below.
                image_to_send = None
                if os.path.exists(alert_image_path):
                    # Prefer the clean_timestamp path (standard naming)
                    image_to_send = alert_image_path
                elif os.path.exists(alt_alert_image_path):
                    # Fall back to the raw-timestamp path (legacy naming)
                    image_to_send = alt_alert_image_path

                if image_to_send:
                    # An image was found — send photo + caption to every chat_id
                    # configured for this subscription.
                    logger.info(f"Sending alert photo | image={image_to_send} | chat_count={len(chat_ids)}")
                    for chat_id in chat_ids:
                        await send_to_telegram_async(image_to_send, chat_id, bot_token, telegram_comment, logger)
                else:
                    # No image file found on either path — degrade gracefully
                    # to a text-only message so the user still receives the alert.
                    logger.warning(f"Alert image not found at {alert_image_path} or {alt_alert_image_path} — sending text only")
                    for chat_id in chat_ids:
                        await send_to_telegram_async0(chat_id, bot_token, telegram_comment, logger)
            else:
                # No alerts passed the validity filter — send only the base
                # header as a text notification (no image needed).
                logger.info(f"No valid alerts — sending text-only | chat_count={len(chat_ids)}")
                for chat_id in chat_ids:
                    await send_to_telegram_async0(chat_id, bot_token, telegram_comment, logger)

        elif Type == "AutoAlert":
            # Stage: collect frame + autoalert images, send as media group if both exist
            logger.info(f"telegram() | AutoAlert path | camera={camera} | timestamp={Timestamp}")

            # AutoAlert caption — notifies the user of an unusual situation
            # detected autonomously by the AI pipeline (no explicit alert rule
            # was triggered; the model flagged an anomaly on its own).
            telegram_comment = textwrap.dedent(f"""
                ⚠️ Aksha  V2.1 AutoAlert Notification

                AutoAlert
                Dear User, Aksha has come across this unusual situation for {camera} at time {Timestamp},
                please take a look at the Image.
            """)

            # Collect available image paths into a list; the media-group helper
            # will send them all in a single Telegram album message.
            images = []

            # --- Frame image: raw video frame at the time of the anomaly ---
            # Try the clean_timestamp filename first (standard naming convention)
            frame_image_path = f"{base_path}/frame/{date_part}/{clean_timestamp}.jpg"
            # Fallback: raw Timestamp string as filename prefix (legacy naming)
            alt_frame_image_path = f"{base_path}/frame/{date_part}/{Timestamp}.jpg"

            # --- AutoAlert image: annotated snapshot produced by the AI model ---
            # Try the clean_timestamp filename first
            autoalert_image_path = f"{base_path}/alerts/{date_part}/{clean_timestamp}_autoalert.jpg"
            # Fallback: raw Timestamp string as filename prefix
            alt_autoalert_image_path = f"{base_path}/alerts/{date_part}/{Timestamp}_autoalert.jpg"

            # Resolve frame image — append whichever path exists (or neither)
            if os.path.exists(frame_image_path):
                images.append(frame_image_path)
            elif os.path.exists(alt_frame_image_path):
                images.append(alt_frame_image_path)

            # Resolve autoalert image — append whichever path exists (or neither)
            if os.path.exists(autoalert_image_path):
                images.append(autoalert_image_path)
            elif os.path.exists(alt_autoalert_image_path):
                images.append(alt_autoalert_image_path)

            logger.info(f"AutoAlert images found: {images} | chat_count={len(chat_ids)}")

            if len(images) >= 2:
                # Both frame and autoalert images are available — send as a
                # Telegram media group (album) so the user sees them side-by-side.
                for chat_id in chat_ids:
                    await send_to_telegram_async2(bot_token, chat_id, images, telegram_comment, logger)
            elif images:
                # Only one image found — send it as a single photo with caption.
                for chat_id in chat_ids:
                    await send_to_telegram_async(images[0], chat_id, bot_token, telegram_comment, logger)
            else:
                # No images found at all — send text-only notification as a
                # last-resort fallback so the anomaly is still communicated.
                logger.warning(f"AutoAlert images not found for {camera} at {Timestamp} — sending text only")
                for chat_id in chat_ids:
                    await send_to_telegram_async0(chat_id, bot_token, telegram_comment, logger)

        else:
            # Stage: RTSP status notification — text only
            # Map the RTSP_bool flag to a human-readable status string used in
            # the message body: True = stream recovered, False = stream lost.
            status = "back in service" if RTSP_bool else "facing connection issues"
            logger.info(f"telegram() | RTSP path | camera={camera} | Type={Type} | status={status}")

            if RTSP_bool:
                # Camera stream is BACK ONLINE — reassuring message, confirms
                # AI surveillance has resumed.
                telegram_message = textwrap.dedent(f"""
                    📹 Aksha RTSP Notification

                    {Type}

                    Camera: {camera}
                    Time: {Timestamp}
                    Status: {status}
                    RTSP Link: {RTSP_Link or 'Not specified'}

                    CCTV is now under AI Surveillance!
                """)
            else:
                # Camera stream is OFFLINE — warning message, prompts the user
                # to check the RTSP URL and network connectivity.
                telegram_message = textwrap.dedent(f"""
                    📹 Aksha V.2.1 RTSP Notification

                    {Type}

                    Camera: {camera}
                    Time: {Timestamp}
                    Status: {status}
                    RTSP Link: {RTSP_Link or 'Not specified'}

                    Please check RTSP links, make sure it is working!
                """)

            # Send the RTSP status message as plain text to every configured chat
            for chat_id in chat_ids:
                await send_to_telegram_async0(chat_id, bot_token, telegram_message, logger)

        logger.info(f"telegram() complete | camera={camera} | Type={Type} | chat_ids={chat_ids}")
        return "Telegram notifications sent"

    except Exception as e:
        logger.error(f"Telegram service failed: {e}")
        return f"Telegram service failed: {e}"
