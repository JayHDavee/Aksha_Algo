"""
kpi_report.py
=============
Role
----
Generates a daily per-camera JSON KPI (Key Performance Indicator) report by
reading raw detection metadata stored in MongoDB meta collections.  Unlike the
alert-focused insight_report, the KPI report tracks *every* detected object
across *every* processed frame — alert filtering is intentionally absent.

Output file
-----------
One JSON file per calendar day, written to::

    <AKSHA_PATH>/kpi_report/<YYYY-MM-DD>.json

For example: ``/data/aksha/kpi_report/2024-06-04.json``

JSON structure per camera
-------------------------
The top-level object is keyed by camera name.  Each camera entry looks like::

    {
        "<camera_name>": {
            "camera_name": "<camera_name>",
            "date": "YYYY-MM-DD",
            "total_object_counts": {
                "<label>": <cumulative_count_across_all_frames>,
                ...
            },
            "frames": {
                "HH:MM:SS": {
                    "timestamp": "<ISO-8601 datetime string>",
                    "object_counts": {
                        "<label>": <count_in_this_frame>,
                        ...
                    },
                    "frame_link": "http://localhost:5000/<cam>/alerts/<date>/<date>%20<time>_alert.jpg"
                },
                ...
            }
        },
        ...
    }

Difference from insight_report
-------------------------------
* ``insight_report`` is alert-driven: it counts detections that crossed an
  alert threshold and were written to the Alerts collection.
* ``kpi_report`` is frame-driven: it counts *all* detected objects in every
  document stored in the per-camera ``meta_<cam>`` collection, regardless of
  whether an alert was raised.  This provides a raw activity baseline useful
  for occupancy analytics and trend monitoring.

File update strategy
--------------------
Uses the same merge-then-create pattern as insight_report:

1. If ``<YYYY-MM-DD>.json`` already exists and contains valid JSON, the new
   camera data is **merged** into it (``existing_data.update(cam_data)``),
   preserving previously written camera entries while overwriting stale ones.
2. If the file exists but contains invalid JSON it is **overwritten**.
3. If the file does not exist it is **created** fresh.

Retention
---------
``del_kpi_report(data_dir, time_delta)`` removes any ``<YYYY-MM-DD>.json``
files whose date is ``>= time_delta`` days in the past, keeping the report
directory from growing unbounded.
"""

import pymongo
import datetime
import json
import os
import logging

