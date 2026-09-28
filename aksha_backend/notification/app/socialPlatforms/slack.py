"""
socialPlatforms/slack.py
========================
Slack notification sender for the Aksha V2.1 notification service.

Role
----
This module delivers camera-event notifications to one or more Slack channels
by uploading an annotated image together with a formatted caption.  It exposes
both a synchronous and an asynchronous interface so it can be called from
either threading-based or asyncio-based notification workers without blocking
the event loop.

Send helpers (low-level)
------------------------
``send_to_slack`` (sync)
    Uses ``slack_sdk.WebClient.files_upload`` to post a file to Slack.  The
    synchronous SDK blocks until the HTTP response is received.

``send_to_slack_async`` (async)
    Uses ``slack_sdk.web.async_client.AsyncWebClient.files_upload_v2`` to post
    a file without blocking the asyncio event loop.  ``files_upload_v2`` is
    the preferred upload method for the current Slack API; it handles large
    files via the multi-part upload flow automatically.

Dispatch functions (high-level)
---------------------------------
``slack`` (sync)
    Builds an HTML-formatted Slack message by loading a template file, fills
    in camera and alert details, then calls ``send_to_slack``.  Intended for
    use in CPU-bound / threaded worker contexts.

``slack_async`` (async)
    Builds a plain-text Slack comment string (no HTML template), then calls
    ``send_to_slack_async``.  Intended for use inside asyncio coroutines.

Template files (used by the sync path only)
-------------------------------------------
``templates/slack_alert_template.html``
    Template for "Alert" and "No Object Alert" notification types.
    Placeholder tokens: ``{{ camera }}``, ``{{ alert_details }}``,
    ``{{ image_path }}``.

``templates/slack_anomaly_template.html``
    Template for "AutoAlert" (AI-detected anomaly) notification type.
    Placeholder tokens: ``{{ camera }}``, ``{{ timestamp }}``,
    ``{{ frame_image_path }}``, ``{{ alert_image_path }}``.

Alert type behaviour
--------------------
"Alert" / "No Object Alert"
    A per-alert details loop iterates over the (alert, description,
    alert_notification_validity) parallel lists and appends an HTML snippet
    for each alert that has a truthy validity flag.

"AutoAlert"
    An anomaly description text is composed directly; two image paths are
    supplied (frame JPEG and autoalert overlay JPEG).
"""
import os
import time
import textwrap
from pathlib import Path
from slack_sdk import WebClient
from slack_sdk.web.async_client import AsyncWebClient
from slack_sdk.errors import SlackApiError

# -------------------- LOW-LEVEL SEND HELPERS --------------------

async def send_to_slack_async(image_file, channels, token, slack_comment, logger):
    """Upload an image file to Slack channel(s) asynchronously using files_upload_v2.

    This coroutine wraps the ``AsyncWebClient.files_upload_v2`` call and is
    the recommended upload path for asyncio-based notification workers because
    it does not block the event loop.

    Parameters
    ----------
    image_file : str
        Absolute (or working-directory-relative) path to the image file to
        upload.  Must be a readable JPEG or PNG.
    channels : str | list[str]
        A single Slack channel ID / name or a list of them.  The file is
        shared to every channel in the list in a single API call.
    token : str
        Slack Bot OAuth token (``xoxb-…``).  Must have the
        ``files:write`` scope.
    slack_comment : str
        Text that appears as the ``initial_comment`` alongside the uploaded
        file.  Supports Slack ``mrkdwn`` formatting (``*bold*``, ``_italic_``).
    logger : logging.Logger
        Standard Python logger used to record the upload result or any
        ``SlackApiError`` details.

    Returns
    -------
    str
        ``"Notification sent to Slack chat successfully!"`` on success, or
        ``"Got an error: <error_code>"`` if the Slack API returned an error.

    Notes
    -----
    - The ``assert response["file"]`` guard raises ``AssertionError`` if the
      API response does not contain the expected ``file`` key, which surfaces
      unexpected API contract changes.
    - ``SlackApiError`` is the only exception type explicitly caught; all other
      exceptions propagate to the caller.
    """
    # Stage: upload image file to Slack channel(s) with a comment caption
    logger.info(f"send_to_slack_async | channels={channels} | image_file={image_file}")
    try:
        client = AsyncWebClient(token=token)
        response = await client.files_upload_v2(channels=channels, file=image_file, initial_comment=slack_comment)
        assert response["file"]
        result = "Notification sent to Slack chat successfully!"
        logger.info(f"send_to_slack_async complete | result={result}")
    except SlackApiError as e:
        result = f"Got an error: {e.response['error']}"
        logger.info(f"send_to_slack_async SlackApiError: {result}")
    return result

