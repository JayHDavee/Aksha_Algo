"""
Aksha Notification Service — utils.py
======================================

Role
----
Shared utility layer consumed by ``main.py`` and any other Aksha service that
needs to dispatch alert notifications.  Provides:

* Low-level credential helpers (OAuth2 Gmail, Azure Blob, Google Drive).
* An async notification dispatcher (``notif_async``) that fans email,
  Telegram, and Slack tasks out concurrently.
* A synchronous wrapper (``send``) that runs ``notif_async`` in a fresh
  event loop so callers that are not already inside an async context can
  trigger notifications with a plain function call.
* An RTSP-specific error/recovery path (``error_notification``) used when a
  camera stream goes down or recovers.
* ``NotificationUtils`` — a config-loader class that reads credentials from
  the MongoDB ``Resource`` collection and, where necessary, downloads
  supplementary credential files from Azure Blob Storage.

Architecture
------------
::

    Caller (sync)
        │
        ▼
    send()  ──── asyncio.run() ────► notif_async()
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                         email_gmail() telegram() slack()
                         (always)    (if enabled) (if enabled)
                              │
                              └── asyncio.gather() — all channels concurrent

    error_notification()  ──── asyncio.run() ────► notif_async()
        (RTSP events only; no Gmail thread chaining)

NotificationUtils
-----------------
Instantiated once at service startup by ``main.py``.  Three boolean flags
(``whats_app_service_status``, ``telegram_service_status``,
``slack_service_status``) control which channels are active.  The
``notif_setup_*`` methods query the MongoDB ``Resource`` collection for
credentials and contact details, and ``notif_setup_email`` additionally
downloads a per-sender ``keys.yaml`` OAuth file from Azure Blob Storage so
the Gmail API can authenticate without prompting for consent at runtime.
"""

import json
import sys
import os
import requests
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
import smtplib
import time
from azure.storage.blob import BlobServiceClient, ContentSettings
from pydrive.auth import GoogleAuth
from pydrive.drive import GoogleDrive
from slack_sdk import WebClient
from slack_sdk.web.async_client import AsyncWebClient
from pathlib import Path
from slack_sdk.errors import SlackApiError
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import base64
import asyncio
import aiohttp
import textwrap
from aiogoogle import Aiogoogle
import yaml
from aiogoogle.auth.creds import UserCreds, ClientCreds
import configparser
from azure.storage.blob import BlobServiceClient

# OAuth2 scope constants used by both get_credentials() and the Gmail API build call.
CLIENT_SECRET_FILE = 'client_secret.json'   # Google OAuth2 client secrets file (not committed)
SCOPES = ['https://www.googleapis.com/auth/gmail.send', "https://www.googleapis.com/auth/gmail.modify"]
TOKEN_FILE = 'token.json'                   # Cached OAuth2 token; refreshed automatically

def resource_path(relative_path):
    """Resolve a resource file path that works both in development and PyInstaller bundles.

    When an application is frozen with PyInstaller, data files are extracted
    to a temporary directory referenced by ``sys._MEIPASS``.  At development
    time ``sys._MEIPASS`` does not exist, so the current working directory is
    used as the base instead.

    Args:
        relative_path (str): Path of the resource file relative to the
            application root (or the PyInstaller extraction directory).

    Returns:
        str: Absolute path to the resource file that can be passed to
        ``open()`` or other file-system APIs.
    """
    try:
        # PyInstaller sets _MEIPASS to the temp extraction directory at runtime.
        base_path = sys._MEIPASS
    except Exception as e:
        # Running from source — use the current working directory as the base.
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

