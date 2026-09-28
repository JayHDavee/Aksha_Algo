"""
retention_service.py  —  Daily Data Retention Scheduler
=========================================================

Architecture Overview
----------------------

    ┌─────────────────────────────────────────────────────────────────┐
    │                  RETENTION SERVICE                              │
    │                                                                 │
    │  Environment variables                                          │
    │    AKSHA_PATH        → root of per-camera data directories      │
    │    MONGODB_URI       → connection string for Aksha database      │
    │    RETENTION_DAYS    → how many days of data to keep (default 10)│
    │                                                                 │
    │  Startup                                                        │
    │    └── pymongo.MongoClient  →  db["Aksha"]                      │
    │                                                                 │
    │  Every 24 hours  (RUN_INTERVAL_SECONDS)                         │
    │    ├── get_camera_list()                                         │
    │    │       └── db.config.distinct("Camera_Name")                 │
    │    │                                                             │
    │    └── for each camera_name:                                    │
    │            └── deletion.execute()          ← deletion.py        │
    │                    ├── MongoDB  DELETE  meta_<camera>            │
    │                    │           where Timestamp <= cutoff_date    │
    │                    └── Filesystem  RMTREE                        │
    │                            <AKSHA_PATH>/<camera>/frame/<date>/   │
    │                            <AKSHA_PATH>/<camera>/alerts/<date>/  │
    │                            <AKSHA_PATH>/<camera>/foreground/<date>/
    └─────────────────────────────────────────────────────────────────┘

Data lifecycle
--------------
The Aksha pipeline writes three categories of per-camera data:

  1. MongoDB collection  ``meta_<camera_name>``
       One document per processed frame with Timestamp, detection results,
       alert flags.  Queried by the insight / heatmap features.

  2. Filesystem  ``<AKSHA_PATH>/<camera>/frame/<YYYY-MM-DD>/``
       Raw (un-annotated) JPEG frames, throttled to ~1/30 s.  Used for
       heatmap generation and AutoAlert anomaly images.

  3. Filesystem  ``<AKSHA_PATH>/<camera>/alerts/<YYYY-MM-DD>/``
       Annotated JPEG alert images produced by process_detection.

  4. Filesystem  ``<AKSHA_PATH>/<camera>/foreground/<YYYY-MM-DD>/``
       Foreground / background model artefacts (optional, retained for
       completeness).

This service removes everything older than ``RETENTION_DAYS`` days from
all four locations, once every 24 hours.

Environment variables
---------------------
  AKSHA_PATH        str    Root directory of camera data.  Default: ``/Aksha``.
  MONGODB_URI       str    Full MongoDB connection URI.  Required.
  RETENTION_DAYS    int    Days of data to keep.  Default: ``10``.

Run schedule
------------
The service sleeps for exactly ``RUN_INTERVAL_SECONDS = 86400 s`` (24 h)
between cycles.  Data can therefore be at most ``RETENTION_DAYS + 1`` days
old before it is cleaned up on the next scheduled run.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import os       # environment variable access, path helpers
import time     # time.sleep for the 24-hour inter-cycle wait
import logging  # structured log output

# ── Third-party ───────────────────────────────────────────────────────────────
import pymongo                  # synchronous MongoDB client
from datetime import datetime   # cycle start-time measurement

# ── Internal modules ──────────────────────────────────────────────────────────
from deletion import execute    # per-camera deletion logic (MongoDB + filesystem)

# ══════════════════════════════════════════════════════════════════════════════
# Configuration — resolved once at module load from environment variables
# ══════════════════════════════════════════════════════════════════════════════

# Root path of all per-camera data directories on the host / shared volume.
# Trailing slash stripped to keep path joins clean.
AKSHA_PATH = os.getenv("AKSHA_PATH", "/Aksha").rstrip("/")

# Full MongoDB URI, e.g. "mongodb://mongo:27017".  Must be set in the
# docker-compose environment or k8s secret; no fallback intentionally so
# a missing URI causes a clear startup error rather than a silent no-op.
MONGODB_URI = os.getenv("MONGODB_URI")

# Number of days of data to retain.  Everything strictly older than this
# is deleted on each cycle.  Default 10 → keep the last 10 days.
RETENTION_DAYS = int(os.getenv("RETENTION_DAYS", 10))

# Sleep duration between retention cycles.  24 h means the oldest data
# can be at most RETENTION_DAYS + 1 days old at point of deletion.
RUN_INTERVAL_SECONDS = 24 * 60 * 60   # 86 400 seconds = 24 hours


# ══════════════════════════════════════════════════════════════════════════════
# Logger setup
# ══════════════════════════════════════════════════════════════════════════════

def setup_logger():
    """
    Configure and return the retention-service logger.

    Uses ``logging.basicConfig`` with a ``[RETENTION]`` tag prefix so log
    lines are easy to grep from aggregated container log streams.  Calling
    this more than once is safe — ``basicConfig`` is idempotent after the
    first call.

    Returns
    -------
    logging.Logger
        Logger named ``"retention_service"``.
    """
    logging.basicConfig(
        level=logging.INFO,
        # Format: <timestamp> [RETENTION] <LEVEL> <message>
        format="%(asctime)s [RETENTION] %(levelname)s %(message)s"
    )
    return logging.getLogger("retention_service")


# ══════════════════════════════════════════════════════════════════════════════
# Camera discovery
# ══════════════════════════════════════════════════════════════════════════════

def get_camera_list(db, logger):
    """
    Return the list of all registered camera names from MongoDB.

    Queries the ``config`` collection for all distinct ``Camera_Name`` values.
    This is the canonical source of truth for which cameras are active —
    any camera that has ever been configured appears here, even if it is
    currently offline.

    Why ``distinct`` instead of a full find?
    -----------------------------------------
    The ``config`` collection stores one document per camera.  Using
    ``distinct`` avoids deserialising full documents when only the name
    field is needed, and automatically deduplicates if duplicates exist.

    Parameters
    ----------
    db : pymongo.database.Database
        Connected ``Aksha`` database object.
    logger : logging.Logger
        Shared retention-service logger.

    Returns
    -------
    list[str]
        List of camera name strings.  Returns ``[]`` on any error so the
        caller's ``for`` loop is a safe no-op rather than raising.
    """
    try:
        cameras = db.config.distinct("Camera_Name")   # one round-trip to MongoDB
        logger.info(f"Camera list: {cameras}")
        return cameras
    except Exception as e:
        # Log and return empty list — partial failure is better than a full crash.
        # The next cycle will retry automatically.
        logger.error(f"Failed to fetch camera list: {e}")
        return []


# ══════════════════════════════════════════════════════════════════════════════
# Main entry point
# ══════════════════════════════════════════════════════════════════════════════

def main():
    """
    Start the retention service and run the cleanup loop indefinitely.

    Startup sequence
    ----------------
    1. Configure the logger.
    2. Connect to MongoDB with ``directConnection=True`` to bypass replica-set
       routing and always talk to the primary (important in single-node
       deployments where ``replicaSet`` is not configured).
    3. Enter the infinite ``while True`` loop.

    Per-cycle behaviour
    -------------------
    Each cycle:
      a. Fetches the current camera list from ``db.config``.
      b. Calls ``deletion.execute`` for every camera — this deletes stale
         MongoDB meta records AND stale filesystem date-folders.
      c. Logs the total wall-clock duration for the cycle.
      d. Sleeps for ``RUN_INTERVAL_SECONDS`` (24 h) before the next cycle.

    Per-camera errors are caught and logged individually so a single
    camera failure does not abort the rest of the cycle.

    Notes
    -----
    - ``directConnection=True`` is required for single-node MongoDB deployments
      that are not part of a replica set.  Remove it if connecting to a replica
      set or Atlas cluster.
    - The service is stateless — it derives the cutoff date from wall clock on
      each cycle, so no state file or database entry is needed.
    """
    # ── Stage 1: Logger ───────────────────────────────────────────────────────
    logger = setup_logger()
    logger.info("Retention Service started (7-day schedule)")

    # ── Stage 2: MongoDB connection ───────────────────────────────────────────
    # directConnection=True bypasses replica-set host discovery — necessary for
    # single-node docker-compose deployments without a replicaSet config.
    client = pymongo.MongoClient(
        MONGODB_URI,
        directConnection=True
    )
    db = client["Aksha"]   # all Aksha collections live in this database

    # ── Stage 3: Infinite retention loop ──────────────────────────────────────
    while True:
        start_time = datetime.now()   # measure wall-clock time for the full cycle
        logger.info("Starting retention cycle")

        # Fetch all active cameras from MongoDB config collection
        cameras = get_camera_list(db, logger)

        # Run per-camera deletion — MongoDB meta records + filesystem date folders
        for camera_name in cameras:
            try:
                execute(
                    DATABASE=db,             # Aksha database object
                    camera_name=camera_name, # e.g. "Camera_01"
                    data_dir=AKSHA_PATH,     # root of per-camera directories
                    time_delta=RETENTION_DAYS,  # keep last N days; delete everything older
                    logger=logger            # shared logger for consistent output
                )
            except Exception as e:
                # Per-camera failure: log and continue — do not abort the whole cycle
                logger.error(f"Retention failed for {camera_name}: {e}")

        # Log cycle duration for performance monitoring
        duration = (datetime.now() - start_time).total_seconds()
        logger.info(f"Retention cycle completed in {duration:.2f}s")

        # Sleep until the next daily cycle
        logger.info("Sleeping for 24 hours until next retention cycle")
        time.sleep(RUN_INTERVAL_SECONDS)   # 86 400 s = 24 h


# ══════════════════════════════════════════════════════════════════════════════
# Entrypoint
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    main()
