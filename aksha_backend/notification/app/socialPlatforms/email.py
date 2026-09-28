"""
socialPlatforms/email.py
========================
Async Gmail API email sender for the Aksha V2.1 notification service.

Role
----
This module provides a single public coroutine, ``email_gmail``, which
constructs a fully-formed MIME email (HTML body + inline image attachments)
and delivers it through the Gmail REST API using the ``aiogoogle`` async
HTTP client together with Gmail OAuth 2.0 credentials.

Supported notification types (``Type`` parameter)
--------------------------------------------------
- "Alert" / "No Object Alert"
    Uses ``templates/alert_template.html`` as the HTML body.
    Attaches the per-event alert JPEG as inline image ``<image5>``.
- "AutoAlert"
    Uses ``templates/autoalert_email_template.html`` as the HTML body.
    Attaches the raw frame JPEG as inline ``<image3>`` and the autoalert
    overlay JPEG as inline ``<image4>``.
- "RTSP working"
    Uses ``templates/camera_working.html``; no extra image attachment.
- "RTSP Error"
    Uses ``templates/connection_error.html``; no extra image attachment.
    For all RTSP notifications ``aksha@algoanalytics.com`` is
    automatically added to the recipient list.

Gmail threading
---------------
All notifications for the *same camera* are delivered as replies to a
single Gmail thread so that the recipient's inbox shows one collapsible
conversation per camera rather than hundreds of separate messages.

Thread ID resolution order:
  1. ``namespace.threadId``  (multiprocessing-safe shared namespace)
  2. ``main_dir/app.config`` [Client_data] → threadId  (persistent INI file)

After each successful send the new ``threadId`` returned by Gmail is written
back to *both* storage locations so the chain is maintained across process
restarts.

Inline image Content-ID convention
-----------------------------------
``<image1>`` → ``app/logo.png``         (Aksha primary logo)
``<image2>`` → ``app/logo2.png``        (secondary / partner logo)
``<image3>`` → frame JPEG              (AutoAlert only)
``<image4>`` → autoalert overlay JPEG  (AutoAlert only)
``<image5>`` → alert JPEG              (Alert / No Object Alert only)

OAuth credential file – keys.yaml
----------------------------------
``keys.yaml`` must exist in the same directory as this file
(``socialPlatforms/keys.yaml``).  It is downloaded from Azure Blob Storage
at service startup and contains:

    user_creds:
        access_token:  <str>
        refresh_token: <str>
        expires_at:    <str | null>
    client_creds:
        client_id:     <str>
        client_secret: <str>
        scopes:        <list[str]>

``aiogoogle`` automatically refreshes the access token when it has expired,
provided the refresh token is still valid.
"""
# socialPlatforms/email.py
import os
import sys
import time
import yaml
import base64
import configparser
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from aiogoogle import Aiogoogle
from aiogoogle.auth.creds import UserCreds, ClientCreds

def resource_path(relative_path):
    """Return an absolute filesystem path that works in both dev and PyInstaller modes.

    When a Python application is frozen with PyInstaller the runtime unpacks
    bundled files into a temporary directory whose path is stored in
    ``sys._MEIPASS``.  Regular (non-frozen) execution has no such attribute,
    so the function falls back to the process's current working directory.

    Parameters
    ----------
    relative_path : str
        A path fragment relative to either the PyInstaller extraction root
        (frozen) or the current working directory (dev).

    Returns
    -------
    str
        Absolute path that can be passed directly to ``open()`` or
        ``os.path.exists()``.

    Notes
    -----
    ``sys._MEIPASS`` is set by the PyInstaller bootloader and does **not**
    exist in a normal Python interpreter session; the ``AttributeError``
    (caught generically via ``Exception``) is the standard way to detect
    the execution context.
    """
    try:
        # Note: sys._MEIPASS is only defined inside a PyInstaller-frozen binary;
        # its presence means we are running from a bundled executable.
        base_path = sys._MEIPASS
    except Exception:
        # Note: Fallback for development / plain-Python execution — resolve
        # relative to wherever the process was launched from.
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