def send_to_slack(image_file, channels, token, logger):
    """Upload an image file to Slack channel(s) synchronously using files_upload.

    This function is used by the synchronous ``slack()`` notification path and
    blocks the calling thread until the HTTP upload completes.

    Parameters
    ----------
    image_file : str
        Absolute (or working-directory-relative) path to the image file to
        upload.  Must be a readable JPEG or PNG.
    channels : str | list[str]
        A single Slack channel ID / name or a list of them.
    token : str
        Slack Bot OAuth token (``xoxb-…``).  Must have the
        ``files:write`` scope.
    logger : logging.Logger
        Standard Python logger.  Wall-clock and CPU time for the upload are
        logged at ``INFO`` level to enable latency monitoring.

    Returns
    -------
    str
        ``"Notification sent to Slack chat successfully!"`` on success, or
        ``"Got an error: <error_code>"`` on a Slack API error.

    Notes
    -----
    - ``files_upload`` is the legacy (v1) endpoint; ``files_upload_v2`` is
      preferred for new work but this path is kept for backward compatibility
      with the synchronous ``slack()`` dispatch function.
    - Both wall-clock time (``time.time()``) and CPU time
      (``time.process_time()``) are captured around the API call to help
      distinguish I/O-bound latency from compute-bound overhead.
    """
    # Stage: synchronous Slack file upload (used by non-async path)
    logger.info(f"send_to_slack | channels={channels} | image_file={image_file}")
    client = WebClient(token=token)
    try:
        st_slack_send = time.time()
        st_slack_send_cpu = time.process_time()
        response = client.files_upload(channels=channels, file=image_file)
        assert response["file"]
        result = "Notification sent to Slack chat successfully!"
        logger.info(msg=f"{result}")
        et_slack_send = time.time()
        et_slack_send_cpu = time.process_time()
        logger.info(msg=f"Slack send time (wall, cpu): {et_slack_send - st_slack_send}, {et_slack_send_cpu - st_slack_send_cpu}")
    except SlackApiError as e:
        result = f"Got an error: {e.response['error']}"
        logger.info(msg=f"send_to_slack SlackApiError: {result}")
    return result

# -------------------- SYNC SLACK NOTIFICATION --------------------

