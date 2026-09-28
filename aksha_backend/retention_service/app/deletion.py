"""
deletion.py  —  Per-Camera Data Deletion Logic
===============================================

Architecture Overview
----------------------

    ┌──────────────────────────────────────────────────────────────────┐
    │  retention_service.py                                            │
    │       └── for each camera_name:                                  │
    │               └── deletion.execute(DATABASE, camera_name, ...)  │ ← THIS FILE
    └──────────────────────────────────────────────────────────────────┘

What ``execute`` deletes
------------------------
Given a ``time_delta`` of N days, everything strictly **older than N days**
is permanently removed from two locations:

  1. MongoDB collection  ``meta_<camera_name>``
     Documents where ``Timestamp <= cutoff_date`` are deleted.
     These records contain per-frame detection results, alert flags, and
     anomaly predictions used by the insight / heatmap features.

  2. Filesystem date-folders under three subdirectories:
       <data_dir>/<camera_name>/frame/<YYYY-MM-DD>/
       <data_dir>/<camera_name>/alerts/<YYYY-MM-DD>/
       <data_dir>/<camera_name>/foreground/<YYYY-MM-DD>/

     Any subfolder whose name parses as a ``date.fromisoformat`` value
     earlier than the cutoff day is removed with ``shutil.rmtree``.

Two-phase design
----------------
Phase 1 — MongoDB cleanup:
  ``delete_many`` removes all meta records with ``Timestamp <= cutoff_date``
  in a single round trip.  The deleted documents' ``Timestamp`` dates are
  collected into ``meta_dates`` (a set of ``date`` objects) for optional
  future use (e.g. cross-checking which filesystem dates had alert records).

Phase 2 — Filesystem cleanup:
  The filesystem walk is **independent** of the MongoDB results.  It directly
  scans the ``frame/``, ``alerts/``, and ``foreground/`` directories for
  date-named subfolders and removes any that predate the cutoff.

  Why independent?  Throttled insight frames (saved at most once per 30 s
  per camera) may have no corresponding MongoDB meta record if the retention
  service ran before those records were written.  Walking the filesystem
  directly ensures no stale date-folder is ever left behind.

Cutoff date calculation
-----------------------
  ``cutoff_date = datetime.now() - timedelta(days=time_delta)``

  Example (time_delta=10, today=2026-06-05):
    cutoff_date  = 2026-05-26  00:... (wall clock)
    cutoff_day   = 2026-05-26  (date only, for folder comparison)
    Deleted      = everything on or before 2026-05-25
    Kept         = 2026-05-26 onwards  (i.e. the last 10 full days + today)

Filesystem directory layout expected
--------------------------------------
  <data_dir>/
    <camera_name>/
      frame/
        2026-05-20/         ← deleted if older than cutoff_day
        2026-05-25/         ← kept
      alerts/
        2026-05-20/         ← deleted
        2026-05-25/         ← kept
      foreground/
        2026-05-20/         ← deleted
        2026-05-25/         ← kept
      live/                 ← NOT touched (current live images)
      spotlight/            ← NOT touched (current spotlight images)

Error handling
--------------
- MongoDB failure: logged, ``records`` defaults to ``[]``,
  filesystem cleanup still proceeds.
- ``shutil.rmtree`` called with ``ignore_errors=True`` so a locked or
  already-removed folder does not abort the rest of the cleanup.
- All exceptions in ``execute`` propagate to the caller, which catches
  them per-camera and logs them without aborting the retention cycle.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import os                        # path construction, scandir
import shutil                    # rmtree for recursive directory deletion
from datetime import timedelta   # cutoff_date = now - timedelta(days=N)
import datetime as dt            # dt.datetime.now(), dt.date.fromisoformat()
import logging                   # type hint for logger parameter


# ══════════════════════════════════════════════════════════════════════════════
# execute  —  the single public function of this module
# ══════════════════════════════════════════════════════════════════════════════

def execute(DATABASE, camera_name, data_dir, time_delta: int, logger):
    """
    Delete all data older than ``time_delta`` days for a single camera.

    This function is the workhorse of the retention service.  It is called
    once per camera per daily cycle by ``retention_service.main``.

    Two-phase cleanup
    -----------------
    **Phase 1 — MongoDB:**
      Queries ``meta_<camera_name>`` for documents where
      ``Timestamp <= cutoff_date``, collects their dates, then deletes them
      in a single ``delete_many`` call.

    **Phase 2 — Filesystem:**
      Scans three subdirectories (``frame/``, ``alerts/``, ``foreground/``)
      for date-named folders (``YYYY-MM-DD``).  Any folder whose date is
      strictly earlier than ``cutoff_day`` is removed with
      ``shutil.rmtree(ignore_errors=True)``.

      The filesystem walk is independent of the MongoDB results — it catches
      throttled insight frames that have no meta record.

    Parameters
    ----------
    DATABASE : pymongo.database.Database
        Connected ``Aksha`` MongoDB database object.
    camera_name : str
        Camera identifier (must match the ``Camera_Name`` field in MongoDB
        and the subdirectory name under ``data_dir``).
    data_dir : str
        Root path of per-camera data directories (``AKSHA_PATH``).
        E.g. ``"/data/Aksha"`` → camera dir = ``"/data/Aksha/Camera_01"``.
    time_delta : int
        Retention window in **days**.  Data strictly older than this is
        deleted.  E.g. ``10`` keeps the last 10 days and deletes everything
        from day 11 onwards.
    logger : logging.Logger
        Shared logger from ``retention_service``.

    Returns
    -------
    None
        Returns ``None`` on MongoDB collection lookup failure (early return).
        All other errors are logged; the function continues where possible.

    Side effects
    ------------
    - Deletes MongoDB documents from ``meta_<camera_name>``.
    - Deletes filesystem directories under ``<data_dir>/<camera_name>/``.
    - Writes log lines via ``logger`` at INFO and ERROR levels.
    """

    # ── Phase 0: Database collection lookup ──────────────────────────────────
    # Resolve the per-camera meta collection.  If the collection name is wrong
    # or the database is unreachable, bail early — nothing to clean up.
    try:
        COLLECTION_Meta = DATABASE[f"meta_{camera_name}"]   # e.g. "meta_Camera_01"
    except Exception as e:
        logger.error(f"Database connection issue: {e}")
        return   # cannot proceed without the collection handle

    logger.info(f"Deletion started for camera={camera_name}, retention_days={time_delta}")

    # ── Cutoff date calculation ───────────────────────────────────────────────
    # Build the file-system root for this camera.
    camera_dir_path = os.path.join(data_dir, camera_name)   # e.g. /Aksha/Camera_01

    # cutoff_date: everything with Timestamp <= this value will be deleted.
    # Using datetime.now() (not utcnow) because stored Timestamps are local time.
    cutoff_date = dt.datetime.now() - timedelta(days=time_delta)
    logger.info(f"Deleting data older than: {cutoff_date}")

    # cutoff_day: date-only version used for folder name comparison in Phase 2.
    cutoff_day = cutoff_date.date()   # e.g. datetime.date(2026, 5, 26)

    # ── Phase 1: MongoDB meta collection cleanup ──────────────────────────────
    # Delete all meta records whose Timestamp is on or before the cutoff.
    # We fetch records first (before deleting) so we can log the count and
    # collect the affected dates for cross-reference purposes.
    try:
        # Fetch matching records to count them and extract their dates.
        # NOTE: This is an in-memory list — for cameras with very large backlogs
        # this could be large; acceptable because retention only runs daily.
        records = list(COLLECTION_Meta.find({"Timestamp": {"$lte": cutoff_date}}))

        # Single-query bulk delete — more efficient than deleting one-by-one.
        COLLECTION_Meta.delete_many({"Timestamp": {"$lte": cutoff_date}})

        logger.info(f"DB records removed: {len(records)}")
    except Exception as e:
        # MongoDB failure: log and continue — filesystem cleanup can still run.
        logger.error(f"Meta DB deletion failed for {camera_name}: {e}")
        records = []   # empty list so meta_dates below is also empty

    # Collect the unique dates from deleted records — currently used for
    # logging context; could be used for targeted filesystem cleanup if needed.
    meta_dates = {i["Timestamp"].date() for i in records if "Timestamp" in i}

    # ── Phase 2: Filesystem cleanup ───────────────────────────────────────────
    # Walk the three per-camera subdirectories and delete any date-folder
    # whose name represents a date earlier than cutoff_day.
    #
    # Why walk the filesystem independently (not use meta_dates)?
    # Throttled insight frames (saved at most 1/30s per camera) may have no
    # corresponding MongoDB meta record — walking the filesystem directly
    # ensures those date-folders are cleaned up even if MongoDB had no record.

    for subdir in ("frame", "alerts", "foreground"):
        # Full path to the subdirectory, e.g. /Aksha/Camera_01/frame/
        dir_path = os.path.join(camera_dir_path, subdir)

        # Skip if this subdirectory does not exist for this camera
        if not os.path.isdir(dir_path):
            continue

        # Iterate over immediate children of the subdirectory.
        # os.scandir is more efficient than os.listdir as it avoids a second
        # stat() call per entry.
        for entry in os.scandir(dir_path):
            # Only process directories — skip loose files at the top level
            if not entry.is_dir():
                continue

            # Parse the directory name as a date.
            # Expected format: YYYY-MM-DD  (e.g. "2026-05-20")
            # Folders with non-date names (e.g. "tmp") are silently skipped.
            try:
                entry_date = dt.date.fromisoformat(entry.name)   # raises ValueError on bad format
            except ValueError:
                # Directory name is not a parsable date — leave it untouched
                continue

            # Delete date-folder if it is strictly older than the cutoff day.
            # "entry_date < cutoff_day" means the cutoff day itself is retained,
            # preserving today's and the boundary day's data intact.
            if entry_date < cutoff_day:
                # ignore_errors=True prevents a locked/race-condition failure
                # from aborting the rest of the folder scan.
                shutil.rmtree(entry.path, ignore_errors=True)
                logger.info(f"Deleted {entry.path}")

    logger.info(f"Deletion completed for camera={camera_name}")