def get_template_path(template_name):
    """Resolve the absolute path of an HTML email template inside ``app/templates/``.

    The directory layout assumed by this function is::

        app/
        ├── socialPlatforms/
        │   └── email.py          ← __file__
        └── templates/
            └── <template_name>   ← resolved here

    The function walks *up* one level from the ``socialPlatforms/`` package
    directory to reach the ``app/`` root, then descends into ``templates/``.

    Parameters
    ----------
    template_name : str
        Bare filename of the template, e.g. ``"alert_template.html"``.

    Returns
    -------
    str
        Absolute path to the template file.

    Raises
    ------
    FileNotFoundError
        If the resolved path does not exist on disk.  This prevents silent
        failures where a missing template would render an empty email body.
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)  # app directory
    template_path = os.path.join(parent_dir, "templates", template_name)

    if os.path.exists(template_path):
        return template_path

    raise FileNotFoundError(f"Template not found: {template_name}")

async def email_gmail(subscription: str, recipients: list, sender_email: str, camera: str, Type: str, DataPath: str,
                     Timestamp: str, RTSP_Link: str, RTSP_bool: bool, logger,
                     alert_notification_validity: list = None, alert: list = None,
                     description: list = None, namespace=None, main_dir=None):
    """Send an HTML notification email via the Gmail REST API using OAuth 2.0.

    This coroutine is the primary entry-point for all email notifications
    produced by the Aksha notification service.  It handles credential loading,
    MIME message assembly, per-type HTML template selection, inline image
    attachment, Gmail threading, message dispatch, and thread-ID persistence.

    Parameters
    ----------
    subscription : str
        Subscription / tenant identifier (used for log correlation only;
        not embedded in the email body).
    recipients : list[str]
        List of recipient email addresses.  For RTSP-type notifications
        ``aksha@algoanalytics.com`` is appended automatically if not already
        present.
    sender_email : str
        The Gmail address that appears in the ``From:`` header.  Must match
        the OAuth credentials stored in ``keys.yaml``.
    camera : str
        Human-readable camera name injected into the email body template.
    Type : str
        Notification category.  Accepted values:
        ``"Alert"``, ``"No Object Alert"``, ``"AutoAlert"``,
        ``"RTSP working"``, ``"RTSP Error"``.
    DataPath : str
        Root directory under which per-camera alert and frame images are
        stored.  Image paths are constructed as
        ``{DataPath}/{camera}/alerts/{date}/{Timestamp}_alert.jpg`` etc.
    Timestamp : str
        ISO-style timestamp string (``"YYYY-MM-DD HH:MM:SS"``).  Used in
        the email body and to derive ``date_part = Timestamp.split(' ')[0]``
        for image path construction.
    RTSP_Link : str
        The RTSP URL of the camera stream.  Injected into the RTSP email
        templates; ``None`` falls back to the string ``"Not specified"``.
    RTSP_bool : bool
        ``True`` → camera stream is working (use ``camera_working.html``).
        ``False`` → camera stream has failed (use ``connection_error.html``).
    logger : logging.Logger
        Standard Python logger; all significant steps are logged at
        ``INFO`` level; errors at ``ERROR``; non-fatal issues at ``WARNING``.
    alert_notification_validity : list[bool], optional
        Parallel list to ``alert`` / ``description``; a ``True`` entry means
        the corresponding alert is active and should be included in the email
        body.
    alert : list[str], optional
        List of alert names (e.g. ``["No Helmet", "No Vest"]``).
    description : list[str], optional
        List of human-readable descriptions corresponding to each alert name.
    namespace : multiprocessing.Namespace, optional
        A shared-memory namespace object that carries ``threadId`` across
        worker processes.  If present, the persisted thread ID is read from
        (and written back to) ``namespace.threadId`` so that all workers
        sending for the same camera participate in the same Gmail thread.
    main_dir : str, optional
        Absolute path to the per-camera working directory that contains
        ``app.config``.  Used as a secondary / persistent store for
        ``threadId`` so the thread chain survives process restarts.

    Returns
    -------
    str | None
        The Gmail ``threadId`` returned by the API after a successful send,
        or ``None`` if an unrecoverable error occurred.

    Thread-ID resolution
    --------------------
    1. If ``namespace`` exists and ``namespace.threadId`` is set, use it.
    2. Otherwise read ``main_dir/app.config`` → ``[Client_data]`` → ``threadId``.
    3. After a successful send, write the new ``threadId`` back to both
       ``namespace.threadId`` and ``app.config`` so the next invocation
       can continue the thread.

    MIME structure
    --------------
    ::

        MIMEMultipart('related')          ← msgRoot
        ├── MIMEMultipart('alternative')  ← msgAlternative
        │   ├── MIMEText('plain')         ← plain-text fallback
        │   └── MIMEText('html')          ← rendered HTML body
        ├── MIMEImage  (image1 – logo.png)
        ├── MIMEImage  (image2 – logo2.png)
        └── MIMEImage  (image3/4/5 – alert/frame/autoalert, type-dependent)

    Notes
    -----
    - ``aiogoogle`` handles OAuth token refresh transparently when
      ``expires_at`` has passed and a valid ``refresh_token`` is supplied.
    - All image attachments use ``Content-ID`` headers so HTML templates can
      reference them via ``<img src="cid:imageN">``.
    - Fallback inline HTML is generated if a template file is missing; this
      guarantees an email is always sent even when template files are absent.
    """
    try:
        logger.info(f"email gmail function started for camera: {camera}, Type: {Type}")
        logger.info(f"DataPath: {DataPath}, main_dir: {main_dir}")
        st_email = time.time()

        # Stage: keys.yaml loading ------------------------------------------------
        # Locate keys.yaml in the same directory as this source file.
        # The file is downloaded from Azure Blob at service startup; if it is
        # missing the function raises immediately rather than failing silently
        # later during credential construction.
        config_path = os.path.join(os.path.dirname(__file__), "keys.yaml")
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Could not find keys.yaml at {config_path}")

        with open(config_path, "r") as stream:
            # Note: FullLoader is the safe default for trusted YAML files;
            # it prevents arbitrary object deserialization.
            config = yaml.load(stream, Loader=yaml.FullLoader)
            logger.info(f"Loaded config from: {config_path}")

        # Stage: thread ID resolution (namespace → app.config) --------------------
        # Gmail conversation threading is maintained by passing the same
        # threadId on every subsequent message for the same camera.  We check
        # the fast in-memory namespace first; if absent, fall back to the
        # persistent INI file so restarts don't break the thread chain.
        thread_id = None
        if namespace and hasattr(namespace, 'threadId'):
            # Note: namespace.threadId is shared across all worker processes
            # via a multiprocessing.Manager().Namespace() object; reading it
            # here is safe because Manager proxies serialise access.
            thread_id = namespace.threadId
            logger.info(f"Using threadId from namespace: {thread_id}")

        if not thread_id and main_dir:
            # Note: Fall back to app.config only when the namespace did not
            # carry a valid thread ID (e.g. first run after a process restart).
            try:
                config_path = f"{main_dir}/app.config"
                if os.path.exists(config_path):
                    app_config = configparser.RawConfigParser()
                    app_config.read(config_path)
                    thread_id = app_config.get('Client_data', 'threadId', fallback=None)
                    logger.info(f"Using threadId from config: {thread_id}")
            except Exception as e:
                logger.error(f"Error reading threadId from config: {e}")

        # Stage: UserCreds / ClientCreds construction -----------------------------
        # aiogoogle requires two credential objects:
        #   UserCreds  – the OAuth 2.0 *user* token (access + refresh)
        #   ClientCreds – the OAuth 2.0 *application* credentials (client ID/secret)
        # Both are sourced from keys.yaml populated at deployment time.
        user_creds = UserCreds(
            access_token=config["user_creds"]["access_token"],
            refresh_token=config["user_creds"]["refresh_token"],
            # Note: expires_at may be None in keys.yaml when the token was
            # issued without an explicit expiry; aiogoogle accepts None here.
            expires_at=config["user_creds"]["expires_at"] or None,
        )
        client_creds = ClientCreds(
            client_id=config["client_creds"]["client_id"],
            client_secret=config["client_creds"]["client_secret"],
            # Note: scopes must include https://www.googleapis.com/auth/gmail.send
            # and https://www.googleapis.com/auth/gmail.readonly for thread fetching.
            scopes=config["client_creds"]["scopes"],
        )

        logger.info("Credentials loaded successfully")

        # Stage: Gmail API discovery ----------------------------------------------
        # aiogoogle's async context manager refreshes the access token if needed
        # and manages the underlying aiohttp session lifecycle.
        async with Aiogoogle(user_creds=user_creds, client_creds=client_creds) as google:
            # Note: discover() fetches and caches the Gmail discovery document
            # (https://gmail.googleapis.com/$discovery/rest?version=v1) so that
            # all subsequent API calls are typed and validated client-side.
            gmail = await google.discover("gmail", "v1")
            logger.info("Gmail API discovered")

            sender = sender_email
            subject = f'Aksha V2.1 CCTV Notification'

            # Stage: MIME root / alternative construction -------------------------
            # The 'related' content-type allows inline image references (cid:imageN)
            # inside the HTML part.  The nested 'alternative' part allows mail
            # clients to fall back to plain text when they cannot render HTML.
            msgRoot = MIMEMultipart('related')
            msgRoot['Subject'] = subject
            msgRoot['From'] = sender

            # Note: RTSP notifications are operational/infra alerts that the
            # Aksha team always needs to see, so the internal address is added
            # automatically regardless of the subscription's recipient list.
            if Type in ["RTSP working", "RTSP Error"]:
                if "aksha@algoanalytics.com" not in recipients:
                    recipients.append("aksha@algoanalytics.com")

            msgRoot['To'] = ", ".join(recipients)
            msgRoot.preamble = 'This is a multi-part message in MIME format.'

            # Stage: threading headers fetch --------------------------------------
            # To chain this message into an existing Gmail thread we must supply
            # the RFC-2822 In-Reply-To and References headers copied from the
            # most-recent message in that thread.  If the thread no longer exists
            # or the fetch fails, we send without threading headers (starts a
            # new thread) and the new threadId will become the chain anchor.
            if thread_id:
                try:
                    # Note: Retrieve the full thread object so we can identify
                    # the ID of the last message in the conversation.
                    thread = await google.as_user(
                        gmail.users.threads.get(userId="me", id=thread_id)
                    )

                    if thread and 'messages' in thread and len(thread['messages']) > 0:
                        last_message_id = thread['messages'][-1]['id']
                        # Note: We need the full message payload to extract its
                        # Message-Id and References headers for RFC-2822 threading.
                        last_message = await google.as_user(
                            gmail.users.messages.get(userId="me", id=last_message_id)
                        )

                        # Extract headers
                        headers = {}
                        if 'payload' in last_message and 'headers' in last_message['payload']:
                            for header in last_message['payload']['headers']:
                                if 'name' in header and 'value' in header:
                                    headers[header['name']] = header['value']

                        # Note: In-Reply-To must be the Message-Id of the message
                        # we are replying to; References accumulates the full chain.
                        in_reply_to = headers.get('Message-Id')
                        references = headers.get('References', in_reply_to)

                        if in_reply_to:
                            msgRoot['In-Reply-To'] = in_reply_to
                        if references:
                            msgRoot['References'] = references

                        logger.info(f"Added threading headers for thread: {thread_id}")
                    else:
                        logger.warning(f"No messages found in thread {thread_id}")
                except Exception as e:
                    # Note: Non-fatal — if the thread has been deleted or is
                    # inaccessible we simply start a new thread for this camera.
                    logger.warning(f"Could not fetch thread {thread_id}: {e}")

            # Create alternative part for HTML/plain text
            msgAlternative = MIMEMultipart('alternative')
            msgRoot.attach(msgAlternative)

            # Add plain text fallback
            plain_text = f'Aksha V2.1 CCTV Notification\nCamera: {camera}\nTime: {Timestamp}\nAlert Type: {Type}'
            msgText = MIMEText(plain_text, 'plain')
            msgAlternative.attach(msgText)

            # Get current directory for logo files
            current_dir = os.path.dirname(os.path.abspath(__file__))
            parent_dir = os.path.dirname(current_dir)  # app directory

            # Stage: logo attachment ----------------------------------------------
            # Both logos are embedded as inline attachments so the HTML template
            # can reference them via <img src="cid:image1"> and <img src="cid:image2">
            # without any external HTTP request.  Failures are non-fatal; the
            # email is still sent with broken image placeholders rather than not
            # sent at all.
            try:
                # Note: logo.png is the primary Aksha brand logo placed at the
                # top-left of every notification email.
                logo1_path = os.path.join(parent_dir, "logo.png")
                if os.path.exists(logo1_path):
                    with open(logo1_path, 'rb') as fp:
                        msgImage1 = MIMEImage(fp.read())
                        msgImage1.add_header('Content-ID', '<image1>')
                        msgRoot.attach(msgImage1)
                    logger.info(f"Attached logo1 from: {logo1_path}")
                else:
                    logger.warning(f"Logo1 not found at: {logo1_path}")
            except Exception as e:
                logger.error(f"Error attaching logo1: {e}")

            try:
                # Note: logo2.png is the secondary / partner logo placed at the
                # top-right of every notification email.
                logo2_path = os.path.join(parent_dir, "logo2.png")
                if os.path.exists(logo2_path):
                    with open(logo2_path, 'rb') as fp:
                        msgImage2 = MIMEImage(fp.read())
                        msgImage2.add_header('Content-ID', '<image2>')
                        msgRoot.attach(msgImage2)
                    logger.info(f"Attached logo2 from: {logo2_path}")
                else:
                    logger.warning(f"Logo2 not found at: {logo2_path}")
            except Exception as e:
                logger.error(f"Error attaching logo2: {e}")

            # Stage: template selection branch ------------------------------------
            # The Email_Format string will hold the rendered HTML body.  It is
            # populated by one of three branches depending on Type, then attached
            # as MIMEText('html') after all image attachments have been added.
            Email_Format = ""

            # Stage: Alert / No Object Alert branch ------------------------------
            # Loads alert_template.html, substitutes {{camera}} and
            # {{alert_details}}, then attaches the per-event alert JPEG as <image5>.
            if Type in ["Alert", "No Object Alert", "PPE Alert"]:
                try:
                    alert_template_path = get_template_path("alert_template.html")
                    alert_html_template = Path(alert_template_path).read_text()

                    # Stage: alert detail building --------------------------------
                    # Each (alert_name, description, validity) triple contributes
                    # one HTML snippet only when the validity flag is True.  This
                    # allows the caller to pass all configured alerts while marking
                    # only the ones that actually fired for this event.
                    Alert_Details = []
                    if alert and description and alert_notification_validity:
                        for alert_name, alert_details, validity in zip(alert, description, alert_notification_validity):
                            if validity:
                                Alert_Details.append(
                                    f'<span style="line-height:30px;"><strong>Alert Name : </strong>{alert_name}</span><br>'
                                    f'<span style="line-height:30px;"><strong>Alert description : </strong>{alert_details}</span><br>'
                                    f'<span style="line-height:30px;"><strong>Incident Time : </strong>{Timestamp}</span><br>'
                                )

                    Email_Format = alert_html_template.replace("{{camera}}", camera)
                    if Alert_Details:
                        Email_Format = Email_Format.replace("{{alert_details}}", " ".join(Alert_Details))
                    else:
                        Email_Format = Email_Format.replace("{{alert_details}}", "")

                    # Stage: image path construction and attachment (alert image) -
                    # Alert images are saved by the detection pipeline at:
                    #   {DataPath}/{camera}/alerts/{date}/{Timestamp}_alert.jpg
                    # The date_part is extracted from the Timestamp string so that
                    # daily sub-directories are automatically navigated.
                    try:
                        # Format: main directory / camera / alerts folder available / date / images
                        date_part = Timestamp.split(' ')[0]
                        alert_image_path = f"{DataPath}/{camera}/alerts/{date_part}/{Timestamp}_alert.jpg"
                        logger.info(f"Looking for alert image at: {alert_image_path}")

                        if os.path.exists(alert_image_path):
                            with open(alert_image_path, 'rb') as fp:
                                # Note: Content-ID <image5> matches the src="cid:image5"
                                # reference inside alert_template.html.
                                msgImage5 = MIMEImage(fp.read())
                                msgImage5.add_header('Content-ID', '<image5>')
                                msgRoot.attach(msgImage5)
                            logger.info(f"Attached alert image: {alert_image_path}")
                        else:
                            logger.warning(f"No alert image found at: {alert_image_path}")

                    except Exception as e:
                        logger.error(f"Error attaching alert image: {e}")

                except Exception as e:
                    logger.error(f"Error loading alert template: {e}")
                    # Fallback HTML matching original format
                    Email_Format = f"""<!DOCTYPE html>
                    <html lang="en">
                    <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>My alert email</title>
                    </head>
                    <body style="margin:0;padding:0;">
                        <div style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
                            <div style="max-width:535px;margin:0 auto;padding:38px;background:#fff; box-shadow: 26px 56px 43px #ddd;border-radius: 10px;">
                            <table>
                                <tr>
                                <td>
                                    <img src="cid:image1" style="max-width:127px;position:relative;left:-7px;" alt="">
                                </td>
                                <td style="width:300px;"></td>
                                <td> <img src="cid:image2" style="max-width:127px;" alt=""></td>
                                </tr>
                            </table>
                            <p style="font-size:18px;padding-top:10px;">
                                Dear Aksha User, <br><br>
                                This is a user-defined alert, please check the alert details. <br><br>
                                <p style="margin-bottom: 9px;">My Alert</p>

                                <span style="line-height:30px;"><strong>Camera :</strong> {camera}</span><br>
                                {" ".join(Alert_Details) if Alert_Details else ""}
                                <span style="line-height:30px;"><strong>Camera Images : </strong></span><br>
                                <table>
                                <tr>
                                    <td>
                                        <img src="cid:image5" alt="my alert" style="max-width:250px;">
                                    </td>
                                </tr>
                                </table>
                            </p>
                            </div>
                        </div>
                    </body>
                    </html>
                    """

            # Stage: AutoAlert branch --------------------------------------------
            # Loads autoalert_email_template.html, substitutes {{camera}} and
            # {{Timestamp}}, then attaches two images:
            #   <image3> – the raw camera frame at the moment of the anomaly
            #   <image4> – the autoalert overlay JPEG produced by the AI model
            elif Type == "AutoAlert":
                try:
                    autoalert_template_path = get_template_path("autoalert_email_template.html")
                    autoalert_html_template = Path(autoalert_template_path).read_text()

                    Email_Format = autoalert_html_template.replace("{{camera}}", camera)
                    Email_Format = Email_Format.replace("{{Timestamp}}", Timestamp)

                    date_part = Timestamp.split(' ')[0]

                    # Stage: image path construction and attachment (frame image) -
                    # The frame image is the undecorated camera snapshot saved
                    # under {DataPath}/{camera}/frame/{date}/{Timestamp}.jpg
                    try:
                        frame_image_path = f"{DataPath}/{camera}/frame/{date_part}/{Timestamp}.jpg"
                        logger.info(f"Looking for frame image at: {frame_image_path}")

                        if os.path.exists(frame_image_path):
                            with open(frame_image_path, 'rb') as fp:
                                # Note: <image3> maps to the frame photo in the
                                # autoalert template's first <img src="cid:image3">.
                                msgImage3 = MIMEImage(fp.read())
                                msgImage3.add_header('Content-ID', '<image3>')
                                msgRoot.attach(msgImage3)
                            logger.info(f"Attached frame image: {frame_image_path}")
                        else:
                            logger.warning(f"No frame image found at: {frame_image_path}")
                    except Exception as e:
                        logger.error(f"Error attaching frame image: {e}")

                    # Stage: image path construction and attachment (autoalert image)
                    # The autoalert image is the AI-annotated overlay saved under
                    # {DataPath}/{camera}/alerts/{date}/{Timestamp}_autoalert.jpg
                    try:
                        autoalert_image_path = f"{DataPath}/{camera}/alerts/{date_part}/{Timestamp}_autoalert.jpg"
                        logger.info(f"Looking for autoalert image at: {autoalert_image_path}")

                        if os.path.exists(autoalert_image_path):
                            with open(autoalert_image_path, 'rb') as fp:
                                # Note: <image4> maps to the annotated alert overlay
                                # in the autoalert template's second <img src="cid:image4">.
                                msgImage4 = MIMEImage(fp.read())
                                msgImage4.add_header('Content-ID', '<image4>')
                                msgRoot.attach(msgImage4)
                            logger.info(f"Attached autoalert image: {autoalert_image_path}")
                        else:
                            logger.warning(f"No autoalert image found at: {autoalert_image_path}")
                    except Exception as e:
                        logger.error(f"Error attaching autoalert image: {e}")

                except Exception as e:
                    logger.error(f"Error loading autoalert template: {e}")
                    # Fallback HTML matching original format
                    Email_Format = f"""<!DOCTYPE html>
                    <html lang="en">
                    <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Anomaly email Template</title>
                    </head>
                    <body style="margin:0;padding:0;">
                        <div style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
                            <div style="max-width:535px;margin:0 auto;padding:38px;background:#fff; box-shadow: 26px 56px 43px #ddd;border-radius: 10px;">
                            <table>
                                <tr>
                                <td>
                                    <img src="cid:image1" style="max-width:127px;position:relative;left:-7px;" alt="">
                                </td>
                                <td style="width:300px;"></td>
                                <td> <img src="cid:image2" style="max-width:127px;" alt=""></td>
                                </tr>
                            </table>
                            <p style="font-size:18px;padding-top:10px;">
                                Dear Aksha User, <br><br>
                                Aksha has come across this unusual situation for {camera} at time {Timestamp}, please check the Image <br><br>
                            </p>
                            <p>
                                <span style="line-height:30px;"><strong>Camera Images : </strong></span><br>
                            </p>
                            <table>
                                <tr>
                                    <td>
                                        <img src="cid:image3" alt="my alert" style="max-width:100%;">
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <img src="cid:image4" alt="my alert" style="max-width:250px;">
                                    </td>
                                </tr>
                            </table>
                            </div>
                        </div>
                    </body>
                    </html>
                    """

            # Stage: RTSP working / RTSP Error branch ----------------------------
            # No per-event images are attached for RTSP notifications.  Template
            # selection is determined by the RTSP_bool flag:
            #   True  → camera_working.html  (stream recovered)
            #   False → connection_error.html (stream lost)
            else:  # RTSP notifications
                try:
                    if RTSP_bool:
                        rtsp_template_path = get_template_path("camera_working.html")
                    else:
                        rtsp_template_path = get_template_path("connection_error.html")

                    rtsp_html_template = Path(rtsp_template_path).read_text()

                    Email_Format = rtsp_html_template.replace("{{camera}}", camera)
                    Email_Format = Email_Format.replace("{{Timestamp}}", Timestamp)
                    # Note: RTSP_Link may be None if not configured; replace with
                    # a readable placeholder rather than rendering "None" in email.
                    Email_Format = Email_Format.replace("{{RTSP_Link}}", RTSP_Link or "Not specified")

                except Exception as e:
                    logger.error(f"Error loading RTSP template: {e}")
                    status_msg = "back in service" if RTSP_bool else "facing connection error"
                    # Fallback HTML matching original format
                    if RTSP_bool:
                        Email_Format = f"""<!DOCTYPE html>
                        <html lang="en">
                        <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>My alert email</title>
                        </head>
                        <body style="margin:0;padding:0;">
                            <div style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
                                <div style="max-width:535px;margin:0 auto;padding:38px;background:#fff; box-shadow: 26px 56px 43px #ddd;border-radius: 10px;">
                                <table>
                                    <tr>
                                    <td>
                                        <img src="cid:image1" style="max-width:127px;position:relative;left:-7px;" alt="">
                                    </td>
                                    <td style="width:300px;"></td>
                                    <td> <img src="cid:image2" style="max-width:127px;" alt=""></td>
                                    </tr>
                                </table>
                                <p style="font-size:18px;padding-top:10px;">
                                    Dear Aksha User, <br><br>
                                    <span style="line-height:30px;"><strong>Camera :</strong> {camera}</span><br>
                                    RTSP link : '{RTSP_Link or "Not specified"}'<br> is back in service. <br>
                                    CCTV is now under AI Surveillance! <br><br>
                                </p>
                                </div>
                            </div>
                        </body>
                        </html>
                        """
                    else:
                        Email_Format = f"""<!DOCTYPE html>
                        <html lang="en">
                        <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>My alert email</title>
                        </head>
                        <body style="margin:0;padding:0;">
                            <div style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
                                <div style="max-width:535px;margin:0 auto;padding:38px;background:#fff; box-shadow: 26px 56px 43px #ddd;border-radius: 10px;">
                                <table>
                                    <tr>
                                    <td>
                                        <img src="cid:image1" style="max-width:127px;position:relative;left:-7px;" alt="">
                                    </td>
                                    <td style="width:300px;"></td>
                                    <td> <img src="cid:image2" style="max-width:127px;" alt=""></td>
                                    </tr>
                                </table>
                                <p style="font-size:18px;padding-top:10px;">
                                    Dear Aksha User, <br><br>
                                    <span style="line-height:30px;"><strong>Camera :</strong> {camera}</span><br>
                                    RTSP link : '{RTSP_Link or "Not specified"}'<br> Facing connection error. <br>
                                    Please check RTSP links, make sure it is working! <br><br>
                                </p>
                                </div>
                            </div>
                        </body>
                        </html>
                        """

            # Attach HTML content
            msgText = MIMEText(Email_Format, 'html')
            msgAlternative.attach(msgText)

            # Stage: base64 encode + send -----------------------------------------
            # The Gmail REST API requires the entire RFC-2822 message to be
            # serialised to bytes then base64url-encoded (not standard base64)
            # before being placed in the 'raw' field of the request body.
            raw_message = base64.urlsafe_b64encode(msgRoot.as_bytes()).decode()

            # Prepare request
            request_body = {'raw': raw_message}

            # Note: If a threadId is supplied the new message is appended to the
            # existing thread; otherwise Gmail creates a new thread and returns
            # a fresh threadId that will be persisted below.
            if thread_id:
                request_body['threadId'] = thread_id
                logger.info(f"Sending email with threadId: {thread_id}")

            # Send email
            response = await google.as_user(
                gmail.users.messages.send(userId="me", json=request_body)
            )

            # Get new thread ID
            new_thread_id = response.get('threadId')
            logger.info(f"Email sent successfully. Thread ID: {new_thread_id}")

            # Stage: thread ID persistence to namespace and app.config -----------
            # Persist the threadId returned by Gmail so future notifications for
            # this camera are threaded into the same conversation.  Two stores
            # are updated:
            #   1. namespace.threadId  – fast, in-memory, shared across workers
            #   2. app.config          – durable, survives process/service restart

            # Update namespace
            if namespace and hasattr(namespace, 'threadId'):
                namespace.threadId = new_thread_id
                logger.info(f"Updated namespace.threadId to: {new_thread_id}")

            # Update config if main_dir provided
            if main_dir and new_thread_id:
                try:
                    config_path = f"{main_dir}/app.config"
                    app_config = configparser.RawConfigParser()
                    # Note: Read existing config first to preserve all other
                    # sections/keys that are unrelated to threading.
                    if os.path.exists(config_path):
                        app_config.read(config_path)
                    if not app_config.has_section('Client_data'):
                        app_config.add_section('Client_data')
                    app_config.set('Client_data', 'threadId', str(new_thread_id))
                    with open(config_path, 'w') as configfile:
                        app_config.write(configfile)
                    logger.info(f"Updated threadId in app.config: {new_thread_id}")
                except Exception as e:
                    logger.error(f"Error writing threadId to config: {e}")

        et_email = time.time()
        logger.info(f"Email notification sent in {et_email - st_email:.2f} seconds")
        return new_thread_id

    except Exception as e:
        logger.error(f"Error sending email: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        return None
