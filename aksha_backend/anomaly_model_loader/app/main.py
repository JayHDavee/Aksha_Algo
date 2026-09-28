"""
anomaly_model_loader  –  FastAPI Report-Generation Service
===========================================================

Architecture Overview
---------------------
This service was originally the entrypoint for anomaly model training and
inference (frame-based IsolationForest + object-based OCSVM).  That role has
been **replaced** by a pure report-generation service; all model-training /
prediction code is preserved in the commented-out ``ModelLoader`` class below
for historical reference.

High-level component diagram::

    ┌─────────────────────────────────────────────────────────────────┐
    │                  anomaly_model_loader  (port 8000)              │
    │                                                                 │
    │  ┌──────────────────────┐   ┌───────────────────────────────┐  │
    │  │   FastAPI REST API   │   │  scheduled_reports()          │  │
    │  │                      │   │  (asyncio background task)    │  │
    │  │  POST /generate_kpi_ │   │                               │  │
    │  │       report         │   │  • Every 60 s: checks the     │  │
    │  │  POST /generate_     │   │    current wall-clock minute  │  │
    │  │       insight_report │   │  • At :00 of every hour:      │  │
    │  │  POST /generate_pdf_ │   │    insight_report + kpi_report│  │
    │  │       report         │   │  • Days 1 & 16 at 12:00:00:   │  │
    │  │  POST /send_report_  │   │    PDF generation + email     │  │
    │  │       email          │   │  • At 00:00:00 daily:         │  │
    │  │  GET  /health        │   │    delete reports > 15 days   │  │
    │  └──────────────────────┘   └───────────────────────────────┘  │
    │                                                                 │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │  Report generation chain                                │   │
    │  │  insight_report.generate_insight_report()  ─── hourly  │   │
    │  │  kpi_report.generate_kpi_report()          ─── hourly  │   │
    │  │  alert_report_pdf.generate_pdf_report()    ─── bi-mthly│   │
    │  │  alert_report_pdf.email_gmail()            ─── bi-mthly│   │
    │  └─────────────────────────────────────────────────────────┘   │
    │                                                                 │
    │  ┌─────────────────────────────────────────────────────────┐   │
    │  │  MongoDB  (pymongo, db_uri from env)                    │   │
    │  │  • db.config      – Camera_Name distinct values        │   │
    │  │  • db.Alerts      – Alert_Name distinct values         │   │
    │  │  • db.Resource    – email / subscription settings      │   │
    │  └─────────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────────┘

Commented-out ``ModelLoader`` class
------------------------------------
The ``ModelLoader`` class (lines below the imports) was the **original**
anomaly model training and loading entrypoint.  It contained four methods:

* ``train_framebase``  – trained a per-hour IsolationForest on foreground frames
* ``train_objectbase`` – trained a per-day One-Class SVM on object detections
* ``load_framebase``   – loaded the current-hour frame model from disk
* ``load_objectbase``  – loaded the object model from disk

It also contained two async loops (``hourly_loop`` and ``daily_loop``) that
drove model refresh on a schedule.  These were replaced by the
``scheduled_reports`` background task when the service was repurposed to
report generation.  The class is kept for reference and potential re-activation.

Environment Variables
---------------------
CAMERA_NAME   : Logical name of the camera this service instance manages.
                Used as a fallback when no cameras are found in MongoDB and
                as a path component for log files.
AKSHA_PATH    : Root filesystem path under which per-camera subdirectories
                (foreground images, anomaly models, reports, logs) live.
MONGODB_URI   : MongoDB connection string.  If absent, all DB-dependent
                functionality degrades gracefully to no-op or fallback values.

REST Endpoints (port 8000)
--------------------------
POST /generate_kpi_report
    Trigger an on-demand KPI JSON report for today.  Requires MongoDB.

POST /generate_insight_report
    Trigger an on-demand insight JSON report for today.  Requires MongoDB.

POST /generate_pdf_report
    Generate a bi-monthly PDF alert report for an optional target date
    (defaults to now).

POST /send_report_email
    Generate a PDF report for an optional date then e-mail it to a
    caller-supplied recipient list.

GET  /health
    Liveness probe; returns service status, MongoDB connectivity, and
    whether the anomaly models are currently loaded.

Report Schedule (driven by ``scheduled_reports`` background loop)
-----------------------------------------------------------------
• Insight + KPI JSON  – every hour at minute :00
• PDF report + email  – 1st and 16th of each month at 12:00:00 noon
  (only when ``send_alert_report`` flag is True in the Resource document)
• Report cleanup      – midnight daily; deletes reports older than 15 days

``anomaly_percent``
-------------------
The module-level constant ``anomaly_percent = 0.005`` (0.5 %) is the
``contamination`` hyperparameter passed to ``IsolationForest``.  It tells the
algorithm the expected fraction of anomalous samples in the training set.
A value of 0.5 % is deliberately conservative: it assumes the vast majority
of captured foreground frames are normal activity.
"""

