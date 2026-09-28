"""
alert_report_pdf.py
===================
Role
----
Generates a **bi-monthly PDF alert report** covering a 15–16 day window and
emails it to a configured list of recipients via the Gmail API.

The report is triggered automatically on the **1st and 16th of every month**
(bi-monthly cadence).  Each run covers the period ending on *yesterday* and
spanning approximately 15–16 days back, depending on how many days were in the
previous month (see ``generate_table_from_json`` for the exact rule).

Pipeline overview
-----------------
::

    insight_report JSONs  (one per day in <AKSHA_PATH>/insight_report/)
           |
           v
    generate_table_from_json()   — reads JSONs, builds alert_data list
           |
           v
    pandas pivot_table           — Date × (Camera, ObjectClass)  →  CSV
           |
           v
    prepare_data_from_csv()      — loads CSV, generates trend graph,
                                   builds template context dict
           |
           v
    Handlebars template          — static/reportTemplate.hbs rendered
    (via pybars)                   via compile_template()
           |
           v
    pdfkit.from_string()         — calls wkhtmltopdf under the hood,
                                   saves report.pdf to insight_report/
           |
           v
    email_gmail()                — MIME multipart email with PDF attachment
                                   sent via aiogoogle Gmail API (async)

Key files
---------
* ``static/reportTemplate.hbs``  — Handlebars HTML template for the report
* ``static/aksha_logo.txt``      — base64-encoded Aksha logo embedded inline
* ``static/logo.png``            — logo image attached as ``<image1>`` CID
* ``static/logo2.png``           — secondary logo attached as ``<image2>`` CID
* ``keys.yaml``                  — OAuth 2.0 credentials for Gmail API
  (``user_creds.access_token``, ``user_creds.refresh_token``,
   ``client_creds.client_id``, ``client_creds.client_secret``,
   ``client_creds.scopes``)

Libraries
---------
* **pybars** — Python port of Handlebars.js; used for ``{{ }}``-style template
  rendering via :func:`compile_template`.
* **pdfkit** — thin Python wrapper around the ``wkhtmltopdf`` CLI; converts
  rendered HTML to a PDF document.
* **aiogoogle** — async Google API client; used in :func:`email_gmail` to call
  ``gmail.users.messages.send`` without blocking the event loop.
* **matplotlib** — generates the time-series alert trend chart embedded in the
  PDF as a base64 PNG string.
* **pandas** — pivot table construction, CSV I/O, and NaN handling.
* **dateutil.relativedelta** — month-aware date arithmetic used when
  determining the correct look-back window for 31-day months.
"""

import pandas as pd
import pybars
import pdfkit
import matplotlib.pyplot as plt
import io
import base64
import os
import json
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
import time
from aiogoogle import Aiogoogle
import yaml
from aiogoogle.auth.creds import UserCreds, ClientCreds
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.base import MIMEBase
from email import encoders
import sys

# Module-level BytesIO buffer reused across calls to generate_graph().
# Defined at module scope so it persists for the lifetime of the process and
# avoids repeated allocation.  Callers must seek(0) before reading.
stringIO= io.BytesIO()