def slack(subscription: str, camera: str, Type: str, DataPath: str, Timestamp: str, logger, alert_notification_validity: list = None, alert: list = None, description: list = None, slack_service: dict = {"service_status": False, "channels": None, "bot_token": None}):
    """Build and send a Slack notification using an HTML template (synchronous).

    This function is the synchronous high-level Slack notification dispatcher.
    It selects the appropriate HTML template based on the notification type,
    substitutes camera/alert data into the template, and delegates the actual
    file upload to ``send_to_slack``.

    The HTML template paths are resolved relative to the process's current
    working directory (i.e. they are *not* absolute paths), so the service
    must be started from the ``app/`` directory or a directory that contains
    the ``templates/`` folder.

    Parameters
    ----------
    subscription : str
        Subscription / tenant identifier; used for logging context only.
    camera : str
        Human-readable camera name substituted into the template via
        ``{{ camera }}``.
    Type : str
        Notification category.  ``"Alert"`` and ``"No Object Alert"`` use
        ``slack_alert_template.html``; all other types (e.g. ``"AutoAlert"``)
        use ``slack_anomaly_template.html``.
    DataPath : str
        Base directory for this camera's stored images.  Image file paths are
        constructed as ``{DataPath}/alerts/{Timestamp}_alert.jpg`` (Alert) or
        ``{DataPath}/frame/{Timestamp}.jpg`` and
        ``{DataPath}/alerts/{Timestamp}_autoalert.jpg`` (AutoAlert).
    Timestamp : str
        ISO-style timestamp string used in the template body and to construct
        image file paths.
    logger : logging.Logger
        Standard Python logger.  Timings for template prep and the Slack API
        call are logged at ``INFO`` level.
    alert_notification_validity : list[bool], optional
        Parallel validity flags for the ``alert`` and ``description`` lists.
        Only alerts with a ``True`` flag are included in the message body.
    alert : list[str], optional
        List of alert names to include in the notification.
    description : list[str], optional
        Human-readable descriptions corresponding to each alert name.
    slack_service : dict, optional
        Service configuration dictionary with keys:
        - ``"service_status"`` (bool): ``True`` to send; ``False`` to skip.
        - ``"channels"`` (str | list): Target Slack channel(s).
        - ``"token"`` (str): Bot OAuth token.
        Default value disables the service (``service_status=False``).

    Returns
    -------
    None
        All outcomes are communicated via the ``logger``; exceptions are
        caught internally and logged rather than propagated.

    Notes
    -----
    - The image uploaded to Slack (``"notification_slack.jpg"``) is a
      pre-rendered file written to the working directory by an upstream step;
      this function does not create the file.
    - The ``slack_service`` dict uses ``"token"`` as the key even though the
      parameter signature documents ``"bot_token"``; callers must pass
      ``{"token": "xoxb-…"}`` for the key lookup on line
      ``token = slack_service['token']`` to succeed.
    """
    # Stage: build Slack message/image and send via Slack API (sync)
    logger.info(
        f"slack() | camera={camera} | Type={Type} | subscription={subscription} "
        f"| service_status={slack_service.get('service_status')}"
    )
    try:
        st_slack_prep = time.time()
        st_slack_prep_cpu = time.process_time()

        # Stage: template loading -------------------------------------------------
        # The two HTML templates live under templates/ relative to the working
        # directory.  Template content is read into memory; placeholder tokens
        # are substituted with actual values using simple string replacement.
        if Type == "Alert" or Type == "No Object Alert":
            alert_template_path = Path("templates/slack_alert_template.html")
            slack_html_template = alert_template_path.read_text()
            logger.info(f"slack() | loaded alert template | camera={camera}")

            # Stage: alert details loop -------------------------------------------
            # Iterate over the three parallel lists simultaneously.  A validity
            # flag of True means the corresponding alert actually fired for this
            # event and should be shown in the message body.  False entries are
            # silently skipped.
            Alert_Details = []
            for alert_name, alert_details, validity in zip(alert, description, alert_notification_validity):
                if validity:
                    Alert_Details.append(
                        f'<span style="line-height:30px;"><strong>Alert Name : </strong>{alert_name}</span><br>'
                        f'<span style="line-height:30px;"><strong>Alert description : </strong>{alert_details}</span><br>'
                        f'<span style="line-height:30px;"><strong>Incident Time : </strong>{Timestamp}</span><br>'
                    )

            # Stage: image path building ------------------------------------------
            # Construct the path to the alert image that will be embedded in the
            # rendered Slack HTML template.  Note: this path is placed inside the
            # rendered HTML but the actual file uploaded to Slack is
            # "notification_slack.jpg" (set by the upstream pipeline).
            slack_format = slack_html_template.replace("{{ camera }}", camera).replace("{{ alert_details }}", " ".join(Alert_Details)).replace("{{ image_path }}", f"{DataPath}/alerts/{Timestamp}_alert.jpg")

        else:
            # Stage: template loading (anomaly path) ------------------------------
            # AutoAlert events use the anomaly template which expects two image
            # paths: the raw frame and the AI-annotated overlay.
            anomaly_template_path = Path("templates/slack_anomaly_template.html")
            slack_html_template = anomaly_template_path.read_text()
            logger.info(f"slack() | loaded anomaly template | camera={camera}")

            # Stage: image path building (anomaly) --------------------------------
            # Frame image: camera snapshot at moment of anomaly.
            # Autoalert image: AI-annotated bounding-box overlay saved under alerts/.
            slack_format = slack_html_template.replace("{{ camera }}", camera).replace("{{ timestamp }}", Timestamp).replace("{{ frame_image_path }}", f"{DataPath}/frame/{Timestamp}.jpg").replace("{{ alert_image_path }}", f"{DataPath}/alerts/{Timestamp}_autoalert.jpg")

        # Stage: service-status guard --------------------------------------------
        # Skip the API call entirely when the Slack service is not configured
        # or is administratively disabled.  This prevents crashes when
        # slack_service is passed with default values (service_status=False).
        if slack_service["service_status"]:
            channels = slack_service['channels']
            token = slack_service['token']
            et_slack_prep = time.time()
            et_slack_prep_cpu = time.process_time()
            logger.info(msg=f"Slack prep time (wall, cpu): {et_slack_prep - st_slack_prep}, {et_slack_prep_cpu - st_slack_prep_cpu}")
            # Stage: API call timing ----------------------------------------------
            # Wrap the send call with wall-clock and CPU-time measurements so
            # Slack API latency can be monitored separately from template prep.
            st_slack_api = time.time()
            st_slack_api_cpu = time.process_time()
            logger.info(f"slack() | sending to channels={channels} | camera={camera}")
            slack_response = send_to_slack("notification_slack.jpg", channels, token, logger)
            et_slack_api = time.time()
            et_slack_api_cpu = time.process_time()
            logger.info(msg=f"Slack API time (wall, cpu): {et_slack_api - st_slack_api}, {et_slack_api_cpu - st_slack_api_cpu}")
            logger.info(msg="Slack notification sent!")
        else:
            logger.info(msg="Slack service not activated")
    except Exception as e:
        logger.info(msg=f"Error encountered while sending Slack alert to Camera: {camera}, with exception: {e}")