import joblib
import logging
import datetime as dt
from datetime import timedelta
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from pydantic import BaseModel
from typing import Annotated, List, Optional
from contextlib import asynccontextmanager
from io import BytesIO
from PIL import Image
import numpy as np
import os
import asyncio
import uvicorn
import frame_based_model_trainer
import object_based_model_trainer
from dotenv import load_dotenv
import pymongo

# Import report modules
import kpi_report
import insight_report
import alert_report_pdf as alert_report

# ── Environment bootstrap ─────────────────────────────────────────────────────
load_dotenv()  # Pull values from a .env file into os.environ (no-op if absent)

# Camera name for this service instance – used as path component and fallback
# camera list entry when MongoDB is unavailable.
camera_name = os.environ.get("CAMERA_NAME")

# Root directory under which per-camera subdirectories are stored on disk.
aksha_path = os.environ.get("AKSHA_PATH")

# MongoDB connection string.  May be None; all DB operations guard against this.
db_uri = os.environ.get("MONGODB_URI")

# IsolationForest contamination parameter: 0.005 = 0.5 % expected anomaly rate.
# Kept here at module level so it is easy to tune without touching model code.
anomaly_percent = 0.005

# ── Logging setup ─────────────────────────────────────────────────────────────
# Resolve the camera-specific log directory and ensure it exists before
# configuring the file handler so that basicConfig never throws.
logger_path = f"{aksha_path}/{camera_name}/log"
os.makedirs(logger_path, exist_ok=True)

logging.basicConfig(
    filename=f"{logger_path}/model_loader.log",
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    filemode="a",
)
logger = logging.getLogger("model_loader")

# ── MongoDB connection ────────────────────────────────────────────────────────
# db is intentionally initialised to None; all subsequent code checks
# `db is not None` (not truthiness) because a newly connected MongoClient
# database object evaluates to False in a boolean context – hence the explicit
# identity checks throughout this module.
db = None
if db_uri:
    try:
        client = pymongo.MongoClient(db_uri)
        # get_database() relies on the database name encoded in the URI string.
        db = client.get_database()
        logger.info("MongoDB connection established")
    except Exception as e:
        logger.error(f"MongoDB connection failed: {e}")
        db = None

# ── Pydantic request model (used by commented-out prediction endpoints) ────────
class PredictionRequest(BaseModel):
    frame_id: str
    frame_data: list
    timestamp: str

# ── Commented-out ModelLoader class ──────────────────────────────────────────
# The ModelLoader class was the original entrypoint for anomaly model
# training and loading.  It has been replaced by the pure report service
# (scheduled_reports + REST endpoints) but is preserved here for reference
# and potential future reactivation.
#
# Methods that were defined:
#   __init__          – initialised framebase_model and objectbase_model to None
#   train_framebase   – called frame_based_model_trainer for the current hour
#   train_objectbase  – called object_based_model_trainer (skipped without DB)
#   load_framebase    – loaded <hour>.pkl from anomaly_models/framebase/
#   load_objectbase   – loaded ocsvm_model.pkl from anomaly_models/objectbase/
#   initial_run       – sequential: train + load both model types on startup
#   hourly_loop       – async: re-train + reload framebase every hour at :00
#   daily_loop        – async: re-train + reload objectbase once per midnight
# class ModelLoader:
#     def __init__(self):
#         self.framebase_model = None
#         self.objectbase_model = None

#     def train_framebase(self):
#         hour = dt.datetime.now().hour
#         logger.info(f"Framebase training started for hour {hour}")
#         try:
#             frame_based_model_trainer.train_isolation_forest_model(aksha_path, camera_name, anomaly_percent, hour)
#         except RuntimeError as e:
#             logger.warning(f"Framebase training skipped: {e}")