def generate_pdf_report(todays_date, aksha_path, logger):
    """
    Orchestrate the full PDF report generation pipeline for a bi-monthly run.

    This is the top-level entry point called by the scheduler on days 1 and 16.
    It delegates to :func:`generate_table_from_json` to determine the report
    date range and build the pivot CSV, then loads the Handlebars template,
    renders it with :func:`prepare_data_from_csv`, and finally converts the
    rendered HTML to a PDF via ``pdfkit``.

    Parameters
    ----------
    todays_date : datetime.datetime
        The current datetime (typically ``datetime.now()``).  Used to compute
        the look-back window in :func:`generate_table_from_json`.
    aksha_path : str
        Root Aksha data directory.  The output PDF is written to
        ``<aksha_path>/insight_report/report.pdf``.
    logger : logging.Logger
        Application logger for status and error messages.

    Returns
    -------
    tuple[bool, bool, str, str]
        A four-element tuple ``(success, isData, start_date, end_date)`` where:

        * ``success``    — ``True`` if the PDF was generated without error.
        * ``isData``     — ``True`` if there were any alert records in the
          period (``False`` triggers a "no alerts" email body).
        * ``start_date`` — Human-readable start date, e.g. ``"01 June, 2024"``.
        * ``end_date``   — Human-readable end date,   e.g. ``"15 June, 2024"``.

    Notes
    -----
    * If ``generate_table_from_json`` fails (``success=False``), the function
      returns ``(False, True, start_date, end_date)`` immediately without
      attempting PDF generation.
    * If the period had no alert data (``isData=False``), the function returns
      ``(True, False, start_date, end_date)`` — success flag is ``True``
      because the *process* succeeded; there is simply nothing to render.
    * The Handlebars template is loaded from the path ``static/reportTemplate.hbs``
      relative to the **current working directory** at the time of the call.
    """
    # Delegate date-range determination and CSV creation to generate_table_from_json.
    # Returns raw YYYY-MM-DD strings along with success/isData flags.
    start_date, end_date, success, isData= generate_table_from_json(todays_date, aksha_path, logger)

    # Reformat dates from machine-friendly "YYYY-MM-DD" to human-friendly "DD Month, YYYY"
    # for use in the PDF header and email subject.
    start_date= datetime.strftime(datetime.strptime(start_date, "%Y-%m-%d"), "%d %B, %Y")
    end_date= datetime.strftime(datetime.strptime(end_date, "%Y-%m-%d"), "%d %B, %Y")

    # If the underlying JSON reading / pivot creation failed, surface that failure
    # immediately rather than attempting to render a broken template.
    if not success:
        return False, True, start_date, end_date

    # No alert data in the period — return early; caller will send a "no data" email.
    if not isData:
        return True, False, start_date, end_date

    logger.info(msg=f"PDF generation will be for period: {start_date} to {end_date}")

    # Path to the pivot table CSV created by generate_table_from_json.
    pivot_table_csv = f"{aksha_path}/insight_report/report_pivot_table.csv"

    # Build the template context dictionary from the CSV (includes graph, headers, rows).
    data = prepare_data_from_csv(pivot_table_csv, start_date, end_date)

    # Load the raw Handlebars template source from disk.
    with open('static/reportTemplate.hbs', 'r') as template:
        handlebars_template = template.read()
    try:
        # Render the Handlebars template with the data dict → returns an HTML string.
        combined_html = compile_template(handlebars_template, data)

        # pdfkit options: A4 page size, allow local file:// access for embedded
        # images referenced in the HTML (e.g. the graph PNG data URI).
        options= {
            "page-size":"A4",
            "enable-local-file-access": ""
            }

        # Convert the rendered HTML string to a PDF file via wkhtmltopdf.
        # The output path is fixed: <aksha_path>/insight_report/report.pdf
        pdfkit.from_string(str(combined_html), f'{aksha_path}/insight_report/report.pdf', options=options)
        logger.info(msg="HTML report generated successfully.")
        return True, True, start_date, end_date

    except Exception as e:
        # pdfkit / wkhtmltopdf errors are caught here; return failure flag so
        # the caller can decide whether to send a fallback email.
        logger.info(msg=f"Exception occured while genrating report PDF: {e}")
        return False, True, start_date, end_date


