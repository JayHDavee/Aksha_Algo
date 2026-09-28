"""
my_alert_filters — core alert-matching engine.

Entry point: apply_filter()

For every alert config in LIST_MYALERT_CONFIG, this module answers:
  "Given the objects detected in this frame, should this alert fire?"

Two alert types are distinguished by the No_Object_Status flag:
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  No_Object_Status = True  → "object-present" alert                      │
  │    Fire when the specified object IS detected in the area of interest.   │
  │    Example: "Person detected in restricted zone."                        │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  No_Object_Status = False → "no-object" alert                           │
  │    Fire when the expected object is NOT detected in its defined area.    │
  │    Example: "Worker absent from workstation."                            │
  └─────────────────────────────────────────────────────────────────────────┘

Decision pipeline per alert config:
  1. Day gate        — is today in alert_config["Days_Active"]?
  2. Time gate       — is current time between Start_Time and End_Time?
                       (special overnight logic when Start_Time > End_Time)
  3. Object filter   — collect detections whose label matches Object_Class
                       (for "crowd": collect all "person" detections instead)
  4. Area filter     — if Object_Area is defined, keep only objects whose
                       centroid (x + w/2, y + h/2) falls inside the polygon
  5. Crowd check     — for crowd alerts: only fire if count >= crowd_threshold
  6. Alert result    — append Alert_Name + full config to output lists
"""

from shapely.geometry import Polygon, Point
import datetime as dt