#     def train_objectbase(self):
#         if not db_uri:
#             logger.info("Mongo DB not configured, skipping objectbase training")
#             return
#         logger.info("Objectbase training started")
#         object_based_model_trainer.train_OCSVM_object_based_model(
#             aksha_path, camera_name, db_uri, dt.datetime.now())

#     def load_framebase(self):
#         hour = dt.datetime.now().hour
#         path = f"{aksha_path}/{camera_name}/anomaly_models/framebase/{hour}.pkl"
#         if os.path.exists(path):
#             self.framebase_model = joblib.load(path)
#             logger.info("Framebase model loaded")
#         else:
#             self.framebase_model = None
#             logger.info("Framebase model not found")

#     def load_objectbase(self):
#         path = f"{aksha_path}/{camera_name}/anomaly_models/objectbase/ocsvm_model.pkl"
#         if os.path.exists(path):
#             self.objectbase_model = joblib.load(path)
#             logger.info("Objectbase model loaded")
#         else:
#             self.objectbase_model = None
#             logger.info("Objectbase model not found")

    # def initial_run(self):
    #     self.train_framebase()
    #     self.train_objectbase()
    #     self.load_framebase()
    #     self.load_objectbase()
    #     logger.info("Initial model load completed")

    # async def hourly_loop(self):
    #     while True:
    #         self.train_framebase()
    #         self.load_framebase()
    #         now = dt.datetime.now()
    #         next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    #         await asyncio.sleep((next_hour - now).total_seconds())

    # async def daily_loop(self):
    #     last_date = None
    #     while True:
    #         now = dt.datetime.now()
    #         if now.hour == 0 and last_date != now.date():
    #             self.train_objectbase()
    #             self.load_objectbase()
    #             last_date = now.date()
    #         await asyncio.sleep(3600)

#model_loader = ModelLoader()

# ── Helper functions ──────────────────────────────────────────────────────────

async def get_camera_list():
    """Return the list of active camera names from MongoDB.

    Queries the ``config`` collection for all distinct ``Camera_Name`` values.
    Falls back to the single ``camera_name`` environment variable if MongoDB is
    unavailable or the query fails.

    Important fix note
    ------------------
    The guard is ``if db is not None`` rather than the simpler ``if db``
    because a ``pymongo`` database object evaluates to ``False`` in a boolean
    context even when the connection is live.  Using identity comparison
    avoids silently skipping all DB queries on a healthy connection.

    Returns
    -------
    list[str]
        Camera name strings.  Never raises; returns a single-element list or
        empty list on any failure.
    """
    try:
        if db is not None:  # Fix: Change 'if db:' to 'if db is not None:'
            # distinct() returns a deduplicated list of all Camera_Name values
            # across every document in the config collection.
            camera_names = db.config.distinct("Camera_Name")
            logger.info(f"Fetched camera list: {camera_names}")
            return camera_names
        # No DB: fall back to the single camera configured via environment var
        return [camera_name] if camera_name else []
    except Exception as e:
        logger.error(f"Error fetching camera list: {e}")
        # Graceful degradation: keep the service running with at most one camera
        return [camera_name] if camera_name else []


async def get_senderemail_and_recipients():
    """Fetch e-mail sender and recipient configuration from the Resource document.

    Reads the first (and typically only) document from ``db.Resource`` and
    extracts four fields:

    ``alert_report_email``
        List of recipient e-mail addresses for bi-monthly PDF reports.
    ``username``
        Subscription/account identifier passed to the Gmail helper as the
        ``subscription`` argument (used to select the correct OAuth token).
    ``new_email``
        Sender e-mail address authenticated with the SMTP/OAuth backend.
    ``send_alert_report``
        Boolean flag; when False the scheduled PDF step is skipped entirely,
        preventing unwanted e-mails during testing or staging deployments.

    Important fix note
    ------------------
    The guard is ``if db is None`` rather than ``if not db`` for the same
    reason documented in ``get_camera_list``.

    Returns
    -------
    tuple[list, str | None, str | None, bool]
        (recipients, subscription, sender_email, send_alert_report)
        All values default to empty / None / False on any failure.
    """
    try:
        if db is None:  # Fix: Change 'if not db:' to 'if db is None:'
            # No database connection available; return safe defaults so callers
            # do not need to special-case a None return value.
            return [], None, None, False

        # find_one() with no filter returns the first document in the collection
        resource_data = db.Resource.find_one()
        if not resource_data:
            logger.info("Resource_Data is None")
            return [], None, None, False

        # Extract individual fields with safe defaults for missing keys
        alert_report_recipients = resource_data.get("alert_report_email", [])
        subscription = resource_data.get("username")          # OAuth account selector
        sender_email = resource_data.get('new_email')         # Authenticated sender
        send_alert_report = resource_data.get('send_alert_report', False)  # Kill-switch

        return alert_report_recipients, subscription, sender_email, send_alert_report
    except Exception as e:
        logger.error(f"Couldn't get email credentials: {e}")
        return [], None, None, False


