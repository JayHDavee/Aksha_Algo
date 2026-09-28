"""
annotate.py  —  OpenCV Drawing Helpers for the Post-Processor Pipeline
=======================================================================

Role in the pipeline
--------------------
This module provides the two drawing functions called by ``process_detection``
in ``main.py`` to produce annotated camera frames:

- ``draw_labels``  — plain detection path (no alert fired).
  Draws green bounding boxes and red class labels for every detected object.

- ``draw_filter``  — alert annotation path (my_alert or no_object alert fired).
  Draws user-defined area-of-interest polygons, filtered-object boxes, and
  alert indicator badges onto up to three output frames (processed, workday,
  holiday) based on per-alert ``Display_Activation``, ``Workday``, and
  ``Holiday`` config flags.

Frame coordinate system
-----------------------
All input frames are expected to have been resized to **640 × 360** pixels by
``process_detection`` before being passed here.  Bounding-box coordinates
(``x``, ``y``, ``w``, ``h``) are therefore in that coordinate space.

Alert indicator badge layout
-----------------------------
When an alert fires, two overlaid shapes are drawn in the top-right corner of
the frame to give a visible "alert active" indicator:

  - A blue-filled right-triangle  (top-right corner, 600–650 × 0–50 px).
  - An orange-filled rectangle    (above the first area-of-interest point).
  - A white ``"No person"`` label inside the orange rectangle.

Color conventions
-----------------
  - Green  ``(0, 255, 0)``     — detected-object bounding boxes
  - Red    ``(0, 0, 255)``     — class label text, alert indicator triangle
  - Blue   ``(255, 0, 0)``     — area-of-interest polygon (object-present alert)
  - Orange ``(252, 119, 62)``  — area-of-interest polygon (no-object alert) +
                                  alert badge rectangle
  - White  ``(255, 255, 255)`` — badge label text

Error-return convention
-----------------------
Both functions catch individual drawing exceptions and log them.  ``draw_filter``
may return a plain **error string** instead of the expected tuple when a fatal
OpenCV call fails; callers should check the return type before unpacking.
"""

import cv2
import numpy as np


