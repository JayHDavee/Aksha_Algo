"""
insight_report.py
==================
Role
----
Generate a **daily per-camera JSON insight report** from the ``meta_<camera>``
MongoDB collections.  The report summarises what the Aksha platform detected for
every registered camera on the current calendar date and is consumed by the
front-end dashboard and any downstream analytics tools.

Output file location
---------------------
::

    <AKSHA_PATH>/insight_report/<YYYY-MM-DD>.json

One file is produced per calendar date.  The filename uses ISO-8601 date format
so that lexicographic sort order equals chronological order.

JSON structure
--------------
The top-level JSON object is keyed by camera name.  Each camera's value is a
dict with the following keys:

.. code-block:: json

    {
        "<camera_name>": {
            "object_detection_alerts": {
                "<object_class>": <int>   // total detections for this class today
            },
            "total_alerts_generated": <int>,   // sum of all object_detection_alerts values
            "most_active_hour_for_each_object": {
                "<object_class>": <int>   // 0-23 hour with the highest detection count
            },
            "peak_alert_time_hour": <int | null>,  // busiest hour across all object classes
            "alerts": {
                "<HH:MM:SS.ffffff>": {
                    "object": "<object_class>",
                    "link": "<URL to alert image>",
                    "my_alert_name": ["<alert_name>"],
                    "timestamp": "<ISO datetime string>",
                    "no_obj_status": <bool>
                }
            }
        }
    }

File update strategy
---------------------
On each invocation the function attempts to **merge** new camera data into any
existing file for today's date:

1. If the file exists and contains valid JSON → read, update (merge) with new
   ``cam_data`` dict, seek to position 0, and overwrite.
2. If the file exists but its JSON is malformed (``JSONDecodeError``) → overwrite
   entirely with fresh ``cam_data`` (the corrupt content is discarded).
3. If the file does not exist (``FileNotFoundError``) → create a new file and
   write ``cam_data`` as its initial content.

Retention / cleanup
--------------------
:func:`del_insight_report` deletes any ``<YYYY-MM-DD>.json`` files whose date
is at least *time_delta* days in the past, keeping storage bounded.

"No person" remapping logic
-----------------------------
When an alert's object class is ``"person"`` **and** the alert's
``No_Object_Status`` flag is ``False``, the effective object class is remapped
to ``"no person"``.  This handles the "no person in zone" alert type where the
alert fires precisely because a person is *absent* rather than present.
"""

import pymongo
import datetime
import json
import os
import logging