async def init_gen_insight_report():
    """Generate the JSON insight report for all cameras for the current period.

    Retrieves the camera list and the set of configured alert types from
    MongoDB, then delegates to ``insight_report.generate_insight_report``.
    Both lists must be non-empty; if either is empty the function returns
    silently without generating a report (this is normal during initial
    deployment before cameras and alerts are configured).

    The insight report aggregates alert event statistics per camera into a
    structured JSON file written under ``<AKSHA_PATH>/reports/insight/``.

    Important fix note
    ------------------
    The guard is ``if db is None`` rather than ``if not db``.  See
    ``get_camera_list`` for the full explanation.
    """
    try:
        if db is None:  # Fix: Change 'if not db:' to 'if db is None:'
            return

        # Collect active cameras and defined alert types before generating
        cameras = await get_camera_list()
        # distinct("Alert_Name") returns all unique alert type strings
        alert_list = db.Alerts.distinct("Alert_Name") if db is not None else []

        if cameras and alert_list:
            # Delegate the actual file-writing to the insight_report module
            insight_report.generate_insight_report(
                aksha_path=aksha_path,
                cameras=cameras,
                db=db,
                logger=logger
            )
            logger.info("Insight report generated successfully")
    except Exception as e:
        logger.error(f"Error generating insight report: {e}")

async def init_gen_kpi_report():
    """Generate the JSON KPI report for all cameras for the current period.

    Mirrors ``init_gen_insight_report`` but calls the KPI report module.
    KPI reports include key performance indicators such as alert counts,
    camera uptime fractions, and detection-rate summaries.

    If either the camera list or the alert list is empty, the report is
    **skipped** and a log line is written at INFO level explaining why
    (cameras count and alerts count).  This distinguishes an intentional
    skip from a silent failure.

    Important fix note
    ------------------
    The guard is ``if db is None`` rather than ``if not db``.  See
    ``get_camera_list`` for the full explanation.
    """
    try:
        if db is None:  # Fix: Change 'if not db:' to 'if db is None:'
            return

        cameras = await get_camera_list()
        alert_list = db.Alerts.distinct("Alert_Name") if db is not None else []

        if cameras and alert_list:
            # Both pre-conditions met: generate and write the KPI JSON file
            kpi_report.generate_kpi_report(
                aksha_path=aksha_path,
                cameras=cameras,
                db=db,
                logger=logger
            )
            logger.info("KPI report generated successfully")
        else:
            # Log the skip reason so operators can distinguish "no data" from errors
            logger.info(f"KPI report skipped. Cameras: {len(cameras)}, Alerts: {len(alert_list)}")
    except Exception as e:
        logger.error(f"Error generating KPI report: {e}")

