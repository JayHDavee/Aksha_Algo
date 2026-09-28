"""
whatsapp_message.py — WhatsApp Business API Notification Sender
===============================================================

Role
----
This module sends Aksha V2.1 alert and anomaly notifications to end-users via
the WhatsApp Business API (Meta Graph API).  Because the WhatsApp Business API
requires a **public URL** to an image rather than a direct file upload, the
module uses a multi-step pipeline to convert in-memory notification data into a
deliverable message.

Pipeline
--------
1. **Template selection** — choose the appropriate Jinja-style HTML template
   file based on the notification type:
   - ``whatsapp_alert_template.html`` for ``"Alert"`` and ``"No Object Alert"``
   - ``whatsapp_anomaly_template.html`` for ``"AutoAlert"`` and other types

2. **HTML rendering** — substitute camera name, alert details, and timestamp
   into the template's placeholder tokens (``{{ camera }}``,
   ``{{ alert_details }}``, ``{{ timestamp }}``), then write the result to a
   temporary HTML file on disk (``notification_whatsapp.html``).

3. **Image generation** — call ``imgkit.from_file()`` to invoke ``wkhtmltoimage``
   and render the HTML file to a JPEG (``notification_whatsapp.jpg``).
   ``imgkit`` is imported inline inside the function to defer the dependency
   until it is actually needed.

4. **Google Drive upload** — call ``get_download_url(folder_id, image_path)``
   (from the shared ``utils`` module) to upload the JPEG to a designated Google
   Drive folder and obtain a direct, publicly accessible download URL.

   *Why Google Drive?*  The WhatsApp Business API's ``image.link`` field must
   be a URL reachable by Meta's servers at send time.  Local filesystem paths
   and private network addresses are not accessible from the internet.  Google
   Drive provides a convenient authenticated-upload / public-download mechanism
   that satisfies this constraint without requiring a separately managed CDN or
   object-storage bucket.

5. **WhatsApp API call** — pass the Drive download URL to
   ``send_to_whatsapp(link, phone_number)``, which POSTs a JSON payload to the
   Meta Graph API ``/messages`` endpoint, instructing WhatsApp to deliver the
   image (with a static "Aksha Alert" caption) to the recipient's phone.

API Endpoint Note
-----------------
``send_to_whatsapp`` targets the **v13.0** Graph API endpoint:
``https://graph.facebook.com/v13.0/107494948909422/messages``

The phone number ID (``107494948909422``) and the ``Authorization`` Bearer
token embedded in the headers are **development/test credentials**.  They
should be replaced with production credentials via environment variables or a
secrets manager before any production deployment.  Hardcoding tokens in source
code is a security risk and violates Meta's platform policies for production
apps.

Alert Types
-----------
* ``"Alert"`` / ``"No Object Alert"``
    Uses ``templates/whatsapp_alert_template.html``.  Iterates over the
    ``alert`` / ``description`` / ``alert_notification_validity`` parallel lists
    and builds an HTML fragment with camera name, per-alert details, and
    incident timestamp.

* All other types (``"AutoAlert"``, RTSP statuses, etc.)
    Uses ``templates/whatsapp_anomaly_template.html``.  Substitutes only the
    camera name and timestamp — no per-alert detail loop is needed.
"""

import os
import json
import logging
from pathlib import Path
from utils import get_download_url
import requests

# -------------------- LOW-LEVEL WHATSAPP SEND --------------------