def generate_kpi_report(aksha_path, cameras, db, logger):
    """
    Build and persist a per-camera KPI JSON report for the current calendar day.

    For every camera in *cameras* the function iterates all documents in the
    ``meta_<camera>`` MongoDB collection.  Documents whose ``Timestamp`` field
    matches today's date are processed: detected object labels are counted per
    frame and also accumulated into a running total.  The resulting data
    structure is written (or merged) into ``<aksha_path>/kpi_report/<YYYY-MM-DD>.json``.

    Parameters
    ----------
    aksha_path : str
        Root path of the Aksha installation.  The report directory
        ``<aksha_path>/kpi_report/`` is created automatically if it does not
        already exist.
    cameras : list[str]
        List of camera identifiers (e.g. ``["cam1", "cam2"]``).  Each
        identifier must correspond to a MongoDB collection named
        ``meta_<identifier>``.
    db : pymongo.database.Database
        An open PyMongo database handle pointing at the Aksha MongoDB instance.
    logger : logging.Logger
        Application logger used for informational and error messages.

    Returns
    -------
    None
        The function returns nothing.  On any unrecoverable error the exception
        is caught and logged; partial results may or may not have been written.

    Side Effects
    ------------
    * Creates ``<aksha_path>/kpi_report/`` directory tree if absent.
    * Writes or updates ``<aksha_path>/kpi_report/<YYYY-MM-DD>.json``.

    Notes
    -----
    * Frame links point to the local Aksha media server on port 5000.  They
      will only resolve when that service is running on the same host.
    * If two frames for the same camera share the same ``HH:MM:SS`` timestamp,
      the later document will silently overwrite the earlier one in the
      ``frames`` dict.  This is consistent with insight_report behaviour.
    """

    # ------------------------------------------------------------------
    # Determine today's date string (YYYY-MM-DD).  Wrapped in try/except
    # so that a pathological system clock does not crash the whole caller.
    # ------------------------------------------------------------------
    try:
        date = str(datetime.datetime.now().date())
    except Exception as e:
        logger.info(f"Date error: {e}")
        return

    try:

        # Ensure the output directory exists; makedirs handles nested paths.
        path = f"{aksha_path}/kpi_report/"
        if not os.path.exists(path):
            os.makedirs(path)

        # cam_data will hold the final per-camera report blocks that get
        # serialised to JSON.  Keyed by camera name for easy dict.update() merge.
        cam_data = {}
        alert_col= db["Alerts"]  # Alerts collection reference (reserved for future use / cross-checks)

        # -------------------------------
        # Loop through cameras
        # -------------------------------
        # Process each camera independently so a failure in one camera does
        # not prevent the rest from being written.
        for cam in cameras:

            # Each camera has its own metadata collection: meta_<cam_name>
            cam_col = db[f"meta_{cam}"]

            # total_object_counts accumulates label frequencies across ALL
            # frames for this camera on today's date.
            total_object_counts = {}

            # frames holds per-frame data keyed by "HH:MM:SS" wall-clock time.
            # This lets the report consumer query "what was happening at 14:32:17?"
            frames = {}

            # -------------------------------
            # Read MongoDB data
            # -------------------------------
            # Full collection scan: find() returns every document in meta_<cam>.
            # Date filtering happens in Python because MongoDB stores Timestamps
            # as datetime objects and we only want today's documents.
            for doc in cam_col.find():

                # Timestamp field is a Python datetime stored by the ingestion pipeline.
                alert_timestamp = doc.get("Timestamp")
                if not alert_timestamp:
                    # Skip malformed documents that have no Timestamp.
                    continue

                # Extract just the date portion and compare to today's date string.
                alert_date = str(alert_timestamp.date())
                if alert_date != date:
                    # Document belongs to a different day; skip it.
                    continue

                # Format the time component as HH:MM:SS for use as the frames dict key.
                alert_time = alert_timestamp.strftime("%H:%M:%S")

                # Results is a list of detection dicts, each containing at minimum
                # a "label" key (e.g. "person", "car", "bicycle").
                results = doc.get("Results", [])

                # object_counts tallies label frequencies *for this single frame*.
                object_counts = {}

                for r in results:
                    label = r.get("label")
                    if label:
                        # Increment count for this label; default to 0 if first occurrence.
                        object_counts[label] = object_counts.get(label, 0) + 1


                # -------------------------------
                # Accumulate totals
                # -------------------------------
                # Merge this frame's per-label counts into the camera-level totals.
                # This running sum gives the "total_object_counts" for the whole day.
                for obj, count in object_counts.items():
                    total_object_counts[obj] = total_object_counts.get(obj, 0) + count

                # -------------------------------
                # Frame link
                # -------------------------------
                # Construct a URL pointing to the saved JPEG for this detection event.
                # The Aksha media server at localhost:5000 serves these frames.
                # URL-encoding: the space between date and time is represented as %20.
                frame_link = f"http://localhost:5000/{cam}/alerts/{alert_date}/{alert_date}%20{alert_time}_alert.jpg"

                # Store all per-frame fields under the HH:MM:SS key.
                # isoformat() gives a full "YYYY-MM-DDTHH:MM:SS" string suitable for
                # unambiguous parsing by any downstream consumer.
                frames[alert_time] = {
                    "timestamp": alert_timestamp.isoformat(),
                    "object_counts": object_counts,
                    "frame_link": frame_link
                }

            # -------------------------------
            # Camera JSON block
            # -------------------------------
            # Assemble the final report block for this camera.
            # Fields mirror the documented JSON schema in the module docstring.
            cam_data[cam] = {
                "camera_name": cam,
                "date": date,
                "total_object_counts": total_object_counts,  # cumulative across all frames today
                "frames": frames                              # per-frame breakdown keyed by HH:MM:SS
            }

        # -------------------------------
        # Write JSON file
        # -------------------------------
        # The target filename is simply today's date with a .json extension.
        filename = f"{date}.json"
        filepath = f"{path}{filename}"

        # Three-way file write strategy:
        #   1. File exists + valid JSON  → merge new camera data and rewrite
        #   2. File exists + corrupt JSON → overwrite with fresh data
        #   3. File does not exist        → create and write fresh data
        try:
            # Open for reading AND writing ("r+") without truncating existing content.
            with open(filepath, "r+") as file:
                try:
                    existing_data = json.load(file)          # attempt to parse existing content
                    existing_data.update(cam_data)            # merge: cam_data keys overwrite matching existing keys
                    file.seek(0)                              # rewind to start so we overwrite from the beginning
                    json.dump(existing_data, file, indent=4) # write merged data with readable indentation
                    logger.info("Object count report updated successfully")
                except json.JSONDecodeError:
                    # File exists but JSON is corrupt; overwrite entirely with fresh data.
                    json.dump(cam_data, file, indent=4)
                    logger.info("Object count report written (fresh JSON)")
        except FileNotFoundError:
            # File does not exist yet; create it and write the initial data.
            with open(filepath, "w") as file:
                json.dump(cam_data, file, indent=4)
                logger.info("Object count report file created")

    except Exception as e:
        # Catch-all for unexpected errors (e.g. MongoDB connection drop, disk full).
        logger.info(f"Object count report generation failed: {e}")