async def scheduled_reports():
    """Perpetual background coroutine that drives all timed report generation.

    This is the central scheduler for the service.  It wakes up every 60 seconds
    and evaluates three independent time-based conditions:

    1. **Hourly reports** (insight + KPI JSON)
       Fires when ``now.minute == 0`` and the current hour has not already been
       processed (``last_hour_checked`` guard prevents double-execution if the
       60 s tick happens to land on minute == 0 twice for the same hour).

    2. **Bi-monthly PDF report + e-mail**
       Fires on the 1st and 16th of every month at exactly 12:00:00 noon.
       Reads e-mail settings from MongoDB; skips silently if
       ``send_alert_report`` is False or the recipient list is empty.
       The full chain is: generate_pdf_report → email_gmail.

    3. **Midnight cleanup**
       Fires at 00:00 once per calendar day (guarded by ``last_cleanup_date``).
       Deletes insight and KPI report files older than 15 days to bound disk
       usage.

    The function never returns; exceptions inside each tick are caught and
    logged so that transient failures (network blip, MongoDB restart) do not
    crash the background task.

    State variables
    ---------------
    last_hour_checked : int
        Hour number (0–23) of the most recently processed hourly tick.
        Initialised to -1 so the first tick at any minute == 0 is always
        processed.
    last_cleanup_date : datetime.date | None
        Calendar date of the last successful cleanup run.  Prevents repeated
        deletions within the same midnight minute.
    """
    # Sentinels that prevent duplicate execution within the same time window
    last_hour_checked = -1
    last_cleanup_date = None

    while True:
        try:
            now = dt.datetime.now()

            # ── 1. Hourly reports ─────────────────────────────────────────
            # Trigger at the top of every hour exactly once (minute == 0 and
            # hour has not been handled yet in this cycle).
            if now.minute == 0 and now.hour != last_hour_checked:
                await init_gen_insight_report()
                await init_gen_kpi_report()
                # Record the hour so the next 60 s tick at minute == 0 is skipped
                last_hour_checked = now.hour
                logger.info(f"Hourly reports generated at {now}")

            # ── 2. Bi-monthly PDF report (days 1 & 16 at noon) ───────────
            if now.hour == 12 and now.minute == 0 and now.day in [1, 16]:
                # Fetch e-mail settings fresh each time in case they were
                # updated in MongoDB since the last run.
                alert_report_recipients, subscription, sender_email, send_alert_report = await get_senderemail_and_recipients()

                # Respect the operator-controlled kill-switch and require at
                # least one recipient address before proceeding.
                if send_alert_report and alert_report_recipients:
                    # Step 1: write the PDF to disk under aksha_path/reports/
                    success, isData, start_date, end_date = alert_report.generate_pdf_report(
                        todays_date=now,
                        aksha_path=aksha_path,
                        logger=logger
                    )

                    if success:
                        # Step 2: attach the generated PDF and send via Gmail OAuth
                        email_sent = await alert_report.email_gmail(
                            subscription=subscription,
                            recipients=alert_report_recipients,
                            sender_email=sender_email,
                            aksha_path=aksha_path,
                            start_date=start_date,
                            end_date=end_date,
                            isData=isData,
                            logger=logger
                        )

                        if email_sent:
                            logger.info(f"Bi-monthly PDF report sent to {alert_report_recipients}")
                        else:
                            logger.error("Failed to send bi-monthly email")
                    else:
                        logger.error("Failed to generate bi-monthly PDF report")

            # ── 3. Midnight cleanup ───────────────────────────────────────
            # Run once per day at 00:00 to delete reports older than 15 days,
            # keeping disk usage bounded without manual intervention.
            if now.hour == 0 and now.minute == 0 and last_cleanup_date != now.date():
                try:
                    # Delete old insight reports (15 days retention)
                    insight_report.del_insight_report(aksha_path, time_delta=15)
                    # Delete old KPI reports (15 days retention)
                    kpi_report.del_kpi_report(aksha_path, time_delta=15)
                    # Mark today so cleanup is not re-triggered in subsequent ticks
                    last_cleanup_date = now.date()
                    logger.info("Old reports cleaned up")
                except Exception as e:
                    logger.error(f"Error cleaning old reports: {e}")

        except Exception as e:
            # Catch-all: log and continue so the loop never dies on a single error
            logger.error(f"Error in scheduled reports: {e}")

        # Check every minute (like old version)
        # 60-second sleep balances responsiveness against CPU overhead.
        await asyncio.sleep(60)