def send_to_whatsapp(link, phone_number):
    """POST an image URL to the WhatsApp Business API for a single recipient.

    Constructs a WhatsApp ``image`` message payload and delivers it via the
    Meta Graph API ``/messages`` endpoint (v13.0).  The image is referenced by
    a publicly accessible URL (``link``) rather than uploaded as binary data,
    which is a hard requirement of the WhatsApp Business API.

    The ``Authorization`` header carries a Bearer token that is currently
    hardcoded as a development/test token.  **This must be replaced with a
    securely stored production token before live deployment.**

    Args:
        link (str): A publicly accessible URL to the JPEG image that should be
            sent.  Typically a Google Drive direct-download URL produced by
            ``get_download_url()`` in the calling function.
        phone_number (str): The recipient's WhatsApp-registered phone number in
            E.164 format (e.g. ``"919876543210"`` for an Indian number), as
            required by the WhatsApp Business API.

    Returns:
        str: A human-readable result string:
            - ``"Notification sent on registered WhatsApp number successfully!"``
              on a successful HTTP POST (note: this is returned regardless of the
              HTTP response status code — the current implementation does not
              inspect ``rr.status_code``).
            - ``"Failed to send notification on WhatsApp with error: <exception>"``
              if the ``requests.post`` call raises an exception.
    """
    # Stage: POST image URL to WhatsApp Business API for a single phone number
    try:
        url = f"https://graph.facebook.com/v13.0/107494948909422/messages"
        headers = {
            "Authorization": f"Bearer EAAMuz7x1mk0BAFu7oJIwNaVrvFZCFHIvwAasLLnsRMVldanEZCoQqrb1ZB1RaUrBYyr0nLBpIlfl6xEIR4MZB1w7V3QfKm4VpWQOQIZASxA4JmZA43IJqX0ZAlZAI1iZAlrH3pZBXikXInPnzdTlwrMeF6E6MUz9L9nEXle8PkcFQlzfxWV2wIVnN8",
            'Content-Type': 'application/json'
        }
        data = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone_number,
            "type": "image",
            "image": {
                "link": link,
                "caption": "Aksha Alert"
            }
        }
        rr = requests.post(url, headers=headers, data=json.dumps(data))
        result = "Notification sent on registered WhatsApp number successfully!"
    except Exception as e:
        result = f"Failed to send notification on WhatsApp with error: {e}"
    return result

# -------------------- WHATSAPP NOTIFICATION --------------------