def del_kpi_report(data_dir, time_delta):
    """
    Delete KPI report JSON files that are older than *time_delta* days.

    Scans ``<data_dir>/kpi_report/`` for files named ``YYYY-MM-DD.json`` and
    removes any whose date is at least *time_delta* days before the current
    date.  Files that are newer than the threshold are left untouched.

    This function is typically called by the retention/housekeeping scheduler
    on a daily cadence to prevent unbounded disk usage in the kpi_report
    directory.

    Parameters
    ----------
    data_dir : str
        Root Aksha data directory.  The function looks for the sub-directory
        ``<data_dir>/kpi_report/``.
    time_delta : int
        Retention window in days.  Any file whose embedded date satisfies
        ``(today - file_date).days >= time_delta`` will be deleted.
        For example, ``time_delta=30`` removes files older than 30 days.

    Returns
    -------
    None
        On success the function returns implicitly.
    str
        If an outer exception is caught, an error string is returned describing
        the failure.  Callers should check the return value if they need to
        detect retention failures.

    Notes
    -----
    * ``logger`` is referenced inside the inner try/except blocks but is not
      passed as a parameter; this is a known issue in the current codebase —
      calls to ``logger.info`` inside this function will raise ``NameError``
      unless a module-level ``logger`` is defined by the import context.
    * Files that cannot be parsed as ``YYYY-MM-DD`` (the stem before the first
      ``.``) will raise a ``ValueError`` from ``strptime`` which propagates to
      the outer except and causes the function to return early with an error
      string.
    """

    try:

        # Check whether the kpi_report directory exists before attempting to list it.
        kpi_report_isexist= os.path.exists(f'{data_dir}/kpi_report/')
        if kpi_report_isexist:
            kpi_report_path=f"{data_dir}/kpi_report/"

            # Iterate every file in the kpi_report directory.
            # Expected filename pattern: "YYYY-MM-DD.json"
            for i in os.listdir(kpi_report_path):

                # Extract the date portion by splitting on "." and taking the first segment,
                # then parse it into a datetime object for arithmetic.
                file_date=datetime.datetime.strptime(f"{i.split('.')[0]}", "%Y-%m-%d")

                # Compare the file's date against today minus the retention window.
                # "days >= time_delta" means the file is AT LEAST time_delta days old.
                if ((datetime.datetime.now() - file_date).days) >= time_delta:
                    try:
                        os.remove(f"{data_dir}/kpi_report/{i}")
                        logger.info(msg= f"JSON file found for kpi report and successfully removed for date {i}! ")
                    except Exception as e:
                        # File may have already been removed by another process or
                        # permissions may have changed; log and continue to next file.
                        logger.info(msg= f"No Record found to remove kpi report file for date {i} with exception {e}!")
                else:
                    # File is within the retention window; leave it untouched.
                    continue
    except Exception as e:
       return f"kpi report deletion failed with exception: {e}"