# -------------------- ASYNC SLACK NOTIFICATION --------------------

async def slack_async(subscription: str, camera: str, Type: str, DataPath: str, Timestamp: str, logger, alert_notification_validity: list = None, alert: list = None, description: list = None, slack_service: dict = {"service_status": False, "channels": None, "bot_token": None}):
    """Build and send a Slack notification using a plain-text comment (asynchronous).

    This coroutine is the async high-level Slack notification dispatcher.
    Unlike ``slack()``, it does **not** use HTML templates; instead it builds
    a ``mrkdwn``-formatted plain-text comment string and passes it as the
    ``initial_comment`` of the uploaded image.  This approach is simpler, does
    not require template files on disk, and works correctly with
    ``files_upload_v2``'s multi-part upload flow.

    Parameters
    ----------
    subscription : str
        Subscription / tenant identifier; used for logging context only.
    camera : str
        Human-readable camera name included in the Slack comment text.
    Type : str
        Notification category.  ``"Alert"`` and ``"No Object Alert"`` produce
        a structured ``mrkdwn`` comment with per-alert details.  All other
        types (e.g. ``"AutoAlert"``) produce a prose anomaly description.
    DataPath : str
        Base directory for this camera's stored images.  Image paths:
        - Alert:     ``{DataPath}/alerts/{Timestamp}_alert.jpg``
        - AutoAlert: ``{DataPath}/alerts/{Timestamp}_autoalert.jpg``
    Timestamp : str
        ISO-style timestamp string included in the comment and used to build
        image file paths.
    logger : logging.Logger
        Standard Python logger.  Timings for comment prep and the Slack API
        call are logged at ``INFO`` level.
    alert_notification_validity : list[bool], optional
        Parallel validity flags; a ``True`` entry means the corresponding
        alert fired and its details should be appended to the comment.
    alert : list[str], optional
        List of alert names.
    description : list[str], optional
        Human-readable descriptions for each alert.
    slack_service : dict, optional
        Service configuration dictionary with keys:
        - ``"service_status"`` (bool): ``True`` to send; ``False`` to skip.
        - ``"channels"`` (str | list): Target Slack channel(s).
        - ``"token"`` (str): Bot OAuth token.
        Default value disables the service (``service_status=False``).

    Returns
    -------
    None
        All outcomes are communicated via the ``logger``; exceptions are
        caught internally and logged rather than propagated.

    Notes
    -----
    - ``textwrap.dedent`` is used to strip the leading indentation from the
      multi-line comment string so the message renders cleanly in Slack.
    - The ``image_path`` for AutoAlert points to the ``_autoalert.jpg`` file
      (the AI-annotated overlay), not the raw frame, because the overlay is
      the most diagnostic image for a human reviewer.
    - Like ``slack()``, this function guards the API call behind
      ``slack_service["service_status"]`` so it is a no-op when Slack is not
      configured.
    """
    # Stage: build Slack comment text and send image asynchronously
    logger.info(
        f"slack_async() | camera={camera} | Type={Type} | subscription={subscription} "
        f"| service_status={slack_service.get('service_status')}"
    )
    try:
        st_slack_prep = time.time()
        st_slack_prep_cpu = time.process_time()

        # Stage: build comment text with alert details for the chosen type --------
        if Type == "Alert" or Type == "No Object Alert":
            # Note: textwrap.dedent removes the common leading whitespace from
            # the triple-quoted string so the Slack message has clean indentation.
            slack_comment = textwrap.dedent(f"""
                *Worker Safety Notification*
                *My Alert*
                *Camera:* {camera}
                *Incident Time:* {Timestamp}
            """)
            # Stage: alert details loop -------------------------------------------
            # Append per-alert detail lines for each alert that actually fired
            # (validity == True).  Inactive alerts are omitted so the message
            # stays concise.
            for alert_name, alert_details, validity in zip(alert, description, alert_notification_validity):
                if validity:
                    slack_comment += textwrap.dedent(f"""
                        *Alert Name:* {alert_name}
                        *Alert description:* {alert_details}
                    """)
            # Stage: image path building (alert) ----------------------------------
            # The alert JPEG is the annotated detection overlay produced by the
            # AI pipeline and stored under the per-camera alerts directory.
            image_path = f"{DataPath}/alerts/{Timestamp}_alert.jpg"
        else:
            # Stage: build comment text (AutoAlert) -------------------------------
            # AutoAlert uses a prose description rather than structured mrkdwn so
            # it reads naturally for anomaly-type events.
            slack_comment = f"""
                Worker Safety Notification
                AutoAlert
                Dear User, Aksha has come across this unusual situation for {camera} at the time {Timestamp}, please take a look at the Image.
            """
            # Stage: image path building (autoalert) ------------------------------
            # The autoalert JPEG is the bounding-box overlay JPEG; the raw frame
            # is not uploaded here to keep the Slack channel uncluttered.
            image_path = f"{DataPath}/alerts/{Timestamp}_autoalert.jpg"

        logger.info(f"slack_async() | image_path={image_path} | camera={camera}")

        # Stage: service-status guard --------------------------------------------
        # Honour the administrative enable/disable flag before making any
        # network call.  This mirrors the guard in the synchronous slack()
        # function and prevents unintended API calls during testing or when
        # Slack integration is not yet configured for a subscription.
        if slack_service["service_status"]:
            channels = slack_service['channels']
            token = slack_service['token']
            et_slack_prep = time.time()
            et_slack_prep_cpu = time.process_time()
            logger.info(msg=f"Slack prep time (wall, cpu): {et_slack_prep - st_slack_prep}, {et_slack_prep_cpu - st_slack_prep_cpu}")
            # Stage: API call timing ----------------------------------------------
            # Wall-clock and CPU-time bookends let operators distinguish Slack
            # network latency from local processing overhead in the logs.
            st_slack_api = time.time()
            st_slack_api_cpu = time.process_time()
            logger.info(f"slack_async() | sending to channels={channels} | camera={camera}")
            await send_to_slack_async(image_path, channels, token, slack_comment, logger)
            et_slack_api = time.time()
            et_slack_api_cpu = time.process_time()
            logger.info(msg=f"Slack API time (wall, cpu): {et_slack_api - st_slack_api}, {et_slack_api_cpu - st_slack_api_cpu}")
            logger.info(msg="Slack notification sent!")
        else:
            logger.info(msg="Slack service not activated")
    except Exception as e:
        logger.info(msg=f"Error encountered while sending Slack alert to Camera: {camera}, with exception: {e}")