def generate_table_from_json(todays_date, aksha_path, logger):
    """
    Read per-day insight_report JSONs for the bi-monthly period and produce a
    pivot table CSV.

    The bi-monthly report covers a **15- or 16-day window** ending on
    yesterday.  The exact window length depends on whether the *previous*
    calendar month had 31 days:

    * Previous month had 31 days **and** today is the 1st → ``timedelta_val = 17``
      (look back 17 days, then drop today, giving 16 dates).
    * All other cases → ``timedelta_val = 16`` (look back 16 days, drop today,
      giving 15 dates).

    This asymmetry exists so that the two report windows of a month together
    always cover the full previous month without gaps or overlaps.

    Parameters
    ----------
    todays_date : datetime.datetime
        The current datetime used as the anchor for date arithmetic.
    aksha_path : str
        Root Aksha data directory.  Insight report JSONs are expected at
        ``<aksha_path>/insight_report/<YYYY-MM-DD>.json``.
    logger : logging.Logger
        Application logger.

    Returns
    -------
    tuple[str, str, bool, bool]
        ``(start_date, end_date, success, isData)`` where:

        * ``start_date`` — Earliest date in the period (``YYYY-MM-DD``).
        * ``end_date``   — Latest date in the period   (``YYYY-MM-DD``).
        * ``success``    — ``True`` if pivot CSV was written (or there was no
          data to write), ``False`` on unexpected exception.
        * ``isData``     — ``True`` if at least one alert record was found
          across all JSONs in the period.

    Side Effects
    ------------
    Writes ``<aksha_path>/insight_report/report_pivot_table.csv`` when alert
    data is available.

    Notes
    -----
    * Missing JSON files for individual dates within the window are silently
      skipped (``print`` + ``continue``).
    * The pivot aggregation function is ``sum``; duplicate (Date, Camera,
      ObjectClass) combinations are added together.
    """
    # Months that have 31 days — used to decide whether to extend the look-back
    # window by one day when today is the 1st of a new month.
    thirtyone_days_months= [1,3,5,7,8,10,12]
    try:
        # Compute the previous calendar month using relativedelta (handles year wrap).
        last_month= (todays_date+relativedelta(months=-1)).month

        # If the previous month had 31 days and today is the 1st, use 17 as the
        # look-back delta so the window captures 16 full days (timedelta gives
        # indices 0..16, which is 17 values; today is removed below).
        if todays_date.day == 1 and last_month in thirtyone_days_months:
            timedelta_val= 17
        else:
            # Standard case: 16-day look-back covers the 15 days prior to today.
            timedelta_val=16

        # Build a list of date strings for the look-back window.
        # range(timedelta_val) generates offsets 0, 1, 2, ... (timedelta_val-1).
        # Offset 0 is today, offset 1 is yesterday, etc.
        dates=[todays_date.date() - timedelta(days=x) for x in range(timedelta_val)]
        dates=[date.strftime('%Y-%m-%d') for date in dates]

        # Remove today's date: the report covers *completed* days only.
        dates.remove(str(todays_date.date()))

        # After removing today, dates[0] is yesterday (end of period) and
        # dates[-1] is the furthest day back (start of period).
        start_date= dates[-1]
        end_date= dates[0]

        # alert_data accumulates one dict per (date, camera, object_class) record.
        alert_data=[]

        # cam_name_list is populated for potential future use (currently unused).
        cam_name_list=[]

        # Iterate through each date in the window and load its insight_report JSON.
        for date in dates:
            try:
                ir_path= f'{aksha_path}/insight_report/{date}.json'
                with open(ir_path, 'r') as ir_file:
                    data= json.load(ir_file)
            except Exception as e:
                # A missing or corrupt JSON for one date is non-fatal; skip and continue.
                print(f"Exception occurred while finding the file {date}.json: {e}")
                continue

            # Each top-level key in the JSON is a camera name.
            for cam, details in data.items():
                cam_name_list.append(cam)

                # "object_detection_alerts" maps object class → alert count for this
                # camera on this date in the insight_report schema.
                for alert_type, count in details.get("object_detection_alerts", {}).items():
                    alert_data.append(
                        {
                            "Date": date,
                            "Camera": str(cam),
                            "Object Class": alert_type,
                            "Alert Count": count,
                        }
                    )

        # Only build the pivot table if at least one alert record was collected.
        if len(alert_data) != 0:
            df= pd.DataFrame(alert_data)
            # df=df.fillna(0).astype(int)  # (commented out — fillna applied later in prepare_data_from_csv)

            # Convert the Date column to datetime so the pivot index sorts chronologically.
            df['Date'] = pd.to_datetime(df['Date'])

            # Create a multi-level column pivot:  rows = Date,
            # columns = (Camera, Object Class),  values = Alert Count.
            # aggfunc='sum' handles the case where the same (date, cam, class)
            # combination appears in multiple JSON entries.
            pivot_df = df.pivot_table(index='Date', columns=['Camera', 'Object Class'], values='Alert Count', aggfunc='sum')
            print("pivot df created")

            # Persist the pivot table to CSV for downstream use by prepare_data_from_csv.
            pivot_df.to_csv(f"{aksha_path}/insight_report/report_pivot_table.csv")
            logger.info(msg="PDF generation: pivot df saved")
            success=True
            isData= True

        else:
            # No alert data found for any date in the window — signal the caller
            # so that a "no data" email body can be sent instead of a PDF.
            logger.info(msg="PDF generation: No alert data found")
            success=True
            isData=False

        return start_date, end_date, success, isData
    except Exception as e:
        # Unexpected error (e.g. malformed JSON structure, pandas error).
        # Return the dates computed so far (may be partially initialised) plus
        # failure flags so the caller can still format a meaningful log message.
        logger.info(msg=f"PDF generation: Exception occured: {e}")
        return start_date, end_date, False, True