def draw_labels(original_img, object_labels, classes, logger):
    """
    Draw bounding boxes and class labels for all detected objects on a plain
    (no-alert) frame.

    Called by ``process_detection`` when ``alert_results`` and
    ``no_object_status`` are both falsy — i.e. the frame triggered no alert
    and is being annotated only with raw detection results.

    Drawing conventions
    -------------------
    - Bounding box  — 1-pixel green rectangle ``(0, 255, 0)``.
    - Class label   — red text ``(0, 0, 255)``, placed 6 pixels above the top
      edge of the bounding box using ``cv2.FONT_HERSHEY_SIMPLEX`` at scale 0.5.

    Parameters
    ----------
    original_img : np.ndarray
        BGR frame to annotate (640 × 360 expected).  Not mutated — a copy is
        made internally.
    object_labels : list[dict]
        Detection results, each dict containing:
        - ``label`` (str)  : COCO class name
        - ``x``, ``y``     : top-left corner of the bounding box (pixels)
        - ``w``, ``h``     : width and height of the bounding box (pixels)
    classes : list[str]
        COCO class name list (loaded from ``coco.names``).  Not used directly
        here but passed for API consistency; the ``label`` field in each
        detection dict is already resolved.
    logger : logging.Logger
        Shared logger from ``KafkaService``.

    Returns
    -------
    np.ndarray
        Annotated copy of ``original_img`` with bounding boxes and labels
        drawn on all detected objects.

    Notes
    -----
    If an individual object fails to draw (e.g. coordinates out of range) the
    exception is caught and logged, and drawing continues with the next object.
    If the final copy step fails a fallback string is returned — callers should
    guard against this edge case.
    """
    logger.info(f"draw_labels | objects_to_draw={len(object_labels) if object_labels else 0}")
    img = original_img.copy()

    for i in object_labels:
        label = i["label"]
        x = i["x"]
        y = i["y"]
        w = i["w"]
        h = i["h"]
        try:
            # Stage: draw bounding box in green
            img = cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0), 1)
            # Stage: draw class label in red above the box
            img = cv2.putText(
                img, label, (x, y - 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA
            )
        except Exception as e:
            logger.info(f"draw_labels: issue drawing label='{label}': {e}")

    try:
        obd_result = img.copy()
        logger.info("draw_labels complete")
        return obd_result
    except Exception as e:
        logger.info(f"draw_labels: issue finalising result: {e}")
        return "Object Anomaly processing got failed..."


def draw_filter(LIST_Alert_Config, result_img, check, logger):
    """
    Draw user-defined alert zones and filtered objects onto three output frames
    (processed / workday / holiday) based on alert configuration flags.

    Called by ``process_detection`` for both the ``my_alert`` and ``no_object``
    annotation branches.  Each call processes a list of alert config documents
    (one per active alert rule) and produces three independently annotated frame
    copies so the frontend can select the appropriate view for workday vs.
    holiday schedules.

    Alert config document fields used
    ----------------------------------
    - ``Alert_Name``         (str)   : human-readable alert identifier (for logging)
    - ``No_Object_Status``   (bool)  : ``True`` = no-object alert; ``False`` = detection
    - ``Area_of_Interest``   (list)  : polygon vertex list (``[[x,y], ...]``) defining
                                       the monitored zone
    - ``Filtered_Objects``   (list)  : detection dicts (``{x,y,w,h,label}``) that
                                       matched the alert rule inside the zone
    - ``Display_Activation`` (bool)  : master switch — if ``False``, workday/holiday
                                       frames are not annotated for this rule
    - ``Workday``            (bool)  : draw on ``workday_frame`` when ``True``
    - ``Holiday``            (bool)  : draw on ``holiday_frame`` when ``True``

    Output frames
    -------------
    - ``processed_frame``  — always annotated; used for alert image file saved to
                             ``<camera>/alerts/<date>/``.
    - ``workday_frame``    — annotated only when ``Display_Activation`` and
                             ``Workday`` are both ``True`` for a given rule.
    - ``holiday_frame``    — annotated only when ``Display_Activation`` and
                             ``Holiday`` are both ``True`` for a given rule.

    The ``flag`` variable
    ---------------------
    Set to ``True`` when ``No_Object_Status == False`` (i.e. this is a
    detection-based alert where an unexpected object *was* found).  Controls
    the polygon colour: orange when ``flag=True``, blue otherwise.

    Alert indicator badge
    ---------------------
    A blue right-triangle is always placed at the top-right corner of the frame
    to signal "alert active".  For no-object alerts (``check == "no_object"``)
    or detection alerts with ``flag=True``, an additional orange label badge is
    drawn above the first vertex of the area-of-interest polygon.

    Parameters
    ----------
    LIST_Alert_Config : list[dict]
        List of alert configuration documents for active alerts on this frame,
        as stored in the ``Alerts`` MongoDB collection.
    result_img : np.ndarray
        BGR source frame (640 × 360) to annotate.  Three copies are made
        internally; the original is not mutated.
    check : str
        Alert type string from ``process_detection``.  Used to decide badge
        label — ``"no_object"`` draws ``"No person"``; other values draw the
        same but only when ``flag`` is set.
    logger : logging.Logger
        Shared logger from ``KafkaService``.

    Returns
    -------
    tuple[np.ndarray, np.ndarray, np.ndarray]
        ``(processed_frame, workday_frame, holiday_frame)`` — three annotated
        BGR frames.

    str
        An error message string is returned instead of the tuple if a fatal
        OpenCV exception occurs (``cv2.polylines``, ``cv2.rectangle``, etc.).
        Callers should check ``isinstance(result, tuple)`` before unpacking.
    """
    logger.info(
        f"draw_filter | alert_configs={len(LIST_Alert_Config)} | check={check} "
        f"| frame_shape={result_img.shape}"
    )

    processed_frame = result_img.copy()
    workday_frame = result_img.copy()
    holiday_frame = result_img.copy()

    for idx, i in enumerate(LIST_Alert_Config):
        # flag = True  →  detection-based alert (unexpected object found inside zone)
        # flag = False →  no-object alert (expected object absent from zone)
        # Controls polygon colour: orange when flag=True, blue otherwise.
        flag = False
        logger.info(
            f"draw_filter config [{idx}] | Alert_Name={i.get('Alert_Name')} "
            f"| No_Object_Status={i.get('No_Object_Status')} "
            f"| Workday={i.get('Workday')} | Holiday={i.get('Holiday')} "
            f"| Display_Activation={i.get('Display_Activation')}"
        )
        try:
            # Stage: draw area-of-interest polygon on processed_frame.
            # Color is blue (255,0,0) for no-object alerts; orange (252,119,62)
            # for detection-based alerts (No_Object_Status=False).
            try:
                if i["Area_of_Interest"]:
                    color = (255, 0, 0)
                    thickness = 2
                    if i["No_Object_Status"] == False:
                        flag = True
                        color = (252, 119, 62)
                        thickness = 1
                    pts = np.array(i["Area_of_Interest"], np.int32)
                    logger.info(f"Drawing area-of-interest polygon | alert={i.get('Alert_Name')} | pts_count={len(pts)} | flag={flag}")
                    isClosed = True
                    processed_frame = cv2.polylines(processed_frame, [pts], isClosed, color, thickness)
            except Exception as e:
                return f"draw_filter() failed on cv2.polylines: {e}"

            # Stage: draw filtered (matched) object bounding boxes and labels on processed_frame.
            # These are the specific detections that triggered the alert rule (objects inside zone).
            try:
                if i["Filtered_Objects"]:
                    logger.info(f"Drawing {len(i['Filtered_Objects'])} filtered objects | alert={i.get('Alert_Name')}")
                    for j in i["Filtered_Objects"]:
                        processed_frame = cv2.rectangle(
                            processed_frame,
                            (j["x"], j["y"]), (j["x"] + j["w"], j["y"] + j["h"]),
                            (0, 255, 0), 1
                        )
                        processed_frame = cv2.putText(
                            processed_frame, j["label"], (j["x"], j["y"] - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA
                        )

                # Stage: draw alert indicator badge in top-right corner of processed_frame.
                # Blue right-triangle signals "alert active"; orange label badge near the
                # zone's first vertex indicates the specific alert condition.
                if check == "no_object":
                    # No-object alert badge: triangle + orange rectangle + "No person" text
                    points = np.array([[650, 0], [650, 50], [600, 0]])
                    polygon = np.array([
                        [int(pts[0][0]), int(pts[0][1] - 2)],
                        [int(pts[0][0]), int(pts[0][1] - 20)],
                        [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                        [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                    ])
                    try:
                        processed_frame = cv2.fillPoly(processed_frame, pts=[points], color=(0, 0, 255))
                        processed_frame = cv2.fillPoly(processed_frame, pts=[polygon], color=(252, 119, 62))
                        processed_frame = cv2.putText(
                            processed_frame, "No person", (pts[0][0], pts[0][1] - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                        )
                        logger.info(f"No-person badge drawn | alert={i.get('Alert_Name')}")
                    except Exception as e:
                        logger.info(f"draw_filter: no-person badge draw failed: {e}")
                else:
                    # Detection-based alert badge: blue triangle always; orange badge only when flag=True
                    points = np.array([[650, 0], [650, 50], [600, 0]])
                    processed_frame = cv2.fillPoly(processed_frame, pts=[points], color=(0, 0, 255))
                    if flag:
                        try:
                            polygon = np.array([
                                [int(pts[0][0]), int(pts[0][1] - 2)],
                                [int(pts[0][0]), int(pts[0][1] - 20)],
                                [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                                [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                            ])
                            processed_frame = cv2.fillPoly(processed_frame, pts=[polygon], color=(252, 119, 62))
                            processed_frame = cv2.putText(
                                processed_frame, "No person", (pts[0][0], pts[0][1] - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                            )
                            logger.info(f"Alert badge drawn on processed_frame | alert={i.get('Alert_Name')}")
                        except Exception as e:
                            logger.info(f"draw_filter: alert badge draw failed: {e}")
            except Exception as e:
                return f"draw_filter() cv2.rectangle or putText failed: {e}"

        except Exception as e:
            return f"draw_filter() failed with exception: {e}"

        # Stage: draw on workday_frame if Display_Activation and Workday flags are set.
        # Mirrors the processed_frame drawing logic but only when the camera's workday
        # schedule is active for this alert rule.
        if i["Display_Activation"]:
            if i["Workday"]:
                logger.info(f"Drawing on workday_frame | alert={i.get('Alert_Name')}")
                try:
                    if i["Area_of_Interest"]:
                        pts = np.array(i["Area_of_Interest"], np.int32)
                        color = (252, 119, 62) if flag else (255, 0, 0)
                        workday_frame = cv2.polylines(workday_frame, [pts], True, color, 2)
                    if i["Filtered_Objects"]:
                        for j in i["Filtered_Objects"]:
                            workday_frame = cv2.rectangle(
                                workday_frame,
                                (j["x"], j["y"]), (j["x"] + j["w"], j["y"] + j["h"]),
                                (0, 255, 0), 1
                            )
                            workday_frame = cv2.putText(
                                workday_frame, j["label"], (j["x"], j["y"] - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA
                            )
                    if check == "no_object":
                        try:
                            points = np.array([[650, 0], [650, 50], [600, 0]])
                            polygon = np.array([
                                [int(pts[0][0]), int(pts[0][1] - 2)],
                                [int(pts[0][0]), int(pts[0][1] - 20)],
                                [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                                [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                            ])
                            workday_frame = cv2.fillPoly(workday_frame, pts=[points], color=(0, 0, 255))
                            workday_frame = cv2.fillPoly(workday_frame, pts=[polygon], color=(252, 119, 62))
                            workday_frame = cv2.putText(
                                workday_frame, "No person", (pts[0][0], pts[0][1] - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                            )
                        except Exception as e:
                            logger.info(f"draw_filter: workday no-person badge failed: {e}")
                    else:
                        points = np.array([[650, 0], [650, 50], [600, 0]])
                        workday_frame = cv2.fillPoly(workday_frame, pts=[points], color=(0, 0, 255))
                        if flag:
                            try:
                                polygon = np.array([
                                    [int(pts[0][0]), int(pts[0][1] - 2)],
                                    [int(pts[0][0]), int(pts[0][1] - 20)],
                                    [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                                    [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                                ])
                                workday_frame = cv2.fillPoly(workday_frame, pts=[polygon], color=(252, 119, 62))
                                workday_frame = cv2.putText(
                                    workday_frame, "No person", (pts[0][0], pts[0][1] - 6),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                                )
                            except Exception as e:
                                logger.info(f"draw_filter: workday alert badge failed: {e}")
                except Exception as e:
                    return f"draw_filter() workday frame failed: {e}"

            # Stage: draw on holiday_frame if Holiday flag is set.
            # Mirrors workday_frame logic but for public holiday / off-day schedules.
            if i["Holiday"]:
                logger.info(f"Drawing on holiday_frame | alert={i.get('Alert_Name')}")
                try:
                    if i["Area_of_Interest"]:
                        pts = np.array(i["Area_of_Interest"], np.int32)
                        color = (252, 119, 62) if flag else (255, 0, 0)
                        holiday_frame = cv2.polylines(holiday_frame, [pts], True, color, 2)
                    if i["Filtered_Objects"]:
                        for j in i["Filtered_Objects"]:
                            holiday_frame = cv2.rectangle(
                                holiday_frame,
                                (j["x"], j["y"]), (j["x"] + j["w"], j["y"] + j["h"]),
                                (0, 255, 0), 1
                            )
                            holiday_frame = cv2.putText(
                                holiday_frame, j["label"], (j["x"], j["y"] - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA
                            )
                    if check == "no_object":
                        points = np.array([[650, 0], [650, 50], [600, 0]])
                        polygon = np.array([
                            [int(pts[0][0]), int(pts[0][1] - 2)],
                            [int(pts[0][0]), int(pts[0][1] - 20)],
                            [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                            [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                        ])
                        holiday_frame = cv2.fillPoly(holiday_frame, pts=[polygon], color=(252, 119, 62))
                        holiday_frame = cv2.fillPoly(holiday_frame, pts=[points], color=(0, 0, 255))
                        holiday_frame = cv2.putText(
                            holiday_frame, "No person", (pts[0][0], pts[0][1] - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                        )
                    else:
                        points = np.array([[650, 0], [650, 50], [600, 0]])
                        holiday_frame = cv2.fillPoly(holiday_frame, pts=[points], color=(0, 0, 255))
                        if flag:
                            try:
                                polygon = np.array([
                                    [int(pts[0][0]), int(pts[0][1] - 2)],
                                    [int(pts[0][0]), int(pts[0][1] - 20)],
                                    [int(pts[0][0] + 100), int(pts[0][1] - 20)],
                                    [int(pts[0][0] + 100), int(pts[0][1] - 2)]
                                ])
                                holiday_frame = cv2.fillPoly(holiday_frame, pts=[polygon], color=(252, 119, 62))
                                holiday_frame = cv2.putText(
                                    holiday_frame, "No person", (pts[0][0], pts[0][1] - 6),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA
                                )
                            except Exception as e:
                                logger.info(f"draw_filter: holiday alert badge failed: {e}")
                except Exception as e:
                    return f"draw_filter() holiday frame failed: {e}"

    logger.info(f"draw_filter complete | alert_configs_processed={len(LIST_Alert_Config)}")
    return processed_frame, workday_frame, holiday_frame