def generate_insight_report(aksha_path, cameras, db, logger):
    '''
    Create a JSON file report with insights data for each day's alerts.

    Reads today's documents from each camera's ``meta_<cam>`` MongoDB collection,
    aggregates detection counts and hourly distributions, then writes (or merges)
    the results into a dated JSON file under ``<aksha_path>/insight_report/``.

    Parameters
    ----------
    aksha_path : str
        Root filesystem path for Aksha artefacts.  The insight report directory
        is created as ``<aksha_path>/insight_report/`` if it does not exist.
    cameras : list[str]
        List of camera name/ID strings whose data should be included in this
        report.  Typically fetched from the MongoDB ``Cameras`` collection by
        the caller.
    db : pymongo.database.Database
        Active PyMongo database handle.  Used to query both the ``Alerts``
        collection (for alert → object-class mappings) and each
        ``meta_<cam>`` collection (for per-frame detection records).
    logger : logging.Logger
        Logger instance supplied by the caller; used for INFO and exception
        messages so that this module does not need its own handler.

    Returns
    -------
    None
        All output is written to the JSON file on disk.  Exceptions are caught
        and logged rather than re-raised so that a failure for one camera does
        not abort the entire reporting run.

    Side-effects
    ------------
    - Creates ``<aksha_path>/insight_report/`` directory tree if absent.
    - Writes or updates ``<aksha_path>/insight_report/<YYYY-MM-DD>.json``.

    Notes
    -----
    Inputs: aksha_path: path of the working directory, cameras: list of cameras fetched from MongoDB
            db: database connection, date: date for which the report is to be generated,
    Output: cam_data: dictionary in which all the insights data is stored
    '''
    try:
        # Capture today's date as a string (YYYY-MM-DD) once so that all
        # comparisons within this invocation use a consistent reference point.
        date= str(datetime.datetime.now().date())
    except Exception as e:
        logger.info(msg=f"Inside generate_obj_report: the following error occured in the first try block: {e}")

    try:
        # Resolve the report directory path and create it if necessary.
        # All dated JSON files live directly inside this flat directory.
        path=f"{aksha_path}/insight_report/"
        if not os.path.exists(path):
            os.makedirs(path)

        # cam_data accumulates the final per-camera insight dicts that will
        # be serialised to JSON at the end of the function.
        cam_data={}

        # most_active_hour_data will be populated per-camera inside the loop;
        # declared here at outer scope so the variable exists before the loop.
        most_active_hour_data={}

        # cam_alerts maps camera_name → list of {alert_name: object_class} dicts.
        # Built once from the Alerts collection so the lookup is shared across
        # all per-document iterations below.
        cam_alerts={}

        # Access the global Alerts collection (shared across cameras).
        alert_col= db["Alerts"]

        # no_obj_status_for_alert maps alert_name → No_Object_Status (bool).
        # Used during the "no person" remapping step inside the inner loop.
        no_obj_status_for_alert={}

        for cam in cameras:
            # Initialise this camera's alert list to an empty list before scanning.
            cam_alerts[cam]=[]

            # cam_alerts: contains a dictionary  of all alerts in db, camera wise
            for al in alert_col.find():
                # Only include alerts that are configured for this camera.
                if cam in al["Camera_Name"]:
                    # Store as {alert_name: object_class} so that a later lookup
                    # by alert name immediately yields the associated object class.
                    al_dict={al["Alert_Name"]:al["Object_Class"]}
                    cam_alerts[cam].append(al_dict)
                    # Capture the No_Object_Status flag keyed by alert name for
                    # fast retrieval during the "no person" remapping step.
                    no_obj_status_for_alert[al["Alert_Name"]]=al["No_Object_Status"]


            # Access this camera's meta collection (one document per processed frame).
            cam_col = db[f"meta_{cam}"]

            # obj_dict accumulates: object_class → total detection count for today.
            # This directly populates the "object_detection_alerts" output field.
            obj_dict = {}

            # temp accumulates: object_class → {hour(0-23): count}.
            # Used to derive most_active_hour_for_each_object and peak_alert_time_hour.
            temp = {}

            # all_alerts accumulates: time_string → alert detail dict.
            # Provides the per-alert drill-down data in the output JSON.
            all_alerts={}

            for x in cam_col.find():
                # Extract the wall-clock timestamp from the document.
                alert_timestamp = x["Timestamp"]
                # Convert to a date string for comparison with today's date.
                alert_date = str(alert_timestamp.date())

                # Only process documents that belong to today's date.
                if str(alert_date) == str(date):
                    # Separate the time component; used for hour-bucket aggregation
                    # and as a key in the all_alerts dict.
                    alert_time = alert_timestamp.time()

                    # Iterate over each alert name recorded in this frame document.
                    for i in x["Alerts"]:
                        # Check whether this alert name exists in the camera's configured alerts.
                        for j in cam_alerts[cam]:

                            if i in j:
                                # Resolve the object class associated with this alert name.
                                obj_class=next(item[i] for item in cam_alerts[cam] if i in item)
                                my_alert=i
                            # Calculating object_detection_alerts for each camera
                                if(obj_class=="person" and no_obj_status_for_alert[my_alert]==False):   # if the no person alert is set the object class will be no person
                                    # "No person" remap: the alert fires because a person is ABSENT
                                    # (No_Object_Status=False).  Re-label so the dashboard shows the
                                    # correct intent rather than a positive detection.
                                    obj_class="no person"

                                # Increment the running count for this object class.
                                # dict.get with default 0 avoids a KeyError on first occurrence.
                                obj_dict[obj_class] = obj_dict.get(obj_class, 0) + 1

                            # Calculating and storing most_active_hour_for_each_object for each camera
                                if obj_class not in temp:
                                    # First detection for this object class: initialise all 24 hour
                                    # buckets to 0 so that max() comparisons are always valid.
                                    temp[obj_class] = {h: 0 for h in range(24)}  # Initialize hour count to 0 for each label

                                # Determine which hour bucket this detection falls into (0-23).
                                alert_hour = alert_time.hour
                                temp[obj_class][alert_hour] += 1  # Increment count for the respective hour

                                # Build the URL pointing to the saved alert image on the local
                                # media server; used by the front-end to render alert thumbnails.
                                link= f"http://localhost:5000/{cam}/alerts/{alert_date}/{alert_date}%20{alert_time}_alert.jpg"

                                # Store all relevant metadata for this individual alert occurrence.
                                # Keyed by the time string so that multiple alerts at the same
                                # second will overwrite (last-writer-wins) rather than duplicate.
                                all_alerts[f"{alert_time}"]={
                                    "object":obj_class,
                                    "link":link,
                                    "my_alert_name": [my_alert],
                                    "timestamp": str(alert_timestamp),
                                    "no_obj_status": no_obj_status_for_alert[my_alert]
                                }

                    # After processing each document, recompute peak-hour statistics
                    # so they reflect all detections seen up to and including this frame.
                    most_active_hour_data = {}
                    peak_hour = None      # Will hold the globally busiest hour (int 0-23).
                    max_alerts = 0        # Running maximum count used to track peak_hour.

                    for obj_class, hour_counts in temp.items():

                        max_hour = max(hour_counts, key=hour_counts.get)  # Get max hour value
                        # Record which hour had the most detections for this specific object class.
                        most_active_hour_data[obj_class] = max_hour  # Set the max hour as value for the label in hour_data


                        # Calculating and storing peak_alert_time for each camera
                        # Update the global peak if this object class's busiest hour has
                        # more detections than the current overall maximum.
                        if hour_counts[max_hour] > max_alerts:

                            peak_hour = max_hour
                            max_alerts = hour_counts[max_hour]

                    # Assemble this camera's insight summary dict.
                    # total_alerts_generated is the sum of all per-class detection counts.
                    cam_data[cam] = {
                        "object_detection_alerts": obj_dict,
                        "total_alerts_generated": sum(obj_dict.values()),
                        "most_active_hour_for_each_object": most_active_hour_data,
                        "peak_alert_time_hour": peak_hour,
                        "alerts": all_alerts
                    }

        # Build the dated filename and its full path inside the report directory.
        filename = str(date) + '.json'
        filepath= f"{path}{filename}"

        # Three-way file update strategy:
        #   1. File exists and valid JSON  → merge cam_data into existing data.
        #   2. File exists but corrupt JSON → overwrite with fresh cam_data.
        #   3. File does not exist         → create a new file with cam_data.
        try:
            # Attempt to open the file for reading and writing (r+ does not truncate).
            with open(filepath, 'r+') as file:
                try:
                    # Load existing content; update adds / overwrites camera keys.
                    existing_data = json.load(file)
                    existing_data.update(cam_data)
                    # Seek back to the beginning so the merged content overwrites
                    # the old bytes rather than being appended after them.
                    file.seek(0)
                    json.dump(existing_data, file, indent=4)
                    logger.info(msg=f"Inside generate_obj_report: Data overwritten successfully.")
                except json.JSONDecodeError:
                    # The existing file is not valid JSON (e.g. partially written).
                    # Fall back to writing fresh data from scratch.
                    json.dump(cam_data, file, indent=4)
                    logger.info(msg=f"Inside generate_obj_report: New data added successfully.")
        except FileNotFoundError:
            # No file exists yet for today's date; create it fresh.
            with open(filepath, 'w') as file:

                json.dump(cam_data, file, indent=4)
                logger.info(msg=f"Inside generate_obj_report: New file created and data added successfully.")

    except Exception as e:
        logger.info(msg=f"Inside generate_obj_report: Following exception occurred in the second try block: {e}")