def prepare_data_from_csv(csv_file, start_date, end_date):
    """
    Load the pivot table CSV and build the Handlebars template context dict.

    Reads the multi-level-header CSV created by :func:`generate_table_from_json`,
    cleans it, generates the trend graph, and packages everything into a Python
    dict that maps directly to the variables referenced in
    ``static/reportTemplate.hbs``.

    Parameters
    ----------
    csv_file : str
        Absolute or relative path to the pivot table CSV file.  The file is
        expected to have **two header rows** (camera name on row 0, object
        class on row 1) and a ``Date`` index column — the exact format written
        by ``pivot_df.to_csv()``.
    start_date : str
        Human-readable start date string (e.g. ``"01 June, 2024"``) used in
        the template's ``reportDate`` field.
    end_date : str
        Human-readable end date string (e.g. ``"15 June, 2024"``).

    Returns
    -------
    dict
        Template context containing:

        * ``'akshalogo'``    — base64 string of the Aksha logo, read from
          ``static/aksha_logo.txt``.  Embedded inline in the HTML header.
        * ``'reportDate'``   — formatted period string ``"<start> to <end>"``.
        * ``'cameraHeaders'``— list of dicts, each with keys ``'camera'``
          (str), ``'colspan'`` (int), and ``'objectClasses'`` (list[str]).
          Drives the two-row ``<thead>`` in the HTML table.
        * ``'tableRows'``    — list of dicts, each with keys ``'date'`` (str)
          and ``'rowData'`` (list of int values for each column).
        * ``'graphBase64'``  — base64-encoded PNG of the matplotlib trend
          chart, embedded as a data URI in the template.

    Notes
    -----
    * ``header=[0, 1]`` in ``pd.read_csv`` reads the first two rows as a
      MultiIndex column header, matching the structure written by pandas
      ``pivot_table.to_csv()``.
    * Float columns (resulting from NaN-fill operations) are cast back to
      ``int`` to avoid displaying values like ``"3.0"`` in the table.
    * The camera_headers loop uses a ``for … else`` construct: the ``else``
      branch fires only when no ``break`` occurred, i.e. the camera was not
      yet seen → a new header entry is appended.
    """
    # Read with two-row header (MultiIndex columns) and Date as the row index.
    # engine='python' is specified for compatibility with certain CSV edge cases.
    df = pd.read_csv(csv_file, header=[0, 1], index_col=0, engine='python')  # Header on first two rows and 'Date' as index

    # Replace NaN (cells where a camera had no alerts on a given date) with 0.
    df= df.fillna(0)

    # Convert float64 columns to int to produce clean integer counts in the report.
    # Non-float columns (if any) are left unchanged.
    df= df.apply(lambda x: x.astype(int) if x.dtype == 'float64' else x)

    # Generate the matplotlib trend graph and get back a base64-encoded PNG string.
    graph_b64= generate_graph(df)

    # Load the base64 Aksha logo string from its text file; this will be embedded
    # directly in the <img src="data:image/png;base64,..."> tag in the template.
    with open('static/aksha_logo.txt', 'r') as logo:
        aksha_logo=logo.read()

    # Build the camera_headers list that drives the two-row table header in the template.
    # Each entry groups object classes that belong to the same camera under a single
    # spanning header cell (colspan = number of object classes for that camera).
    camera_headers = []
    for (camera, object_class) in df.columns:
        # Check whether this camera already has an entry in camera_headers.
        for header in camera_headers:
            if header['camera'] == camera:
                # Camera already seen — append this object class to its list and
                # increment the colspan so the header cell spans one more column.
                header['objectClasses'].append(object_class)
                header['colspan'] += 1
                break
        else:
            # New camera: create a fresh header entry with colspan=1.
            camera_headers.append({
                'camera': camera,
                'colspan': 1,
                'objectClasses': [object_class]
            })

    # Build the table_rows list — one entry per date row in the pivot table.
    # 'rowData' is a plain Python list (not a pandas Series) so Handlebars can
    # iterate it with {{#each rowData}}.
    table_rows = []
    for date, row in df.iterrows():
        table_rows.append({
            'date': date,
            'rowData': row.tolist()   # convert Series → list of int values
        })

    # Assemble the complete template context dict.
    # Key names must match the {{variable}} references in reportTemplate.hbs exactly.
    data = {
        'akshalogo': aksha_logo,                          # base64 logo for inline embedding
        'reportDate': f'{start_date} to {end_date}',      # period string shown in PDF header
        'cameraHeaders': camera_headers,                   # list of {camera, colspan, objectClasses}
        'tableRows': table_rows,                           # list of {date, rowData}
        'graphBase64': graph_b64,                          # base64 PNG of the trend graph
    }

    return data