def get_credentials():
    """Load or refresh OAuth2 Gmail credentials.

    Implements the standard Google OAuth2 credential lifecycle:

    1. If a cached ``token.json`` exists, load it with
       ``Credentials.from_authorized_user_file``.
    2. If the cached credentials are expired but a refresh token is present,
       call ``creds.refresh(Request())`` to obtain a new access token without
       user interaction.
    3. If no valid credentials exist at all, run the local OAuth consent flow
       via ``InstalledAppFlow`` (opens a browser window; requires interactive
       use during initial setup).
    4. Persist the (new or refreshed) credentials back to ``token.json`` so
       subsequent calls skip the browser flow.

    The ``resource_path`` helper ensures both ``TOKEN_FILE`` and
    ``CLIENT_SECRET_FILE`` resolve correctly in PyInstaller-frozen builds.

    Returns:
        google.oauth2.credentials.Credentials: Valid (non-expired) OAuth2
        credentials scoped to Gmail send and modify.
    """
    creds = None
    # Attempt to load a previously-saved token to avoid an interactive flow.
    if os.path.exists(resource_path(TOKEN_FILE)):
        creds = Credentials.from_authorized_user_file(resource_path(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # Silently refresh the access token using the stored refresh token.
            creds.refresh(Request())
        else:
            # No valid token — start the interactive browser consent flow.
            flow = InstalledAppFlow.from_client_secrets_file(resource_path(CLIENT_SECRET_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        # Persist refreshed/new credentials so the next call avoids the browser flow.
        with open(resource_path(TOKEN_FILE), 'w') as token:
            token.write(creds.to_json())
    return creds

async def send_message(service, user_id, message):
    """Send a pre-built MIME message via the Gmail API.

    Wraps the synchronous ``service.users().messages().send()`` call.  The
    function is declared ``async`` for interface consistency with other
    coroutines in the notification pipeline even though the underlying Gmail
    API client is synchronous.

    Args:
        service: An authenticated ``googleapiclient`` Gmail service resource,
            typically built with ``build('gmail', 'v1', credentials=creds)``.
        user_id (str): The Gmail user ID to send on behalf of.  Use
            ``"me"`` to refer to the authenticated account.
        message (dict): A base64url-encoded message dict as expected by the
            Gmail API ``users.messages.send`` endpoint.

    Returns:
        dict | None: The Gmail API response dict (containing ``"id"`` and
        ``"threadId"`` keys) on success, or ``None`` if an error occurred.
    """
    try:
        # Execute the synchronous Gmail API call; returns the sent message resource.
        message = service.users().messages().send(userId=user_id, body=message).execute()
        print(f'Message Id: {message["id"]}')
        return message
    except Exception as error:
        print(f'An error occurred: {error}')
        return None

def az_upload(camera_dir, subscription, sas_url):
    """Upload a JPEG notification image to Azure Blob Storage and return its URL.

    Uploads the local file ``notification.jpg`` (in the current working
    directory) to the blob path ``<camera_dir>/notification.jpg`` inside the
    container named ``subscription``.  The blob content type is set to
    ``image/jpeg`` so browsers and email clients render it inline rather than
    as a download.

    The upload uses ``overwrite=True`` so re-sending a notification for the
    same camera always replaces the previous image, keeping blob storage usage
    bounded.

    Args:
        camera_dir (str): Virtual directory prefix inside the blob container,
            typically the camera name or a date-partitioned path.
        subscription (str): Azure Blob Storage container name, usually the
            customer subscription identifier.
        sas_url (str): Azure Storage account SAS URL used to authenticate the
            ``BlobServiceClient`` without a full connection string.

    Returns:
        str: The publicly accessible URL of the uploaded blob.
    """
    # Authenticate using the SAS URL — no storage account key required at runtime.
    service = BlobServiceClient(sas_url)
    bb = service.get_blob_client(container=subscription, blob=f"{camera_dir}/notification.jpg")
    # Force content_type so the blob is served as an image, not application/octet-stream.
    image_content_setting = ContentSettings(content_type='image/jpeg')
    with open(f"notification.jpg", "rb") as data:
        bb.upload_blob(data, overwrite=True, content_settings=image_content_setting)
    # Return the blob URL so callers can embed it in email bodies or Telegram messages.
    return bb.url

def get_download_url(folder_id, notif_img):
    """Upload a notification image to Google Drive and return a direct download URL.

    Before uploading, trashes all existing files in the target folder to
    ensure only the most recent notification image is present.  This prevents
    accumulation of stale images and keeps the folder storage usage small.

    Uses PyDrive for authentication and upload; the returned URL uses the
    ``export=download`` parameter so recipients receive the raw JPEG rather
    than being taken to the Drive preview page.

    Args:
        folder_id (str): Google Drive folder ID to upload into.  Resolved by
            ``NotificationUtils.notif_gdrive_folder_id()`` based on the
            deployment's ``app_id``.
        notif_img (str): Local filesystem path to the JPEG image to upload.

    Returns:
        str: A ``https://drive.google.com/uc?id=<file_id>&export=download``
        URL that can be embedded in notification messages.
    """
    # Authenticate with Google Drive using stored PyDrive credentials.
    gauth = GoogleAuth()
    drive = GoogleDrive(gauth)

    # List all non-trashed files in the target folder.
    file_list = drive.ListFile({'q': "'{}' in parents and trashed=false".format(folder_id)}).GetList()
    # Trash existing files to keep the folder clean (only latest image is needed).
    for file in file_list:
        file.Trash()

    # Create a new file entry in the target folder and upload the local image.
    gfile = drive.CreateFile({'parents': [{'id': folder_id}]})
    gfile.SetContentFile(notif_img)
    gfile.Upload()

    # Build a direct-download URL using the newly-assigned Google Drive file ID.
    download_url = f"https://drive.google.com/uc?id={gfile['id']}&export=download"
    return download_url

# -------------------- SOCIAL PLATFORM IMPORTS --------------------

try:
    from socialPlatforms.telegram import telegram
    from socialPlatforms.email import email_gmail
    from socialPlatforms.slack import slack
    from socialPlatforms.whatsapp_message import whatsapp
    from socialPlatforms.expo import expo
except ImportError:
    # Provide no-op stubs so the rest of this module can be imported in
    # environments where the socialPlatforms package is not installed
    # (e.g. unit test runners, documentation builds).
    async def telegram(*args, **kwargs):
        print("Telegram module not available")
        return None

    async def email_gmail(*args, **kwargs):
        print("Email module not available")
        return None

    async def slack(*args, **kwargs):
        print("Slack module not available")
        return None

    async def whatsapp(*args, **kwargs):
        print("WhatsApp module not available")
        return None

    async def expo(*args, **kwargs):
        print("Expo module not available")
        return []

# -------------------- ASYNC NOTIFICATION DISPATCHER --------------------

async def notif_async(subscription: str, recipients: list, sender: str, camera: str, Type: str, DataPath: str, Timestamp: str,
                      RTSP_Link: str, RTSP_Down: bool, logger, alert_notification_validity: list = None, alert: list = None,
                      description: list = None, slack_service: dict = None, telegram_service: dict = None,
                      expo_service: dict = None, namespace=None, main_dir=None):
    """Dispatch alert notifications to all enabled channels concurrently.

    Always dispatches an email notification.  Telegram and Slack are included
    only when their respective service dicts have ``service_status: True``.
    All tasks run concurrently via ``asyncio.gather`` so a slow SMTP relay
    does not delay Telegram delivery and vice versa.

    Default service dicts (used when ``None`` is passed) mark both optional
    channels as disabled, ensuring that callers which do not configure them
    never accidentally trigger sends.

    Args:
        subscription (str): Logical subscription/tenant identifier passed
            through to each platform dispatcher for logging and routing.
        recipients (list[str]): Email addresses to receive the notification.
        sender (str): Gmail sender address (must match the OAuth token).
        camera (str): Name of the camera that generated the alert.
        Type (str): Alert type string (e.g. ``"Alert"``, ``"No Object Alert"``).
        DataPath (str): Path to the directory containing the notification JPEG.
        Timestamp (str): Human-readable timestamp string for the alert.
        RTSP_Link (str | None): RTSP stream URL; ``None`` for non-RTSP alerts.
        RTSP_Down (bool): ``True`` if the notification is about a stream
            outage; ``False`` for object-detection alerts.
        logger: Logger instance for diagnostic messages.
        alert_notification_validity (list | None): Validity flags forwarded
            to platform dispatchers (e.g. ``["valid"]``).
        alert (list | None): Alert type labels forwarded to dispatchers.
        description (list | None): Human-readable description strings
            forwarded to dispatchers for message body construction.
        slack_service (dict | None): Slack config dict with keys
            ``service_status``, ``channels``, ``token``.  Pass ``None`` to
            disable Slack.
        telegram_service (dict | None): Telegram config dict with keys
            ``service_status``, ``chat_ids``, ``bot_token``.  Pass ``None``
            to disable Telegram.
        expo_service (dict | None): Expo push config dict with keys
            ``service_status`` and ``push_tokens`` (list of
            ExponentPushToken strings).  Pass ``None`` to disable Expo.
        namespace: ``NotificationNamespace`` instance used by ``email_gmail``
            to write back the Gmail thread ID after sending.
        main_dir (str | None): Root application directory; forwarded to
            ``email_gmail`` for resolving template and attachment paths.

    Returns:
        list: Raw result list from ``asyncio.gather`` — one element per
        dispatched task.  Elements may be return values from the platform
        functions, ``None``, or ``Exception`` instances if
        ``return_exceptions=True`` is set by the caller.
    """
    # Stage: build task list — always email, optionally telegram and slack
    logger.info(
        f"notif_async | camera={camera} | Type={Type} | subscription={subscription} "
        f"| recipients={recipients} | telegram_enabled={telegram_service.get('service_status') if telegram_service else False} "
        f"| slack_enabled={slack_service.get('service_status') if slack_service else False}"
    )

    # Apply safe defaults so downstream code can always call .get() without None checks.
    if slack_service is None:
        slack_service = {"service_status": False, "channels": None, "token": None}
    if telegram_service is None:
        telegram_service = {"service_status": False, "chat_ids": None, "bot_token": None}
    if expo_service is None:
        expo_service = {"service_status": False, "push_tokens": []}

    tasks = []

    # Stage: always include email task
    logger.info(f"Queuing email task | camera={camera} | to={recipients}")
    tasks.append(
        email_gmail(
            subscription=subscription,
            recipients=recipients,
            sender_email=sender,
            camera=camera,
            Type=Type,
            DataPath=DataPath,
            Timestamp=Timestamp,
            RTSP_Link=RTSP_Link,
            RTSP_bool=RTSP_Down,
            logger=logger,
            alert_notification_validity=alert_notification_validity,
            alert=alert,
            description=description,
            namespace=namespace,
            main_dir=main_dir
        )
    )

    # Stage: add telegram task if service is enabled
    if telegram_service.get("service_status"):
        logger.info(f"Queuing telegram task | camera={camera} | chat_ids={telegram_service.get('chat_ids')}")
        tasks.append(
            telegram(
                subscription=subscription,
                camera=camera,
                Type=Type,
                DataPath=DataPath,
                Timestamp=Timestamp,
                RTSP_Link=RTSP_Link,
                RTSP_bool=RTSP_Down,
                logger=logger,
                alert_notification_validity=alert_notification_validity,
                alert=alert,
                description=description,
                telegram_service=telegram_service
            )
        )

    # Stage: add slack task if service is enabled
    if slack_service.get("service_status"):
        logger.info(f"Queuing slack task | camera={camera} | channels={slack_service.get('channels')}")
        tasks.append(
            slack(
                subscription=subscription,
                camera=camera,
                Type=Type,
                DataPath=DataPath,
                Timestamp=Timestamp,
                logger=logger,
                alert_notification_validity=alert_notification_validity,
                alert=alert,
                description=description,
                slack_service=slack_service
            )
        )

    # Stage: add expo push task if service is enabled
    if expo_service.get("service_status"):
        logger.info(f"Queuing expo push task | camera={camera} | tokens={len(expo_service.get('push_tokens', []))}")
        tasks.append(
            expo(
                subscription=subscription,
                camera=camera,
                Type=Type,
                Timestamp=Timestamp,
                logger=logger,
                alert_notification_validity=alert_notification_validity,
                alert=alert,
                description=description,
                expo_service=expo_service
            )
        )

    # Stage: run all notification tasks concurrently and log results
    logger.info(f"Running {len(tasks)} notification task(s) concurrently | camera={camera}")
    results = await asyncio.gather(*tasks, return_exceptions=True)
    logger.info(f"Notification results: {results}")
    return results

# -------------------- SYNC WRAPPER --------------------

def send(subscription: str, recipients: list, sender: str, camera: str, Type: str, DataPath: str, Timestamp: str,
         sas_url: str, folder_id: str, logger, alert_notification_validity: list = None,
         alert: list = None, description: list = None, whats_app_service: dict = None,
         telegram_service: dict = None, slack_service: dict = None, expo_service: dict = None,
         RTSP_Link: str = None, RTSP_Down: bool = None, namespace=None, main_dir=None):
    """Synchronous wrapper around ``notif_async`` — fire-and-forget from non-async code.

    Creates a brand-new ``asyncio`` event loop via ``asyncio.run()`` to
    execute ``notif_async``.  This means ``send()`` must NOT be called from
    inside a running event loop (use ``await notif_async(...)`` directly in
    that case).

    After the async gather completes, the results list is scanned for a Gmail
    thread ID string.  The ``email_gmail`` coroutine returns a string in the
    form ``"thread:<threadId>"`` or a plain thread ID string (length > 20).
    The extracted thread ID is returned so callers can persist it for reply
    chaining on the next notification.

    Safe defaults are applied for all three optional service dicts so callers
    that only use email can omit those arguments entirely.

    Args:
        subscription (str): Tenant/subscription identifier.
        recipients (list[str]): Email recipient addresses.
        sender (str): Gmail sender address.
        camera (str): Camera name.
        Type (str): Alert type string.
        DataPath (str): Path to notification image directory.
        Timestamp (str): Human-readable alert timestamp.
        sas_url (str): Azure SAS URL (passed through; used by ``az_upload``
            if called separately by the platform dispatcher).
        folder_id (str): Google Drive folder ID (passed through for Drive
            uploads if used by the platform dispatcher).
        logger: Logger instance.
        alert_notification_validity (list | None): Validity flag list.
        alert (list | None): Alert type label list.
        description (list | None): Description string list.
        whats_app_service (dict | None): WhatsApp config dict.  Not currently
            forwarded to ``notif_async``; reserved for future use.
        telegram_service (dict | None): Telegram config dict.
        slack_service (dict | None): Slack config dict.
        RTSP_Link (str | None): RTSP stream URL.
        RTSP_Down (bool | None): ``True`` if the stream is down.
        namespace: ``NotificationNamespace`` for Gmail thread chaining.
        main_dir (str | None): Application root directory.

    Returns:
        tuple[list, str | None]: A 2-tuple of:
        * ``results`` — the raw list from ``asyncio.gather``.
        * ``email_result`` — the extracted Gmail thread ID string, or
          ``None`` if no thread ID was found in the results.
    """
    # Stage: sync entry point — runs notif_async in a new event loop
    logger.info(
        f"send() called | camera={camera} | Type={Type} | subscription={subscription} "
        f"| recipients={recipients}"
    )

    # Apply safe defaults so downstream .get() calls never raise AttributeError.
    if whats_app_service is None:
        whats_app_service = {"service_status": False, "contact_number": None}
    if telegram_service is None:
        telegram_service = {"service_status": False, "chat_ids": None, "bot_token": None}
    if slack_service is None:
        slack_service = {"service_status": False, "channels": None, "token": None}
    if expo_service is None:
        expo_service = {"service_status": False, "push_tokens": []}

    # Record wall-clock time so total notification latency can be logged.
    st_total = time.time()

    # asyncio.run() creates a new event loop, runs the coroutine to completion,
    # then closes the loop.  Do not call send() from inside an existing loop.
    results = asyncio.run(
        notif_async(
            subscription=subscription,
            recipients=recipients,
            sender=sender,
            camera=camera,
            Type=Type,
            DataPath=DataPath,
            Timestamp=Timestamp,
            RTSP_Link=RTSP_Link,
            RTSP_Down=RTSP_Down,
            logger=logger,
            alert_notification_validity=alert_notification_validity,
            alert=alert,
            description=description,
            slack_service=slack_service,
            telegram_service=telegram_service,
            expo_service=expo_service,
            namespace=namespace,
            main_dir=main_dir
        )
    )

    et_total = time.time()
    logger.info(f"Total notification time: {et_total - st_total:.2f}s | camera={camera}")
    print(f"Notification results: {results}")

    # Stage: extract Gmail thread ID from results for email threading
    # email_gmail may return "thread:<id>" or a bare thread ID (len > 20).
    # Scan all results to find whichever format was returned.
    email_result = None
    for result in results:
        if isinstance(result, str) and result.startswith("thread:"):
            # Explicit "thread:" prefix — strip it to get the raw thread ID.
            email_result = result.replace("thread:", "")
        elif result and isinstance(result, str) and len(result) > 20:
            # Bare Gmail thread ID returned directly by the email coroutine.
            email_result = result

    logger.info(f"send() complete | camera={camera} | email_thread_id={email_result}")
    return results, email_result

# -------------------- ERROR NOTIFICATION --------------------

def error_notification(subscription: str, Type: str, recipients: list, sender: str, camera: str, RTSP_Link: str,
                       RTSP_Down: bool, logger, DataPath: str = None, Timestamp: str = None,
                       alert_notification_validity: list = None, alert: list = None, description: list = None,
                       telegram_service: dict = None, slack_service: dict = None, expo_service: dict = None,
                       namespace=None, main_dir=None):
    """Send an RTSP camera error or recovery notification.

    Called when a camera stream goes down (``RTSP_Down=True``) or recovers
    (``RTSP_Down=False``).  Unlike ``send()``, this function does NOT attempt
    to extract or chain a Gmail thread ID from the results — RTSP status
    emails are informational and do not need to be grouped into a reply thread.

    Delegates directly to ``notif_async`` via ``asyncio.run()`` so it may be
    called from synchronous code.

    Args:
        subscription (str): Tenant/subscription identifier.
        Type (str): Notification type string (e.g. ``"RTSP Down"``,
            ``"RTSP Recovered"``).
        recipients (list[str]): Email addresses to notify.
        sender (str): Gmail sender address.
        camera (str): Camera name affected by the RTSP event.
        RTSP_Link (str): Full RTSP stream URL of the affected camera.
        RTSP_Down (bool): ``True`` when the stream is down; ``False`` when it
            has recovered.
        logger: Logger instance.
        DataPath (str | None): Path to a notification image, if available.
        Timestamp (str | None): Human-readable event timestamp.
        alert_notification_validity (list | None): Validity flag list.
        alert (list | None): Alert type label list.
        description (list | None): Human-readable description list.
        telegram_service (dict | None): Telegram config dict.
        slack_service (dict | None): Slack config dict.
        namespace: ``NotificationNamespace`` instance (not used for thread
            chaining here, but accepted for interface consistency).
        main_dir (str | None): Application root directory.

    Returns:
        list | None: Raw results from ``asyncio.gather`` on success, or
        ``None`` if an exception was raised during dispatch.
    """
    # Stage: send RTSP error/recovery notification — does not chain into a thread
    logger.info(
        f"error_notification | camera={camera} | Type={Type} | RTSP_Down={RTSP_Down} "
        f"| recipients={recipients}"
    )
    try:
        # Run the async dispatcher synchronously; no thread ID extraction needed.
        results = asyncio.run(
            notif_async(
                subscription=subscription,
                recipients=recipients,
                sender=sender,
                camera=camera,
                Type=Type,
                DataPath=DataPath,
                Timestamp=Timestamp,
                RTSP_Link=RTSP_Link,
                RTSP_bool=RTSP_Down,
                logger=logger,
                alert_notification_validity=alert_notification_validity,
                alert=alert,
                description=description,
                slack_service=slack_service,
                telegram_service=telegram_service,
                expo_service=expo_service,
                namespace=namespace,
                main_dir=main_dir
            )
        )
        logger.info(f"error_notification complete | camera={camera} | results={results}")
        return results
    except Exception as e:
        logger.error(f"Error in error_notification: {e}")
        return None

# -------------------- NOTIFICATION UTILS --------------------

class NotificationUtils:
    """Credential loader and per-service configuration wrapper.

    Instantiated once at service startup.  Holds the runtime credentials
    config (from ``dev.json``) and exposes ``notif_setup_*`` methods that
    query the MongoDB ``Resource`` collection to populate per-channel service
    dicts.

    Service Status Flags
    --------------------
    Three tri-state flags control which channels are active.  Each flag can be:

    * ``True``  — channel is enabled; credentials will be fetched and used.
    * ``False`` — channel is explicitly disabled; a disabled service dict is
      returned without querying MongoDB for credentials.
    * ``None``  — channel status is unconfigured; an unconfigured service dict
      is returned (``service_status: None``).

    The flags are set by the caller immediately after instantiation::

        notif_utils = NotificationUtils(config, main_dir, logger)
        notif_utils.whats_app_service_status = False
        notif_utils.telegram_service_status  = True
        notif_utils.slack_service_status     = False

    Attributes:
        config (dict): Parsed ``dev.json`` secrets dict.
        main_dir (str): Application root directory (used to locate
            ``app.config``).
        logger: Logger instance.
        whats_app_service_status (bool | None): WhatsApp channel flag.
        telegram_service_status (bool | None): Telegram channel flag.
        slack_service_status (bool | None): Slack channel flag.
        COLLECTION_Resource: Cached reference to the last MongoDB
            ``Resource`` collection passed to a ``notif_setup_*`` method.
    """

    def __init__(self, config, main_dir, logger):
        """Initialise with credentials config, application root, and a logger.

        All three service-status flags are initialised to ``None`` (unconfigured).
        The caller is responsible for setting them to ``True`` or ``False``
        before calling any ``notif_setup_*`` method, so that each deployment
        can independently enable or disable channels without code changes.

        Args:
            config (dict): Parsed ``dev.json`` credentials dictionary
                containing Azure connection strings, app IDs, blob names, etc.
            main_dir (str): Absolute path to the application root directory.
                Used to locate ``app.config`` for Gmail thread ID persistence.
            logger: Logger instance shared with the calling service.
        """
        self.config = config                  # dev.json secrets (Azure, OAuth app IDs, etc.)
        self.main_dir = main_dir              # root dir for app.config and credential files
        self.logger = logger
        # Service flags — all None (unconfigured) until the caller sets them explicitly.
        self.whats_app_service_status = None
        self.telegram_service_status = None
        self.slack_service_status = None
        self.expo_service_status = None
        # Cached MongoDB collection reference set by each notif_setup_* call.
        self.COLLECTION_Resource = None
        self.logger.info("NotificationUtils initialised")

    def notif_gdrive_folder_id(self):
        """Return the Google Drive parent folder ID for this deployment's app_id.

        Reads the ``app_id`` key from the ``[Client_data]`` section of
        ``app.config`` and maps it to the corresponding Google Drive folder ID
        stored in ``dev.json``.  Three known deployment identifiers are
        supported: UT, Shaarda, and Aksha Team.

        If the ``app_id`` does not match any known identifier, or if
        ``app.config`` cannot be read, returns ``None`` and logs a warning.

        Returns:
            str | None: Google Drive folder ID suitable for passing to
            ``get_download_url``, or ``None`` if the mapping failed.
        """
        # Stage: look up Google Drive parent folder ID from app.config for image uploads
        try:
            app_config = configparser.RawConfigParser()
            app_config.read(f"{self.main_dir}/app.config")
            # Read all key-value pairs from [Client_data] into a plain dict.
            details_dict = dict(app_config.items('Client_data'))

            # Map the deployment's app_id to the corresponding Drive folder ID.
            if details_dict['app_id'] == self.config.get('UT_app_id'):
                return self.config.get('PARENT_ID_UT')
            if details_dict['app_id'] == self.config.get('Shaarda_app_id'):
                return self.config.get('PARENT_ID_SHAARDA')
            if details_dict['app_id'] == self.config.get('Aksha_team_app_id'):
                return self.config.get('PARENT_ID_AKSHA_TEAM')
            self.logger.info("folder_id fetched successfully!!")
        except Exception as e:
            self.logger.info(f"unable to get folder_id, failed with exception: {e}")
        return None

    def notif_setup_email(self, COLLECTION_Resource):
        """Load email notification config from MongoDB and download OAuth keys.

        Queries the first document in the ``Resource`` collection to extract:
        * ``notification_email`` — list of recipient email addresses.
        * ``username`` — the subscription/tenant identifier.
        * ``new_email`` — the Gmail sender address (defaults to the
          Aksha service account if absent).

        Additionally downloads ``<sender_email>.yaml`` from Azure Blob
        Storage into the local working directory as ``keys.yaml``.  This
        file contains the OAuth2 user credentials (access token, refresh
        token) required by the Gmail API.  The download is skipped if the
        Azure connection fails, with a warning logged; email sending will
        fail later if the file is genuinely missing.

        Finally, reads the current Gmail ``threadId`` from ``app.config``
        so reply-chaining is preserved across service restarts.

        Args:
            COLLECTION_Resource: PyMongo ``Collection`` object pointing at
                the ``Resource`` collection in the Aksha database.

        Returns:
            tuple[list, str | None, str | None, str | None]:
            * ``recipients`` — list of email address strings (empty list on
              failure).
            * ``subscription`` — tenant identifier string, or ``None``.
            * ``sender`` — Gmail sender address string, or ``None``.
            * ``threadId`` — current Gmail thread ID string, or ``None``.
        """
        # Stage: fetch email recipients, sender address, and OAuth keys from MongoDB Resource doc
        self.logger.info("notif_setup_email | reading Resource collection")
        try:
            self.COLLECTION_Resource = COLLECTION_Resource
            # find_one() returns the first (and typically only) Resource document.
            Resource_Data = self.COLLECTION_Resource.find_one()

            if Resource_Data is None:
                self.logger.info("Resource_Data is None — no email config found")
                return [], None, None, None

            recipients = Resource_Data.get("notification_email", [])
            subscription = Resource_Data.get("username", "default")
            sender = Resource_Data.get("new_email", "aksha@algoanalytics.com")
            self.logger.info(f"Email config loaded | recipients={recipients} | sender={sender}")

            # Stage: download OAuth keys.yaml from Azure blob storage for Gmail API auth
            # The YAML file is named after the sender email address to support multi-tenant
            # deployments where different customers send from different Gmail accounts.
            try:
                blob_service_client = BlobServiceClient.from_connection_string(self.config['connection_string'])
                container_client = blob_service_client.get_container_client(self.config['blob_name'])
                blob_client = container_client.get_blob_client(f"{sender}.yaml")
                with open("keys.yaml", "wb") as download_file:
                    download_file.write(blob_client.download_blob().readall())
                self.logger.info(f"Downloaded keys.yaml for sender: {sender}")
            except Exception as e:
                # Non-fatal — email sends will fail only if keys.yaml is truly absent.
                self.logger.warning(f"Could not download keys.yaml: {e}")

            # Stage: read Gmail thread ID to continue reply chain
            threadId = None
            try:
                app_config = configparser.RawConfigParser()
                app_config.read(f"{self.main_dir}/app.config")
                # fallback=None avoids a NoSectionError / NoOptionError if the key is missing.
                threadId = app_config.get('Client_data', 'threadId', fallback=None)
                self.logger.info(f"threadId read from app.config: {threadId}")
            except Exception as e:
                self.logger.warning(f"Could not read threadId from config: {e}")

            return recipients, subscription, sender, threadId

        except Exception as e:
            self.logger.info(f"Connection to Resource Collection failed: {e}")
            return [], None, None, None

    def notif_setup_whatsapp(self, COLLECTION_Resource):
        """Load WhatsApp notification config from MongoDB.

        Returns a service dict whose content depends on
        ``self.whats_app_service_status``:

        * ``True`` — queries MongoDB for ``contact_number`` and returns a
          dict with ``service_status: True``.  Falls back to disabled if the
          field is missing.
        * ``False`` — returns a disabled dict without querying for credentials.
        * ``None`` — returns an unconfigured dict (``service_status: None``).

        Args:
            COLLECTION_Resource: PyMongo ``Collection`` object for the
                ``Resource`` collection.

        Returns:
            tuple[str | None, dict | None]:
            * ``subscription`` — tenant identifier, or ``None`` on failure.
            * ``whats_app_service`` — service config dict with keys
              ``service_status`` and ``contact_number``, or ``None`` on
              collection failure.
        """
        # Stage: fetch WhatsApp contact number if service is enabled
        self.logger.info(f"notif_setup_whatsapp | service_status={self.whats_app_service_status}")
        try:
            self.COLLECTION_Resource = COLLECTION_Resource
            Resource_Data = self.COLLECTION_Resource.find_one()
            subscription = Resource_Data.get("username", "default")

            if self.whats_app_service_status:
                # Service is enabled — attempt to read the contact number.
                try:
                    contact_number = Resource_Data.get("contact_number")
                    whats_app_service = {"service_status": True, "contact_number": contact_number}
                    self.logger.info(f"WhatsApp service configured | contact_number={contact_number}")
                except Exception as e:
                    # Contact number field is missing — disable gracefully.
                    self.logger.info("WhatsApp service enabled but contact number not found")
                    whats_app_service = {"service_status": False, "contact_number": None}
                return subscription, whats_app_service

            elif self.whats_app_service_status == False:
                # Explicitly disabled — return a disabled dict without querying credentials.
                self.logger.info("WhatsApp service disabled")
                whats_app_service = {"service_status": False, "contact_number": None}
                return subscription, whats_app_service

            else:
                # Status is None — service is unconfigured; return sentinel dict.
                self.logger.info("WhatsApp service status is None — service unconfigured")
                whats_app_service = {"service_status": None, "contact_number": None}
                return subscription, whats_app_service

        except Exception as e:
            self.logger.info(f"Connection to Resource Collection failed: {e}")
            return None, None

    def notif_setup_telegram(self, COLLECTION_Resource):
        """Load Telegram notification config from MongoDB.

        Returns a service dict whose content depends on
        ``self.telegram_service_status``:

        * ``True`` — queries MongoDB for ``chat_ids`` (list) and
          ``bot_token`` (str) and returns a dict with ``service_status: True``.
          Falls back to disabled if the fields are missing.
        * ``False`` — returns a disabled dict without querying for credentials.
        * ``None`` — returns an unconfigured dict (``service_status: None``).

        Args:
            COLLECTION_Resource: PyMongo ``Collection`` object for the
                ``Resource`` collection.

        Returns:
            tuple[str | None, dict | None]:
            * ``subscription`` — tenant identifier, or ``None`` on failure.
            * ``telegram_service`` — service config dict with keys
              ``service_status``, ``chat_ids``, and ``bot_token``, or
              ``None`` on collection failure.
        """
        # Stage: fetch Telegram bot_token and chat_ids if service is enabled
        self.logger.info(f"notif_setup_telegram | service_status={self.telegram_service_status}")
        try:
            self.COLLECTION_Resource = COLLECTION_Resource
            Resource_Data = self.COLLECTION_Resource.find_one()
            subscription = Resource_Data.get("username", "default")

            if self.telegram_service_status:
                # Service is enabled — attempt to read bot credentials.
                try:
                    chat_ids = Resource_Data.get("chat_ids", [])
                    bot_token = Resource_Data.get("bot_token", "")
                    telegram_service = {"service_status": True, "chat_ids": chat_ids, "bot_token": bot_token}
                    self.logger.info(f"Telegram service configured | chat_ids={chat_ids}")
                except Exception as e:
                    # Credentials missing — disable gracefully.
                    self.logger.info("Telegram service enabled but chat_ids or bot_token not found")
                    telegram_service = {"service_status": False, "chat_ids": None, "bot_token": None}
                return subscription, telegram_service

            elif self.telegram_service_status == False:
                # Explicitly disabled — skip credential lookup.
                self.logger.info("Telegram service disabled")
                telegram_service = {"service_status": False, "chat_ids": None, "bot_token": None}
                return subscription, telegram_service

            else:
                # Status is None — service is unconfigured; return sentinel dict.
                self.logger.info("Telegram service status is None — service unconfigured")
                telegram_service = {"service_status": None, "chat_ids": None, "bot_token": None}
                return subscription, telegram_service

        except Exception as e:
            self.logger.info(f"Connection to Resource Collection failed: {e}")
            return None, None

    def notif_setup_slack(self, COLLECTION_Resource):
        """Load Slack notification config from MongoDB.

        Returns a service dict whose content depends on
        ``self.slack_service_status``:

        * ``True`` — queries MongoDB for ``slack_channels`` (list) and
          ``slack_token`` (str) and returns a dict with ``service_status: True``.
          Falls back to disabled if the fields are missing.
        * ``False`` — returns a disabled dict without querying for credentials.
        * ``None`` — returns an unconfigured dict (``service_status: None``).

        Args:
            COLLECTION_Resource: PyMongo ``Collection`` object for the
                ``Resource`` collection.

        Returns:
            tuple[str | None, dict | None]:
            * ``subscription`` — tenant identifier, or ``None`` on failure.
            * ``slack_service`` — service config dict with keys
              ``service_status``, ``channels``, and ``token``, or ``None``
              on collection failure.
        """
        # Stage: fetch Slack token and channel list if service is enabled
        self.logger.info(f"notif_setup_slack | service_status={self.slack_service_status}")
        try:
            self.COLLECTION_Resource = COLLECTION_Resource
            Resource_Data = self.COLLECTION_Resource.find_one()
            subscription = Resource_Data.get("username", "default")

            if self.slack_service_status:
                # Service is enabled — attempt to read Slack workspace credentials.
                try:
                    channels = Resource_Data.get("slack_channels", [])
                    token = Resource_Data.get("slack_token", "")
                    slack_service = {"service_status": True, "channels": channels, "token": token}
                    self.logger.info(f"Slack service configured | channels={channels}")
                except Exception as e:
                    # Credentials missing — disable gracefully.
                    self.logger.info("Slack service enabled but channels or token not found")
                    slack_service = {"service_status": False, "channels": None, "token": None}
                return subscription, slack_service

            elif self.slack_service_status == False:
                # Explicitly disabled — skip credential lookup.
                self.logger.info("Slack service disabled")
                slack_service = {"service_status": False, "channels": None, "token": None}
                return subscription, slack_service

            else:
                # Status is None — service is unconfigured; return sentinel dict.
                self.logger.info("Slack service status is None — service unconfigured")
                slack_service = {"service_status": None, "channels": None, "token": None}
                return subscription, slack_service

        except Exception as e:
            self.logger.info(f"Connection to Resource Collection failed: {e}")
            return None, None

    def notif_setup_expo(self, COLLECTION_Resource):
        """Load Expo push notification config from MongoDB.

        Reads ``expo_push_tokens`` (list of ExponentPushToken strings) from
        the first document in the ``Resource`` collection.

        Returns a service dict whose content depends on
        ``self.expo_service_status``:

        * ``True`` — queries MongoDB for ``expo_push_tokens`` and returns a
          dict with ``service_status: True``.  Falls back to disabled if the
          field is missing or empty.
        * ``False`` — returns a disabled dict without querying MongoDB.
        * ``None`` — returns an unconfigured dict (``service_status: None``).

        The MongoDB field ``expo_push_tokens`` should be a list of strings in
        the form ``"ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"``.  These are
        registered by the mobile app on first launch and stored per deployment.

        Args:
            COLLECTION_Resource: PyMongo ``Collection`` object for the
                ``Resource`` collection.

        Returns:
            tuple[str | None, dict | None]:
            * ``subscription`` — tenant identifier, or ``None`` on failure.
            * ``expo_service`` — service config dict with keys
              ``service_status`` and ``push_tokens``, or ``None`` on
              collection failure.
        """
        self.logger.info(f"notif_setup_expo | service_status={self.expo_service_status}")
        try:
            self.COLLECTION_Resource = COLLECTION_Resource
            Resource_Data = self.COLLECTION_Resource.find_one()
            subscription = Resource_Data.get("username", "default")

            if self.expo_service_status:
                try:
                    push_tokens = Resource_Data.get("expo_push_tokens", [])
                    if not push_tokens:
                        self.logger.info("Expo service enabled but expo_push_tokens not found or empty")
                        expo_service = {"service_status": False, "push_tokens": []}
                    else:
                        expo_service = {"service_status": True, "push_tokens": push_tokens}
                        self.logger.info(f"Expo service configured | tokens={len(push_tokens)}")
                except Exception as e:
                    self.logger.info(f"Expo service enabled but token read failed: {e}")
                    expo_service = {"service_status": False, "push_tokens": []}
                return subscription, expo_service

            elif self.expo_service_status == False:
                self.logger.info("Expo service disabled")
                return subscription, {"service_status": False, "push_tokens": []}

            else:
                self.logger.info("Expo service status is None — service unconfigured")
                return subscription, {"service_status": None, "push_tokens": []}

        except Exception as e:
            self.logger.info(f"Connection to Resource Collection failed: {e}")
            return None, None