def apply_filter(LIST_MYALERT_CONFIG, object_detection_results, crowd_threshold, logger):
    """
    Evaluate all alert configs against the current frame's detections.

    Args:
      LIST_MYALERT_CONFIG      — list of alert config dicts from MongoDB (one per alert rule)
      object_detection_results — list of detection dicts [{label, x, y, w, h, confidence}, ...]
      crowd_threshold          — minimum person count to trigger a crowd alert
      logger                   — logger instance from the caller

    Returns:
      (alert_results, alert_result_config, no_object)
        alert_results       — list of triggered alert names
        alert_result_config — list of full config dicts for triggered alerts
        no_object           — True if any no-object alert fired across all configs
    """

    # Accumulate results across all alert configs in this camera's config list
    alert_results       = []   # alert names that fired this frame
    alert_result_config = []   # full config dicts for each fired alert
    no_object           = False  # becomes True if ANY no-object rule fires

    logger.info(
        f"apply_filter called | configs={len(LIST_MYALERT_CONFIG)} "
        f"| detections={len(object_detection_results) if object_detection_results else 0} "
        f"| crowd_threshold={crowd_threshold}"
    )

    # ── Iterate over each alert rule configured for this camera ──────────────
    for alert_config in LIST_MYALERT_CONFIG:
        filtered_objects  = []    # objects that pass both class + area filters for this rule
        no_object_status  = False # no-object flag for THIS config (aggregated into no_object at end)

        # ── GATE 1: Day check ─────────────────────────────────────────────────
        # Skip this rule entirely if today is not one of its active days.
        today = dt.datetime.now().strftime("%A")
        if today not in alert_config["Days_Active"]:
            continue

        # ── GATE 2: Time check (including overnight-spanning alerts) ──────────
        start_t = dt.datetime.strptime(alert_config["Start_Time"], '%H:%M').time()
        end_t   = dt.datetime.strptime(alert_config["End_Time"],   '%H:%M').time()
        now_t   = dt.datetime.now().time()

        if start_t > end_t:
            # ── Overnight alert: Start_Time > End_Time means the window crosses midnight.
            # Example: Start_Time=22:00, End_Time=06:00 → active from 22:00 today to 06:00 tomorrow.
            #
            # The config preprocessor (_check_overnight_alert in main.py) already split Days_Active
            # into two helper lists:
            #   "last_overnight_day"  → the next-day entries (00:00 → End_Time window)
            #   "first_day"           → the start-day entries (Start_Time → 23:59 window)
            #
            # We check which part of the overnight window we are in:
            if today in alert_config.get("last_overnight_day", []):
                # We are in the early-morning portion (00:00 → End_Time).
                # Only pass if current time is before End_Time.
                midnight = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).time()
                if not (midnight < now_t < end_t):
                    continue  # outside the early-morning window → skip this rule

            elif today in alert_config.get("first_day", []):
                # We are in the evening portion (Start_Time → 23:59).
                # Only pass if current time is after Start_Time.
                end_of_day = dt.datetime.now().replace(hour=23, minute=59, second=59, microsecond=0).time()
                if not (start_t < now_t < end_of_day):
                    continue  # before Start_Time → skip this rule

            else:
                # Middle day of a multi-day overnight alert — active the entire day.
                # Accept either the evening portion OR the early-morning portion.
                midnight    = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).time()
                end_of_day  = dt.datetime.now().replace(hour=23, minute=59, second=59, microsecond=0).time()
                in_evening  = (start_t < now_t < end_of_day)
                in_morning  = (midnight < now_t < end_t)
                if not (in_evening or in_morning):
                    continue  # outside both windows → skip this rule
        else:
            # ── Standard (non-overnight) alert: window is Start_Time → End_Time on the same day.
            if not (start_t < now_t < end_t):
                continue  # current time is outside the configured window → skip this rule

        # ── BRANCH: No_Object_Status determines which alert type to evaluate ──
        #
        # True  → object-present alert: fire when matching object IS in the frame/area
        # False → no-object alert:      fire when matching object is NOT in the area

        if alert_config["No_Object_Status"]:
            # ────────────────────────────────────────────────────────────────────
            # OBJECT-PRESENT ALERT (No_Object_Status = True)
            # Goal: fire if the specified object class is detected (optionally within
            # a defined area of interest).
            # ────────────────────────────────────────────────────────────────────
            try:
                if alert_config["Object_Area"]:
                    # ── Path A: Area-of-interest is defined ──────────────────────
                    # Only count objects whose centroid falls inside the polygon.
                    # The polygon is defined as a list of (x, y) vertex coordinates.
                    # We close the polygon by appending the first vertex again.
                    num_persons = 0  # used for crowd-threshold counting

                    for detection in object_detection_results:
                        is_target_class = (alert_config["Object_Class"] == detection["label"])
                        is_crowd_person = (alert_config["Object_Class"] == "crowd" and detection["label"] == "person")

                        if is_target_class or is_crowd_person:
                            # Close the polygon ring by appending the first vertex
                            area_points = list(alert_config["Object_Area"])
                            area_points.append(alert_config["Object_Area"][0])
                            polygon = Polygon(area_points)

                            # Use the centroid of the bounding box for the point-in-polygon test
                            centroid = Point(
                                detection["x"] + (detection["w"] / 2),
                                detection["y"] + (detection["h"] / 2)
                            )

                            if centroid.within(polygon):
                                filtered_objects.append(detection)
                                if is_crowd_person:
                                    num_persons += 1
                        # Objects of a different class are silently ignored

                    if filtered_objects:
                        # At least one matching object is inside the area of interest
                        if alert_config["Object_Class"] == "crowd":
                            if num_persons >= crowd_threshold:
                                # Crowd threshold reached → fire the alert
                                alert_filter_result = _build_alert_result(
                                    alert_config, filtered_objects, alert_config["Object_Area"]
                                )
                                alert_result_config.append(alert_filter_result)
                                alert_results.append(alert_config["Alert_Name"])
                            # else: crowd detected but below threshold → no alert
                        else:
                            # Non-crowd object detected inside area → fire the alert
                            alert_filter_result = _build_alert_result(
                                alert_config, filtered_objects, alert_config["Object_Area"]
                            )
                            alert_result_config.append(alert_filter_result)
                            alert_results.append(alert_config["Alert_Name"])

                else:
                    # ── Path B: No area of interest defined ──────────────────────
                    # Match any detection of the specified class anywhere in the frame.
                    num_persons = 0

                    for detection in object_detection_results:
                        if alert_config["Object_Class"] == detection["label"]:
                            filtered_objects.append(detection)
                        elif alert_config["Object_Class"] == "crowd" and detection["label"] == "person":
                            filtered_objects.append(detection)
                            num_persons += 1

                    if filtered_objects:
                        if alert_config["Object_Class"] == "crowd":
                            if num_persons >= crowd_threshold:
                                alert_filter_result = _build_alert_result(
                                    alert_config, filtered_objects, area=None
                                )
                                alert_result_config.append(alert_filter_result)
                                alert_results.append(alert_config["Alert_Name"])
                            # else: below threshold → no alert
                        else:
                            alert_filter_result = _build_alert_result(
                                alert_config, filtered_objects, area=None
                            )
                            alert_result_config.append(alert_filter_result)
                            alert_results.append(alert_config["Alert_Name"])

            except Exception as e:
                return f"apply_filter() failed (object-present alert): {e}"

        else:
            # ────────────────────────────────────────────────────────────────────
            # NO-OBJECT ALERT (No_Object_Status = False)
            # Goal: fire if the specified object is expected to be in the area but
            # is NOT detected there — e.g. "worker left their workstation".
            #
            # Requires an area of interest (Object_Area) to be meaningful.
            # no_object_status starts True (object absent) and is flipped to False
            # as soon as we find the object inside the area.
            # ────────────────────────────────────────────────────────────────────
            try:
                if not alert_config["Object_Area"]:
                    raise Exception(
                        "Object area not defined — no-object alerts require an area of interest."
                    )

                no_object_status = True   # assume absent until a matching detection is found
                num_persons = 0

                for detection in object_detection_results:
                    is_target_class = (alert_config["Object_Class"] == detection["label"])
                    is_crowd_person = (alert_config["Object_Class"] == "crowd" and detection["label"] == "person")

                    if is_target_class or is_crowd_person:
                        # Close the polygon ring
                        area_points = list(alert_config["Object_Area"])
                        area_points.append(alert_config["Object_Area"][0])
                        polygon = Polygon(area_points)

                        centroid = Point(
                            detection["x"] + (detection["w"] / 2),
                            detection["y"] + (detection["h"] / 2)
                        )

                        if centroid.within(polygon):
                            # Object IS present in the area → no-object alert should NOT fire
                            no_object_status = False
                            filtered_objects.append(detection)
                            if is_crowd_person:
                                num_persons += 1

                if no_object_status:
                    # Object was NOT found in the defined area → fire the no-object alert
                    if alert_config["Object_Class"] == "crowd" and num_persons >= crowd_threshold:
                        alert_filter_result = _build_alert_result(
                            alert_config, filtered_objects, alert_config["Object_Area"]
                        )
                        alert_result_config.append(alert_filter_result)
                        alert_results.append(alert_config["Alert_Name"])
                        return alert_results, alert_result_config, no_object

                    elif alert_config["Object_Class"] == "crowd" and num_persons < crowd_threshold:
                        pass  # crowd absent but below threshold — no alert

                    else:
                        alert_filter_result = _build_alert_result(
                            alert_config, filtered_objects, alert_config["Object_Area"]
                        )
                        alert_result_config.append(alert_filter_result)
                        alert_results.append(alert_config["Alert_Name"])
                        return alert_results, alert_result_config, no_object

            except Exception as e:
                return f"apply_filter() failed (no-object alert): {e}"

        # Propagate no_object_status for this config into the per-call aggregate
        no_object = no_object or no_object_status

    return alert_results, alert_result_config, no_object


# ── Helper ────────────────────────────────────────────────────────────────────

def _build_alert_result(alert_config: dict, filtered_objects: list, area) -> dict:
    """
    Assemble the standardised alert result dict from an alert config and its matched objects.

    This dict is appended to alert_result_config and forwarded downstream so that
    post_processor and notification services know exactly which alert fired and
    under what conditions.

    Args:
      alert_config     — full MongoDB config document for this alert rule
      filtered_objects — detections that passed both class and area filters
      area             — the area-of-interest polygon used (or None if whole-frame)
    """
    return {
        "Alert_Name":        alert_config["Alert_Name"],
        "Display_Activation": alert_config["Display_Activation"],
        # Workday / Holiday flags control which live-view thumbnail the alert is written to
        "Workday":           alert_config["Workday_Status"],
        "Holiday":           alert_config["Holiday_Status"],
        "Filtered_Objects":  filtered_objects,
        # No_Object_Status is forwarded so consumers know which alert type this is
        "No_Object_Status":  alert_config["No_Object_Status"],
        "Area_of_Interest":  area,
        "Email_Activation":  alert_config["Email_Activation"],
        "Alert_Description": alert_config["Alert_Description"],
    }