# ── FastAPI lifespan ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan context manager – starts and tears down background tasks.

    Replaces the deprecated ``on_event("startup")`` / ``on_event("shutdown")``
    pattern.  Everything before ``yield`` runs on startup; everything after
    ``yield`` runs on shutdown.

    Startup
    -------
    * (Commented out) ``model_loader.initial_run()`` – was the original model
      training and loading step; disabled when service was repurposed.
    * (Commented out) ``hourly_task`` and ``daily_task`` – were the model
      refresh loops; disabled together with ModelLoader.
    * Creates ``report_task``: the ``scheduled_reports`` coroutine wrapped in
      an ``asyncio.Task`` so it runs concurrently with incoming HTTP requests.

    Shutdown
    --------
    * (Commented out) Cancels the old hourly and daily model loops.
    * Cancels ``report_task`` so the process exits cleanly without waiting for
      the next 60-second sleep to complete.
    """
    # model_loader.initial_run()
    # hourly_task = asyncio.create_task(model_loader.hourly_loop())
    # daily_task = asyncio.create_task(model_loader.daily_loop())

    # Launch the report scheduler as a background asyncio task.
    # The task runs concurrently with all HTTP request handlers.
    report_task = asyncio.create_task(scheduled_reports())
    yield
    # hourly_task.cancel()
    # daily_task.cancel()

    # Cancel the background scheduler on shutdown to release resources cleanly.
    report_task.cancel()

# ── FastAPI app instance ──────────────────────────────────────────────────────
# lifespan= wires up the async startup/shutdown hooks defined above.
app = FastAPI(lifespan=lifespan)

# ── Commented-out prediction endpoints ───────────────────────────────────────
# The two endpoints below (/predict_framebase and /predict_objectbase) were the
# original inference API consumed by the Aksha pipeline services.  They relied
# on model_loader.framebase_model and model_loader.objectbase_model being loaded
# in memory.  Both are disabled because ModelLoader is no longer instantiated.
#
# /predict_framebase: accepted a multipart form upload of a foreground image,
#   flattened it, ran model_loader.framebase_model.predict(), and returned
#   {"framebase_prediction": int}.
#
# /predict_objectbase: accepted a JSON PredictionRequest with a pre-extracted
#   feature vector, ran model_loader.objectbase_model.predict(), and returned
#   {"objectbase_prediction": int}.

# @app.post("/predict_framebase")
# async def predict_framebase(
#     frame_id: Annotated[str, Form()],
#     file: Annotated[UploadFile, File()],
#     timestamp_str: Annotated[str, Form()]
# ):
#     try:
#         print(f"frame_id {frame_id}", flush=True)
#         timestamp = dt.datetime.fromisoformat(timestamp_str)

#         image_bytes = await file.read()
#         image = Image.open(BytesIO(image_bytes))
#         frame = np.array(image)

#         foreground_flattened = np.expand_dims(frame.flatten(), axis=0)
#         framebase_model = model_loader.framebase_model

#         if framebase_model:
#             prediction = framebase_model.predict(foreground_flattened)[0]
#             print(f"frame anomaly prediction for frame captured at {timestamp} is: {prediction}",flush=True)
#             return {"framebase_prediction": prediction.item()}
#         else:
#             print("framebase model not loaded", flush=True)
#             raise HTTPException(status_code=500,detail="framebase model not loaded")

#     except Exception as e:
#         print(f"error faced on framebase_objectbase endpoint: {e}")
#         logger.info(f"error faced on framebase_objectbase endpoint: {e}")

# @app.post("/predict_objectbase")
# async def predict_objectbase(item: PredictionRequest):
#     try:
#         objectbase_model = model_loader.objectbase_model
#         print(f"objectbase model is {objectbase_model} timestamp {item.timestamp}",flush=True)
#         logger.info(f"objectbase model is {objectbase_model} timestamp {item.timestamp}")

#         if objectbase_model:
#             print(f"item frame_data {item.frame_data}", flush=True)
#             logger.info(f"item frame_data {item.frame_data}")
#             prediction = objectbase_model.predict(np.array(item.frame_data))[0]
#             print(f"object anomaly prediction for frame captured at {item.timestamp} is: {prediction}",flush=True)
#             logger.info(f"object anomaly prediction for frame captured at {item.timestamp} is: {prediction}")
#             return {"objectbase_prediction": prediction.item()}
#         else:
#             raise HTTPException(status_code=500,detail="objectbase model not loaded")

#     except Exception as e:
#         print(f"error faced on predict_objectbase endpoint: {e}")
#         logger.info(f"error faced on predict_objectbase endpoint: {e}")

# ── REST endpoints ────────────────────────────────────────────────────────────

# Report endpoints
@app.post("/generate_kpi_report")
async def generate_kpi_endpoint():
    """POST /generate_kpi_report – on-demand KPI report generation.

    Triggers an immediate KPI JSON report for the current day without waiting
    for the next scheduled hourly tick.  Intended for manual operator use or
    integration tests.

    Pre-conditions checked
    ----------------------
    * MongoDB must be connected (``db is not None``); returns HTTP 500 otherwise.
    * At least one camera and one alert type must exist in the database;
      returns ``{"status": "skipped"}`` if either list is empty.

    Returns
    -------
    dict
        ``{"status": "success", "report_type": "kpi_report", "message": ...}``
        on success, or ``{"status": "skipped", ...}`` when no data is found.

    Raises
    ------
    HTTPException 500
        If MongoDB is not connected or report generation raises an unhandled
        exception.
    """
    try:
        if db is None:  # Fix: Change 'if not db:' to 'if db is None:'
            raise HTTPException(status_code=500, detail="MongoDB not connected")

        # Retrieve current cameras and alert types as pre-condition guards
        cameras = await get_camera_list()
        alert_list = db.Alerts.distinct("Alert_Name") if db is not None else []

        if not cameras or not alert_list:
            # Return a structured skip response rather than an error; absence of
            # data is not a service fault.
            return {
                "status": "skipped",
                "message": "No cameras or alerts found"
            }

        # Delegate report file creation to the kpi_report module
        kpi_report.generate_kpi_report(
            aksha_path=aksha_path,
            cameras=cameras,
            db=db,
            logger=logger
        )

        logger.info("KPI report generated successfully")
        return {
            "status": "success",
            "report_type": "kpi_report",
            "message": "KPI report generated"
        }

    except Exception as e:
        logger.error(f"Error generating KPI report: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate KPI report: {str(e)}")

@app.post("/generate_insight_report")
async def generate_insight_endpoint():
    """POST /generate_insight_report – on-demand insight report generation.

    Triggers an immediate insight JSON report for the current day without
    waiting for the next scheduled hourly tick.  Mirrors
    ``generate_kpi_endpoint`` in structure and error handling.

    Pre-conditions checked
    ----------------------
    * MongoDB must be connected (``db is not None``); returns HTTP 500 otherwise.
    * At least one camera and one alert type must exist; returns
      ``{"status": "skipped"}`` if either list is empty.

    Returns
    -------
    dict
        ``{"status": "success", "report_type": "insight_report", ...}`` on
        success, or ``{"status": "skipped", ...}`` when no data is found.

    Raises
    ------
    HTTPException 500
        If MongoDB is not connected or report generation raises an unhandled
        exception.
    """
    try:
        if db is None:  # Fix: Change 'if not db:' to 'if db is None:'
            raise HTTPException(status_code=500, detail="MongoDB not connected")

        cameras = await get_camera_list()
        alert_list = db.Alerts.distinct("Alert_Name") if db is not None else []

        if not cameras or not alert_list:
            return {
                "status": "skipped",
                "message": "No cameras or alerts found"
            }

        # Delegate report file creation to the insight_report module
        insight_report.generate_insight_report(
            aksha_path=aksha_path,
            cameras=cameras,
            db=db,
            logger=logger
        )

        logger.info("Insight report generated successfully")
        return {
            "status": "success",
            "report_type": "insight_report",
            "message": "Insight report generated"
        }

    except Exception as e:
        logger.error(f"Error generating insight report: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate insight report: {str(e)}")


@app.post("/generate_pdf_report")
async def generate_pdf_report_endpoint(
    date: Annotated[Optional[str], Form()] = None
):
    """POST /generate_pdf_report – on-demand PDF alert report generation.

    Generates a PDF alert report covering the bi-monthly period that contains
    the requested date (defaults to *now* if ``date`` is omitted).

    The PDF report aggregates alert events, annotated frame snapshots, and
    summary statistics into a human-readable document stored under
    ``<AKSHA_PATH>/reports/pdf/``.

    Parameters
    ----------
    date : str, optional
        ISO-format datetime string (e.g. ``"2026-01-16T12:00:00"``) specifying
        the reference date for the report period.  Defaults to the current
        server time when not provided.

    Returns
    -------
    dict
        Fields: ``status`` ("success" | "no_data"), ``report_type``,
        ``message``, ``start_date``, ``end_date``, ``has_data``.

    Raises
    ------
    HTTPException 500
        If PDF generation fails or an unexpected exception is raised.
    """
    try:
        # Parse the optional date parameter; default to the current server time
        if date:
            report_date = dt.datetime.fromisoformat(date)
        else:
            report_date = dt.datetime.now()

        # generate_pdf_report returns a 4-tuple:
        #   success   – bool: whether the file was written without error
        #   isData    – bool: whether any alert data existed for the period
        #   start_date – beginning of the covered reporting window
        #   end_date   – end of the covered reporting window
        success, isData, start_date, end_date = alert_report.generate_pdf_report(
            todays_date=report_date,
            aksha_path=aksha_path,
            logger=logger
        )

        if not success:
            raise HTTPException(status_code=500, detail="Failed to generate PDF report")

        # Distinguish between "report written but empty" and "report with data"
        # so callers can decide whether to send it or surface a warning.
        return {
            "status": "success" if isData else "no_data",
            "report_type": "pdf_report",
            "message": "PDF report generated" if isData else "No data available for report",
            "start_date": start_date,
            "end_date": end_date,
            "has_data": isData
        }

    except Exception as e:
        logger.error(f"Error generating PDF report: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF report: {str(e)}")

@app.post("/send_report_email")
async def send_report_email(
    recipients: Annotated[List[str], Form()],
    date: Annotated[Optional[str], Form()] = None,
    subscription: Annotated[str, Form()] = "gmail"
):
    """POST /send_report_email – generate a PDF report and e-mail it.

    Combines the two steps that the scheduled bi-monthly task performs into a
    single on-demand endpoint:

    1. Generate the PDF report for the given date (or now).
    2. Send the PDF as an e-mail attachment to the caller-supplied recipient
       list via Gmail OAuth (``alert_report.email_gmail``).

    Parameters
    ----------
    recipients : List[str]
        One or more e-mail addresses to receive the report attachment.
    date : str, optional
        ISO-format datetime string for the report's reference date.  Defaults
        to the current server time.
    subscription : str, optional
        OAuth account selector passed to the Gmail helper (default: "gmail").
        The helper uses this to locate the correct stored OAuth token.

    Returns
    -------
    dict
        ``{"status": "success", "message": ..., "recipients": [...],
           "has_data": bool}`` on success.

    Raises
    ------
    HTTPException 500
        If PDF generation fails, e-mail sending fails, or any unhandled
        exception is raised.
    """
    try:
        # Parse optional date; fall back to now
        if date:
            report_date = dt.datetime.fromisoformat(date)
        else:
            report_date = dt.datetime.now()

        # First generate the PDF report
        # This writes the file to disk under aksha_path/reports/pdf/ so that
        # the email helper can read and attach it.
        success, isData, start_date, end_date = alert_report.generate_pdf_report(
            todays_date=report_date,
            aksha_path=aksha_path,
            logger=logger
        )

        if not success:
            raise HTTPException(status_code=500, detail="Failed to generate report for email")

        # Send email
        # email_gmail is an async coroutine; it picks up the PDF written above
        # and attaches it to an authenticated Gmail message.
        email_sent = await alert_report.email_gmail(
            subscription=subscription,
            recipients=recipients,
            sender_email="reports@aksha.ai",  # Static sender address for this endpoint
            aksha_path=aksha_path,
            start_date=start_date,
            end_date=end_date,
            isData=isData,
            logger=logger
        )

        if email_sent:
            return {
                "status": "success",
                "message": "Email sent successfully",
                "recipients": recipients,
                "has_data": isData
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to send email")

    except Exception as e:
        logger.error(f"Error sending report email: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send report email: {str(e)}")

@app.get("/health")
async def health_check():
    """GET /health – liveness and readiness probe.

    Returns a lightweight status snapshot consumed by container orchestration
    (Kubernetes liveness / readiness probes, Docker healthcheck, or monitoring
    dashboards).

    Response fields
    ---------------
    status : str
        Always ``"healthy"`` when the service is running (HTTP 200).  A non-200
        response from this endpoint indicates the process itself is unhealthy.
    timestamp : str
        ISO-format server time at the moment of the request.
    framebase_model_loaded : bool
        Whether ``model_loader.framebase_model`` is not None.  Reflects the
        state of the IsolationForest model for the current hour.
        NOTE: ``model_loader`` is currently commented out; this field will
        raise an error unless ModelLoader is re-enabled.
    objectbase_model_loaded : bool
        Whether ``model_loader.objectbase_model`` is not None.
        Same caveat as above.
    mongodb_connected : bool
        True when the MongoDB ``db`` object was successfully initialised at
        startup (``db is not None``).
    """
    return {
        "status": "healthy",
        "timestamp": dt.datetime.now().isoformat(),
        # model_loader attributes reflect whether anomaly models are in memory.
        # These will raise a NameError if ModelLoader remains commented out.
        "framebase_model_loaded": model_loader.framebase_model is not None,
        "objectbase_model_loaded": model_loader.objectbase_model is not None,
        # Simple connectivity indicator; does not perform a ping/round-trip check.
        "mongodb_connected": db is not None
    }

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Bind to all interfaces (0.0.0.0) so the container is reachable from the
    # host network and other services in the same Docker network.
    uvicorn.run(app, host="0.0.0.0", port=8000)