# Helper function to compile the Handlebars template
def compile_template(handlebars_template, data):
    """
    Compile a Handlebars template string and render it with the provided data.

    Uses the ``pybars`` library (Python port of Handlebars.js) to perform
    ``{{ }}``-style interpolation, ``{{#each}}`` loops, and ``{{#if}}``
    conditionals as defined in the template.

    Parameters
    ----------
    handlebars_template : str
        Raw Handlebars template source code read from ``static/reportTemplate.hbs``.
    data : dict
        Template context dictionary returned by :func:`prepare_data_from_csv`.
        Keys must match the variable names referenced in the template.

    Returns
    -------
    pybars._compiler.strlist
        A pybars string-list object that can be cast to ``str`` for use with
        ``pdfkit.from_string()``.  It behaves like a string in most contexts.
    """
    # Instantiate the pybars compiler (stateless; safe to create per call).
    handlebars = pybars.Compiler()

    # Compile the raw template source into a callable template function.
    template = handlebars.compile(handlebars_template)

    # Render the template by calling it with the data context.
    # The return value is a pybars strlist (list-of-strings optimised for concatenation).
    combined_html = template(data)
    return combined_html

def generate_graph(pivot_df):
    """
    Generate a time-series line chart of alert counts and return it as a
    base64-encoded PNG string.

    Creates a ``matplotlib`` figure with one line per ``(Camera, ObjectClass)``
    combination found in *pivot_df*.  The figure is rendered to an in-memory
    PNG byte buffer and then base64-encoded for embedding as a ``data:`` URI
    in the Handlebars template.

    Parameters
    ----------
    pivot_df : pandas.DataFrame
        The pivot table with a ``datetime`` index (dates) and MultiIndex
        columns ``(Camera, ObjectClass)``.  This is the same DataFrame loaded
        by :func:`prepare_data_from_csv` before NaN-filling.

    Returns
    -------
    str
        Base64-encoded UTF-8 string of the PNG image.  Suitable for use in an
        HTML ``<img src="data:image/png;base64,<value>">`` tag.

    Notes
    -----
    * The function reuses the module-level ``stringIO`` buffer.  After writing,
      the buffer position is reset to 0 with ``seek(0)`` so subsequent reads
      start from the beginning.
    * The legend is placed outside the plot area (``bbox_to_anchor=(1.05, 1)``)
      to avoid overlapping the lines when there are many camera/class combinations.
    * ``plt.tight_layout()`` adjusts subplot parameters so the legend is not
      clipped by the figure boundary.
    """
    # Plot all columns as a line chart with circle markers at each data point.
    # figsize=(12, 6) provides enough width for multi-camera datasets.
    pivot_df.plot(kind='line', marker='o', figsize=(12, 6))
    plt.title('Alert Counts Over Time by Camera and Object Class')
    plt.xlabel('Date')
    plt.ylabel('Alert Count')

    # Place the legend to the right of the plot so it does not occlude the data.
    plt.legend(title='Camera, Object Class', bbox_to_anchor=(1.05, 1), loc='upper left')
    plt.grid(True)

    # Automatically adjust subplot params to fit the legend within the figure.
    plt.tight_layout()

    # Render the figure into the module-level BytesIO buffer as a PNG.
    plt.savefig(stringIO, format='png')

    # Rewind the buffer so base64 encoding reads from the beginning of the PNG data.
    stringIO.seek(0)

    # Encode the binary PNG data as a base64 ASCII string for HTML embedding.
    graph_b64 = base64.b64encode(stringIO.read()).decode()

    return graph_b64