def del_insight_report(data_dir, time_delta):
    """Delete insight report JSON files that are older than *time_delta* days.

    Iterates over every ``*.json`` file in ``<data_dir>/insight_report/``,
    parses the filename as a ``YYYY-MM-DD`` date, and removes any file whose
    age (in whole days) is greater than or equal to *time_delta*.

    Parameters
    ----------
    data_dir : str
        Root Aksha data directory (same value as ``AKSHA_PATH``).  The function
        looks for the ``insight_report/`` subdirectory inside this path.
    time_delta : int
        Retention period in days.  Files dated *time_delta* or more days before
        today will be deleted.  For example, ``time_delta=30`` keeps the most
        recent 29 days of reports.

    Returns
    -------
    None
        Returns ``None`` on success.  Returns a descriptive error string if the
        top-level try block catches an unexpected exception, allowing the caller
        to log the failure without the whole process crashing.

    Side-effects
    ------------
    - Removes files from ``<data_dir>/insight_report/`` on disk.
    - Writes INFO log messages for each successfully deleted file and for any
      per-file removal errors (via the module-level ``logger``).

    Notes
    -----
    Files that cannot be parsed as ``YYYY-MM-DD`` dates will cause a
    ``ValueError`` / ``strptime`` error; these are not currently handled and
    will propagate to the outer ``except`` block, returning an error string.
    """

    try:
        # Check whether the insight_report directory even exists before attempting
        # to list its contents; avoids a FileNotFoundError on clean installations.
        insight_report_isexist= os.path.exists(f'{data_dir}/insight_report/')
        if insight_report_isexist:
            insight_report_path=f"{data_dir}/insight_report/"

            # Iterate over every filename in the flat insight_report directory.
            for i in os.listdir(insight_report_path):

                # Parse the date from the filename stem (everything before the first '.').
                # Expected format: "YYYY-MM-DD.json" → stem "YYYY-MM-DD".
                file_date=datetime.datetime.strptime(f"{i.split('.')[0]}", "%Y-%m-%d")

                # Calculate the age of this file in whole days.
                # If the age meets or exceeds the retention threshold, delete the file.
                if ((datetime.datetime.now() - file_date).days) >= time_delta:
                    try:
                        os.remove(f"{data_dir}/insight_report/{i}")
                        logger.info(msg= f"JSON file found for insight report and successfully removed for date {i}! ")
                    except Exception as e:
                        # Per-file removal failure (e.g. permissions); log and continue
                        # so that the remaining files are still processed.
                        logger.info(msg= f"No Record found to remove insight report file for date {i} with exception {e}!")
                else:
                    # File is within the retention window; leave it untouched.
                    continue
    except Exception as e:
       return f"Insight report deletion failed with exception: {e}"