def whatsapp(subscription: str, camera: str, Type: str, DataPath: str, Timestamp: str, sas_url: str, folder_id: str, logger, alert_notification_validity: list = None, alert: list = None, description: list = None, whats_app_service: dict = {"service_status": False, "contact_number": None}):
    """Main WhatsApp notification dispatcher — renders HTML to image, uploads, and sends.

    This is the primary entry point called by the notification service for every
    outbound WhatsApp notification.  It implements the full five-step pipeline
    described in the module docstring: template selection → HTML substitution →
    ``imgkit`` render → Google Drive upload → WhatsApp API POST.

    The function is guarded by ``whats_app_service["service_status"]``: if the
    service is disabled for the subscription, all rendering and network steps
    are skipped entirely.

    Template Selection
    ------------------
    ``Type == "Alert"`` or ``Type == "No Object Alert"``:
        Loads ``templates/whatsapp_alert_template.html``.  Iterates the
        parallel ``alert`` / ``description`` / ``alert_notification_validity``
        lists to build an HTML string of alert detail blocks, then substitutes
        ``{{ camera }}`` and ``{{ alert_details }}`` in the template.

    All other ``Type`` values (AutoAlert, RTSP, etc.):
        Loads ``templates/whatsapp_anomaly_template.html`` and substitutes
        only ``{{ camera }}`` and ``{{ timestamp }}``.

    Args:
        subscription (str): Subscription/tenant identifier, used for logging.
        camera (str): Camera name, substituted into the HTML template.
        Type (str): Notification category — determines which HTML template is
            loaded and how the template variables are populated.
        DataPath (str): Root data directory.  Not currently used for path
            resolution in this function but retained for API consistency with
            the other platform senders.
        Timestamp (str): ISO-8601-ish event timestamp, substituted into the
            anomaly template and used to populate alert detail HTML blocks.
        sas_url (str): Azure SAS URL (retained for API consistency; not used
            in the current WhatsApp implementation which uses Google Drive).
        folder_id (str): Google Drive folder ID where the rendered JPEG will
            be uploaded.  Passed directly to ``get_download_url()``.
        logger: A standard Python logger instance.
        alert_notification_validity (list[bool] | None): Parallel validity
            flags — only alerts with ``True`` are included in the HTML output.
        alert (list[str] | None): Alert names, one per detected alert class.
        description (list[str] | None): Alert descriptions, one per class.
        whats_app_service (dict): Configuration dict with keys:
            - ``"service_status"`` (bool): Whether WhatsApp notifications are
              enabled.  If ``False``, the entire pipeline is skipped.
            - ``"contact_number"`` (str): Recipient's E.164 phone number.

    Returns:
        None: This function does not return a value; outcomes are communicated
        entirely through ``logger`` calls.

    Side Effects:
        - Writes ``notification_whatsapp.html`` to the current working directory.
        - Writes ``notification_whatsapp.jpg`` to the current working directory.
        - Uploads the JPEG to Google Drive.
        - Makes an outbound HTTPS POST to the Meta Graph API.
    """
    # Stage: build WhatsApp message HTML and send via image URL
    logger.info(
        f"whatsapp() | camera={camera} | Type={Type} | subscription={subscription} "
        f"| service_status={whats_app_service.get('service_status')} "
        f"| contact_number={whats_app_service.get('contact_number')}"
    )
    try:
        # Stage: load HTML template based on notification type.
        # Alert and No Object Alert use the dedicated alert template which
        # includes per-alert detail placeholders; all other types (AutoAlert,
        # RTSP) use the anomaly/generic template with only camera + timestamp.
        if Type == "Alert" or Type == "No Object Alert":
            alert_template_path = Path("templates/whatsapp_alert_template.html")
            alert_html_template = alert_template_path.read_text()
            logger.info(f"whatsapp() | loaded alert template | camera={camera}")

            # Build the HTML alert details block by iterating in parallel over
            # alert names, descriptions, and validity flags.  Only alerts whose
            # validity flag is True are included — invalid/disabled alerts are
            # silently skipped so the notification is not cluttered with
            # inactive rules.
            Alert_Details = []
            for alert_name, alert_details, validity in zip(alert, description, alert_notification_validity):
                if validity:
                    Alert_Details.append(
                        f"<strong>Alert Name:</strong> {alert_name}<br>"
                        f"<strong>Alert Description:</strong> {alert_details}<br>"
                        f"<strong>Incident Time:</strong> {Timestamp}<br>"
                    )

            # Substitute the {{ camera }} and {{ alert_details }} placeholders
            # in the template with the actual camera name and joined HTML blocks.
            # The template is re-read (not reusing alert_html_template) to ensure
            # a clean base string before chained .replace() calls.
            Whatsapp_Format = alert_template_path.read_text().replace("{{ camera }}", camera).replace("{{ alert_details }}", " ".join(Alert_Details))

        else:
            # AutoAlert / RTSP / other types — use the anomaly template which
            # has a simpler structure: just camera name and timestamp.
            anomaly_template_path = Path("templates/whatsapp_anomaly_template.html")
            anomaly_html_template = anomaly_template_path.read_text()
            logger.info(f"whatsapp() | loaded anomaly template | camera={camera}")

            # Substitute camera name and timestamp into the anomaly template.
            Whatsapp_Format = anomaly_html_template.replace("{{ camera }}", camera).replace("{{ timestamp }}", Timestamp)

        # Stage: render HTML to image, upload to Google Drive, send via WhatsApp API.
        # The inner try/except is intentionally separate so that template-loading
        # errors (outer block) and send/render errors (inner block) are reported
        # with distinct log messages.
        try:
            if whats_app_service["service_status"]:
                # Temporary file paths written to the current working directory.
                # These are overwritten on every notification call — they are not
                # intended to be persistent artefacts.
                notification_html_path = "notification_whatsapp.html"
                notification_image_path = "notification_whatsapp.jpg"

                # Stage: write the fully substituted HTML string to disk so that
                # imgkit (which wraps wkhtmltoimage) can read it as a local file.
                with open(notification_html_path, "w") as html_file:
                    html_file.write(Whatsapp_Format)
                logger.info(f"whatsapp() | HTML written | path={notification_html_path}")

                # Stage: invoke imgkit to render the HTML file to a JPEG image.
                # 'enable-local-file-access' is required so wkhtmltoimage can
                # load any locally referenced CSS/image assets embedded in the
                # template (e.g. base64 images or local stylesheet hrefs).
                options = {'enable-local-file-access': None}
                import imgkit
                imgkit.from_file(notification_html_path, notification_image_path, options=options)
                logger.info(f"whatsapp() | HTML rendered to image | path={notification_image_path}")

                # Stage: upload image to Google Drive and get a shareable download URL.
                # WhatsApp Business API requires a public HTTPS URL for the image
                # field — it cannot accept a file upload or a local path.  The
                # get_download_url() utility uploads the JPEG to the specified
                # Google Drive folder and returns a direct-download link that
                # Meta's servers can fetch when delivering the message.
                notification_image_url = get_download_url(folder_id, notification_image_path)
                logger.info(f"whatsapp() | image uploaded to Drive | url={notification_image_url}")

                # Stage: send image URL to WhatsApp contact.
                # Passes the Drive URL and the configured recipient phone number
                # to the low-level API wrapper; logs the response string returned.
                wap_response = send_to_whatsapp(notification_image_url, whats_app_service["contact_number"])
                logger.info(f"whatsapp() | WhatsApp API response: {wap_response}")
                logger.info(msg="WhatsApp message sent successfully!")
            else:
                logger.info(msg="WhatsApp service not activated")
        except Exception as e:
            logger.info(msg=f"WhatsApp service failed with exception: {e}")

    except Exception as e:
        logger.info(msg=f"Error encountered while sending WhatsApp alert to Camera: {camera}, with exception: {e}")