async def email_gmail(subscription:str, recipients:list, sender_email:str, aksha_path:str, start_date:str, end_date:str, isData:bool, logger):
    """
    Asynchronously send the bi-monthly alert report email via the Gmail API.

    Constructs a MIME multipart email with:

    * Two inline logo images (``static/logo.png`` as ``<image1>`` and
      ``static/logo2.png`` as ``<image2>``) referenced by CID in the HTML body.
    * An HTML body that adapts based on *isData*:

      - ``isData=True``  → body announces the attached PDF report.
      - ``isData=False`` → body informs recipients that no alerts were generated
        in the period.

    * The PDF report file attached as ``report.pdf`` (only when ``isData=True``).

    Authentication uses OAuth 2.0 credentials loaded from ``keys.yaml``
    (relative to the current working directory).  The async ``aiogoogle``
    client handles token refresh automatically before sending.

    Parameters
    ----------
    subscription : str
        Subscription/plan identifier (currently unused in the function body;
        reserved for future per-plan email customisation).
    recipients : list[str]
        List of recipient email addresses.  All addresses are placed in the
        ``To:`` header as a comma-separated string.
    sender_email : str
        Intended sender address (currently overridden by the hard-coded
        ``"cctv.alerts@algoanalytics.com"`` constant; kept as a parameter for
        future flexibility).
    aksha_path : str
        Root Aksha data directory.  The PDF is read from
        ``<aksha_path>/insight_report/report.pdf``.
    start_date : str
        Human-readable start of the report period (e.g. ``"01 June, 2024"``).
        Used in the email subject and HTML body.
    end_date : str
        Human-readable end of the report period (e.g. ``"15 June, 2024"``).
    isData : bool
        When ``True`` the PDF attachment is included and the "please see
        attached" HTML body is used.  When ``False`` a "no alerts" body is
        sent without an attachment.
    logger : logging.Logger
        Application logger for timing and status messages.

    Returns
    -------
    bool
        ``True`` if the email was sent successfully, ``False`` on any exception.

    Notes
    -----
    * ``keys.yaml`` must be present in the current working directory and must
      contain ``user_creds`` (with ``access_token``, ``refresh_token``,
      ``expires_at``) and ``client_creds`` (with ``client_id``,
      ``client_secret``, ``scopes``).
    * The raw MIME message is base64url-encoded before passing to the Gmail
      API, as required by ``gmail.users.messages.send``.
    * Elapsed time for the send operation is logged at INFO level.
    """
    try:
        logger.info(f"entered email_gmail function")

        # Record start time for performance logging.
        st_email = time.time()

        # Hard-coded sender address; sender_email parameter is available for
        # future use when multi-tenancy requires per-subscription senders.
        sender= "cctv.alerts@algoanalytics.com"
        # sender = sender_email

        # Subject line identifies the report period for easy inbox filtering.
        subject = f'Bi-monthly Alert Report for the Period of {start_date} to {end_date}'

        # Create the root MIME container with 'related' sub-type so that inline
        # images (logo CIDs) are correctly associated with the HTML body part.
        msgRoot = MIMEMultipart('related')
        msgRoot['Subject'] = subject
        msgRoot['From'] = sender
        msgRoot['To'] = ", ".join(recipients)   # RFC 2822: comma-separated list
        msgRoot.preamble = 'This is a multi-part message in MIME format.'
        logger.info(f"specified the details: {sender}, {recipients}")

        # Encapsulate the plain and HTML versions of the message body in an
        # 'alternative' part, so message agents can decide which they want to display.
        msgAlternative = MIMEMultipart('alternative')
        msgRoot.attach(msgAlternative)

        # Fallback plain-text part (shown by email clients that cannot render HTML).
        msgText = MIMEText('This is the alternative plain text message.')
        msgAlternative.attach(msgText)

        # Attach the first logo image (Aksha logo) as an inline CID attachment.
        # The HTML body references it via <img src="cid:image1">.
        with open(os.path.join(os.path.abspath("."), 'static/logo.png'), 'rb') as fp:
            msgImage1 = MIMEImage(fp.read())
            # for referring the image in the IMG SRC attribute, ID is provided
            msgImage1.add_header('Content-ID', '<image1>')
            msgRoot.attach(msgImage1)

        # Attach the second logo image (partner/client logo) as CID <image2>.
        with open(os.path.join(os.path.abspath("."), 'static/logo2.png'), 'rb') as fp:
            msgImage2 = MIMEImage(fp.read())
            msgImage2.add_header('Content-ID', '<image2>')
            msgRoot.attach(msgImage2)

        #Email body format
        if not isData:
            # Branch: no alert data in the report period.
            # Send a short informational HTML email with no PDF attachment.
            logger.info(f"no data")

            # Inline HTML email body informing the recipient of the empty period.
            # Logos are referenced via their CID attachments above.
            Email_Format = f"""<!DOCTYPE html>
                        <html lang="en">
                        <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>My alert email</title>
                        </head>
                        <body style="margin:0;padding:0;">

                            <div
                            style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
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
                                    This is to inform you that there were <b> no alerts generated </b> for the period of {start_date} to {end_date} for your Aksha installation.<br><br>

                                </p>
                                </div>
                            </div>

                        </body>
                    </html>
                    """
            # Attach the HTML body to the alternative part for proper multipart rendering.
            msgText = MIMEText(Email_Format, 'html')
            msgAlternative.attach(msgText)
            msgRoot.attach(msgText)

            # Encode the full MIME message as base64url for the Gmail API's raw field.
            raw_message = base64.urlsafe_b64encode(msgRoot.as_bytes()).decode()

        else:
            # Branch: alert data exists — send email with PDF report attached.
            logger.info(f"data available")

            # Inline HTML body directing the recipient to the attached PDF report.
            Email_Format = f"""<!DOCTYPE html>
                        <html lang="en">
                        <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>My alert email</title>
                        </head>
                        <body style="margin:0;padding:0;">

                            <div
                            style="font-family:sans-serif;background:#dddd;width:100%;padding:49px 20px">
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
                                    Please check the bi-monthly alert report analysis for the period of {start_date} to {end_date} attached below.<br><br>

                                </p>
                                </div>
                            </div>

                        </body>
                    </html>
                    """

            # Open and read the generated PDF report as binary data.
            with open(f"{aksha_path}/insight_report/report.pdf", "rb") as attachment:
                pdf_report = MIMEBase("application", "octet-stream")   # generic binary MIME type
                pdf_report.set_payload(attachment.read())

            # Base64-encode the binary PDF payload so it can travel through email transport.
            encoders.encode_base64(pdf_report)

            # Set Content-Disposition header so email clients save it as "report.pdf".
            pdf_report.add_header(
                "Content-Disposition",
                f"attachment; filename= report.pdf",
            )

            # Attach HTML body and the PDF to the MIME tree.
            msgText = MIMEText(Email_Format, 'html')
            msgAlternative.attach(msgText)
            msgRoot.attach(pdf_report)   # PDF as a separate MIME attachment

            # Encode the full MIME message as base64url for the Gmail API.
            raw_message = base64.urlsafe_b64encode(msgRoot.as_bytes()).decode()

        # Load OAuth 2.0 credentials from keys.yaml.
        # keys.yaml must reside in the current working directory.
        try:
            with open(os.path.join(os.path.abspath("."), "keys.yaml"), "r") as stream:
                config = yaml.load(stream, Loader=yaml.FullLoader)
        except Exception as e:
            # print("Rename _keys.yaml to keys.yaml")
            raise e   # re-raise so the outer except can log and return False
        logger.info(f"found keys.yaml")

        # Reconstruct UserCreds from stored token values.
        # expires_at may be None if the token was issued without an expiry.
        user_creds = UserCreds(
            access_token=config["user_creds"]["access_token"],
            refresh_token=config["user_creds"]["refresh_token"],
            expires_at=config["user_creds"]["expires_at"] or None,
        )

        # Reconstruct ClientCreds (OAuth2 app registration details).
        client_creds = ClientCreds(
            client_id=config["client_creds"]["client_id"],
            client_secret=config["client_creds"]["client_secret"],
            scopes=config["client_creds"]["scopes"],   # must include gmail.send scope
        )

        # Open an async Aiogoogle session; the context manager handles token refresh.
        async with Aiogoogle(user_creds=user_creds, client_creds=client_creds) as google:
            # Discover the Gmail API v1 service descriptor (cached by aiogoogle).
            gmail = await google.discover("gmail", "v1")

            # Send the message using the authenticated user's mailbox ("me" = authenticated user).
            # The 'raw' field contains the base64url-encoded MIME message.
            response = await google.as_user(
                                gmail.users.messages.send(userId="me", json={'raw': raw_message})
                                )
            print(f'Message Id: {response["id"]}')

        logger.info(f"Email sending Message Id: {response['id']}")

        # Calculate and log the wall-clock time taken to send the email.
        et_email = time.time()
        # print(f"Email time : {et_email - st_email}")
        logger.info(msg="PDF report sent as email")
        logger.info(msg=f"PDF email time : {et_email - st_email}")
        return True
    except Exception as e:
        # Catch-all for any failure in MIME construction, file I/O, or Gmail API call.
        print(e)
        logger.info(f"Error encountered while sending PDF report mail: {e}")
        return False
