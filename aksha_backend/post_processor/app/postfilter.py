"""
postfilter.py  —  Per-Alert Cooldown / Rate-Limiting Gate
==========================================================

Architecture: where this module fits
--------------------------------------

    ┌─────────────────────────────────────────────────────────────────────┐
    │                   NOTIFICATION DISPATCH CHAIN                       │
    │                                                                     │
    │  DeepStream  ──►  Kafka post_processing  ──►  post_processor        │
    │                                                     │               │
    │                                              process_detection()    │
    │                                                     │               │
    │                                              _handle_result()       │
    │                                                     │               │
    │                             Redis GET ──────────────┤               │
    │                             alert_status:<cam>      │               │
    │                                                     ▼               │
    │                                         NotificationService         │
    │                                         .send_notification()        │
    │                                                     │               │
    │                                                     ▼               │
    │                                    ┌────────────────────────────┐   │
    │                                    │  postfilter.               │   │
    │                                    │  email_status_check()      │   │ ← THIS FILE
    │                                    │                            │   │
    │                                    │  Inputs:                   │   │
    │                                    │    alert flags             │   │
    │                                    │    alert_results[]         │   │
    │                                    │    previous_statuses (Redis│   │
    │                                    │                            │   │
    │                                    │  Outputs:                  │   │
    │                                    │    validity flags          │   │
    │                                    │    updated_statuses → Redis│   │
    │                                    └────────────────────────────┘   │
    │                                                     │               │
    │                             Redis SET ──────────────┤               │
    │                             updated alert_statuses  │               │
    │                                                     ▼               │
    │                                    notification_params dict         │
    │                                    (non-empty → Kafka publish)      │
    └─────────────────────────────────────────────────────────────────────┘

Stateless design
----------------
``email_status_check`` is a **pure function with no instance state**.
All cooldown counters and timestamps are passed in via ``previous_alert_statuses``
(loaded from Redis by ``_handle_result``) and returned as the updated dict.
The caller is responsible for persisting the updated dict back to Redis.

This design allows the function to be called safely from multiple concurrent
thread-pool workers (one per frame in a batch) without any locking — each call
operates on its own copy of the state dict for its own camera.

Per-alert state structure (stored in Redis, passed here as ``previous_alert_statuses``)
----------------------------------------------------------------------------------------

    {
        "frame_alert": {
            "status":          bool,   # True = anomaly model currently active on this camera
            "count":           int,    # 0 = idle/ready;  >0 = cooldown active (increments each frame)
            "last_alert_time": float   # time.time() epoch seconds of last approved notification
                                       # 0 = never sent
        },
        "object_alert": {              # same structure as frame_alert, for object-level anomaly
            "status":          bool,
            "count":           int,
            "last_alert_time": float
        },
        "detection_alert": {           # keyed by alert name — one entry per user-defined detection alert
            "<alert_name>": {
                "status":          bool,
                "count":           int,
                "last_alert_time": float
            },
            ...
        },
        "no_object": {                 # keyed by alert name — one entry per no-object alert
            "<alert_name>": {
                "status":          bool,
                "count":           int,
                "last_alert_time": float
            },
            ...
        }
    }

Cooldown algorithm (state machine per alert entry)
---------------------------------------------------

    State: IDLE (count == 0)
      │
      │  alert fires on this frame AND count == 0
      ▼
    FIRE notification  →  count = 1, last_alert_time = now
      │
      ▼
    State: COOLDOWN (count > 0)
      │
      │  each subsequent frame with the alert still active:
      │      count += 1
      │
      │  if now - last_alert_time >= interval_seconds:
      │      count = 0, last_alert_time = 0     ← cooldown expired → back to IDLE
      ▼
    State: IDLE again → next alert on this camera fires a new notification

    Key insight: the count field is an auditing counter (how many frames fired
    during the current cooldown window) but the actual expiry decision is always
    time-based (last_alert_time), not count-based.  The count is never used for
    comparison — only ``last_alert_time`` drives the expiry check.

Active / inactive key switching (detection_alert vs no_object)
---------------------------------------------------------------
Within a single frame, only ONE of ``detection_alert`` or ``no_object`` can be
the active alert category:

    no_object_status = True   →  detect_key = "no_object"
                                 el         = "detection_alert"  (reset all entries to zero)

    no_object_status = False  →  detect_key = "detection_alert"
                                 el         = "no_object"         (reset all entries to zero)

Resetting the inactive branch prevents stale cooldown counts from a previous
alert type from silently blocking future notifications when the alert type
changes on subsequent frames.

Current cooldown window
-----------------------
Default parameter: ``time_interval = 1`` minute (60 s).
Current caller override (in ``notif_filter.py``): ``time_interval = 0.5`` (30 s).
See the LAG FIX comment in ``notif_filter.py`` for the change rationale.
"""

# ── Standard library ──────────────────────────────────────────────────────────
import time      # time.time() for epoch-based cooldown expiry checks
import logging   # fallback logger when caller does not inject one

# ── Module-level fallback logger ──────────────────────────────────────────────
# Used only when the caller passes logger=None (e.g. in unit tests).
# NullHandler prevents "No handlers could be found" warnings in library consumers.
_module_logger = logging.getLogger("postfilter")
if not _module_logger.handlers:
    _module_logger.addHandler(logging.NullHandler())


# ══════════════════════════════════════════════════════════════════════════════
# email_status_check  —  the single public function of this module
# ══════════════════════════════════════════════════════════════════════════════

def email_status_check(
    frame_anomaly_status,    # bool: frame-level anomaly model fired on this frame
    object_anomaly_status,   # bool: object-level anomaly model fired on this frame
    no_object_status,        # bool: expected object absent from zone (no-object alert)
    alert_results,           # list[str]: names of detection alerts that fired this frame
    previous_alert_statuses, # dict: per-camera cooldown state loaded from Redis
    fps=None,                # float|None: camera FPS — reserved for future frame-count logic
    time_interval=1,         # float: cooldown window in MINUTES (default 1 min = 60 s)
    logger=None,             # logging.Logger: injected by NotificationService, or None
):
    """
    Apply per-alert cooldown gating and return updated notification validity flags.

    This function is the core rate-limiter of the notification pipeline.  It
    answers: *"For each alert that fired on this frame, has enough time passed
    since we last sent a notification for it?"*

    For every alert tracked in ``previous_alert_statuses`` it runs a two-phase
    check:

    Phase 1 — EXPIRY CHECK (if cooldown is active):
        Increment the frame counter.  If ``now - last_alert_time >= interval_seconds``,
        the cooldown window has elapsed → reset to idle so the next firing can
        send a new notification.

    Phase 2 — FIRE CHECK (if alert is active AND idle):
        If the alert fired on this frame and the cooldown is not active (count==0),
        approve the notification (validity=True) and start a new cooldown
        (count=1, last_alert_time=now).

    This logic is applied identically to:
    - ``frame_alert``      — frame-level anomaly
    - ``object_alert``     — object-level anomaly
    - Named entries in ``detection_alert`` or ``no_object`` (selected by ``no_object_status``)

    Parameters
    ----------
    frame_anomaly_status : bool
        True if the frame-level unsupervised anomaly model flagged this frame.
        Checked against the ``frame_alert`` entry in ``previous_alert_statuses``.
    object_anomaly_status : bool
        True if the object-level anomaly model flagged this frame.
        Checked against the ``object_alert`` entry in ``previous_alert_statuses``.
    no_object_status : bool
        True if a "no-object" condition was detected (expected object absent).
        Switches the active dict key between ``"no_object"`` and
        ``"detection_alert"``.
    alert_results : list[str]
        Names of detection / no-object alerts that fired on this frame.
        Used to match against keys in ``previous_alert_statuses["detection_alert"]``
        or ``previous_alert_statuses["no_object"]``.
    previous_alert_statuses : dict
        Per-camera cooldown state dict loaded from Redis by ``_handle_result``.
        This dict is **mutated in-place** — updated counters and timestamps are
        written directly into it.  The caller must persist the returned dict to
        Redis after this call.
    fps : float or None
        Camera frame rate.  Currently unused; reserved for a future variant that
        tracks cooldown in frames rather than wall-clock seconds.
    time_interval : float
        Cooldown window in **minutes**.  Converted to seconds internally.
        Default 1.0 min; caller passes 0.5 (30 s).
    logger : logging.Logger, optional
        Logger instance from ``NotificationService``.  Falls back to the
        module-level NullHandler logger if not provided.

    Returns
    -------
    tuple[bool, bool, list[bool], list[bool], dict]
        ``(frame_anomaly_validity, object_anomaly_validity,
           alert_validity, no_object_validity, previous_alert_statuses)``

        frame_anomaly_validity  : bool      — True = send frame-anomaly notification now
        object_anomaly_validity : bool      — True = send object-anomaly notification now
        alert_validity          : list[bool]— per-named-detection-alert gate results
        no_object_validity      : list[bool]— per-no-object-alert gate results
        previous_alert_statuses : dict      — mutated state dict; caller writes to Redis
    """
    log = logger or _module_logger   # use injected logger or silent fallback

    now = time.time()                           # current epoch seconds — used for all expiry checks
    interval_seconds = time_interval * 60       # convert minutes → seconds for comparison

    log.info(
        f"email_status_check | time_interval={time_interval}min "
        f"| interval_seconds={interval_seconds} | no_object_status={no_object_status}"
    )

    # ── Initialise output validity flags ──────────────────────────────────────
    # Default: False = "do not send notification".
    # Only set to True if the alert fired AND the cooldown has expired.
    frame_anomaly_validity = False
    object_anomaly_validity = False

    # ── FRAME ANOMALY: two-phase cooldown gate ────────────────────────────────
    #
    # Phase 1 — EXPIRY CHECK: if a cooldown is currently active (count > 0),
    # tick the counter and check whether the window has elapsed.
    if previous_alert_statuses["frame_alert"]["count"] > 0:
        # Increment the frame counter — records how many frames fired during this cooldown
        previous_alert_statuses["frame_alert"]["count"] += 1
        # Check if the cooldown window has fully elapsed since the last approved notification
        if now - previous_alert_statuses["frame_alert"]["last_alert_time"] >= interval_seconds:
            # Cooldown expired → reset to IDLE so the next firing can send a notification
            previous_alert_statuses["frame_alert"]["count"] = 0           # back to idle
            previous_alert_statuses["frame_alert"]["last_alert_time"] = 0 # clear the timestamp

    # Phase 2 — FIRE CHECK: if the frame anomaly is active AND no cooldown is running,
    # approve the notification and start a new cooldown window.
    if frame_anomaly_status and previous_alert_statuses["frame_alert"]["count"] == 0:
        frame_anomaly_validity = True                                       # approved: send notification now
        previous_alert_statuses["frame_alert"]["count"] = 1                # start cooldown (count > 0 = active)
        previous_alert_statuses["frame_alert"]["last_alert_time"] = now    # record when this cooldown started

    # ── OBJECT ANOMALY: same two-phase logic as frame anomaly above ───────────
    #
    # Phase 1 — EXPIRY CHECK
    if previous_alert_statuses["object_alert"]["count"] > 0:
        previous_alert_statuses["object_alert"]["count"] += 1
        if now - previous_alert_statuses["object_alert"]["last_alert_time"] >= interval_seconds:
            previous_alert_statuses["object_alert"]["count"] = 0            # reset to IDLE
            previous_alert_statuses["object_alert"]["last_alert_time"] = 0  # clear timestamp

    # Phase 2 — FIRE CHECK
    if object_anomaly_status and previous_alert_statuses["object_alert"]["count"] == 0:
        object_anomaly_validity = True                                        # approved
        previous_alert_statuses["object_alert"]["count"] = 1                 # start cooldown
        previous_alert_statuses["object_alert"]["last_alert_time"] = now     # record start time

    # ── Write current active/inactive status flags ───────────────────────────
    # These "status" fields are read by the dashboard for display purposes.
    # They reflect the *current* frame's state, not the cooldown gate result.
    previous_alert_statuses["frame_alert"]["status"] = frame_anomaly_status    # True = model currently firing
    previous_alert_statuses["object_alert"]["status"] = object_anomaly_status  # True = model currently firing

    # ── Initialise per-named-alert validity output lists ─────────────────────
    # One False entry per named alert registered for this camera.
    # Entries are flipped to True below if the alert passes the cooldown gate.
    alert_validity = [False] * len(previous_alert_statuses["detection_alert"])   # for my_alert branch
    no_object_validity = [False] * len(previous_alert_statuses["no_object"])     # for no_object branch

    log.info(f"no_object_status={no_object_status} | alert_results={alert_results}")

    # ── ACTIVE / INACTIVE KEY SWITCHING ──────────────────────────────────────
    # A frame can only carry ONE category of named alert: detection-based OR no-object.
    # Select which dict key holds the active alerts and which holds the inactive alerts.
    #
    #   no_object_status=True  →  evaluate "no_object",        reset "detection_alert"
    #   no_object_status=False →  evaluate "detection_alert",  reset "no_object"
    if no_object_status:
        detect_key = "no_object"        # active category: evaluate these entries
        el = "detection_alert"          # inactive category: zero out these entries
    else:
        detect_key = "detection_alert"  # active category
        el = "no_object"                # inactive category: zero out these entries

    # ── RESET INACTIVE KEY ───────────────────────────────────────────────────
    # Zero out all entries in the inactive category.
    # Why: if the alert type switched between frames (e.g. the last frame was a
    # detection alert but this frame is a no-object alert), stale counts in the
    # inactive dict would block future notifications when the type switches back.
    for key in previous_alert_statuses[el]:
        previous_alert_statuses[el][key]["count"] = 0              # clear frame counter
        previous_alert_statuses[el][key]["last_alert_time"] = 0    # clear last-fire timestamp
        previous_alert_statuses[el][key]["status"] = False         # mark as inactive

    # ── EVALUATE ACTIVE NAMED ALERTS ─────────────────────────────────────────
    # Apply the same two-phase cooldown gate to each named alert registered for
    # this camera under the active category (detect_key).
    for key in previous_alert_statuses[detect_key]:

        # ── Step 1: EXPIRY CHECK for this named alert ─────────────────────────
        # If a cooldown is currently active (count > 0), tick the counter and
        # check whether the cooldown window has elapsed since last notification.
        if previous_alert_statuses[detect_key][key]["count"] > 0:
            previous_alert_statuses[detect_key][key]["count"] += 1   # tick: records how many frames fired in this window
            if now - previous_alert_statuses[detect_key][key]["last_alert_time"] >= interval_seconds:
                # Cooldown window elapsed → reset to IDLE so next firing can notify
                previous_alert_statuses[detect_key][key]["count"] = 0           # back to idle
                previous_alert_statuses[detect_key][key]["last_alert_time"] = 0 # clear timestamp

        # ── Step 2: FIRE CHECK for this named alert ───────────────────────────
        # If this alert name appears in the current frame's alert_results AND no
        # cooldown is active (count == 0), approve the notification and start a
        # new cooldown window for this alert.
        if key in alert_results and previous_alert_statuses[detect_key][key]["count"] == 0:
            # Set the correct validity output slot based on alert category
            if no_object_status:
                # alert_results.index(key) gives the position within the fired-alert list;
                # no_object_validity uses the same positional indexing
                no_object_validity[alert_results.index(key)] = True   # approved for no-object notification
            else:
                alert_validity[alert_results.index(key)] = True        # approved for detection-alert notification

            previous_alert_statuses[detect_key][key]["count"] = 1           # start cooldown
            previous_alert_statuses[detect_key][key]["last_alert_time"] = now  # record start time

        # ── Step 3: UPDATE STATUS FLAG ────────────────────────────────────────
        # Update the dashboard-visible status flag regardless of cooldown.
        # True  = this alert name is in the current frame's alert_results (currently firing)
        # False = this alert is not firing on this frame
        previous_alert_statuses[detect_key][key]["status"] = True if key in alert_results else False

    # ── Return all outputs ────────────────────────────────────────────────────
    # previous_alert_statuses has been mutated in-place with updated counts and
    # timestamps.  The caller (NotificationService → _handle_result) must write
    # this back to Redis (setex with 24 h TTL) before the next frame for this
    # camera is processed.
    log.info(
        f"email_status_check complete | alert_validity={alert_validity} "
        f"| no_object_validity={no_object_validity} "
        f"| frame_anomaly={frame_anomaly_validity} | object_anomaly={object_anomaly_validity}"
    )
    return (
        frame_anomaly_validity,    # bool: frame anomaly approved to notify
        object_anomaly_validity,   # bool: object anomaly approved to notify
        alert_validity,            # list[bool]: per-detection-alert approvals
        no_object_validity,        # list[bool]: per-no-object-alert approvals
        previous_alert_statuses,   # dict: mutated state → must be written to Redis by caller
    )


# ══════════════════════════════════════════════════════════════════════════════
# ppe_status_check  —  cooldown gate for the PPE compliance stream
# ══════════════════════════════════════════════════════════════════════════════

def ppe_status_check(has_violation, previous_alert_statuses, time_interval=0.5, logger=None):
    """
    Two-phase cooldown gate for PPE violations, one shared window per camera.

    The PPE consumer forwards every frame regardless of severity (a continuous
    compliance stream, not a violation-only filter — see ppe_alert_consumer.py),
    so gating happens here instead: only a genuine violation (``has_violation``)
    can start a cooldown window, and only one PPE notification per camera is
    approved per window. This mirrors the ``frame_alert``/``object_alert`` gate
    above rather than the per-named-alert ``detection_alert`` gate, since PPE
    violated-item names are not pre-registered per camera in MongoDB the way
    user-defined detection alerts are.

    ``previous_alert_statuses`` may predate this function's existence (loaded
    from Redis before the "ppe_alert" key was ever written), so the state entry
    is created on first use via ``setdefault`` rather than assumed present.

    Parameters
    ----------
    has_violation : bool
        True if this PPE message represents an actual violation (non-empty
        ``violated`` list and severity != "none").
    previous_alert_statuses : dict
        Per-camera cooldown state dict loaded from Redis. Mutated in-place.
    time_interval : float
        Cooldown window in minutes (default 0.5 = 30 s, matching the other
        alert types in this module).
    logger : logging.Logger, optional

    Returns
    -------
    tuple[bool, dict]
        ``(ppe_validity, previous_alert_statuses)`` — ``ppe_validity`` is True
        when a PPE notification should be sent now; ``previous_alert_statuses``
        must be persisted back to Redis by the caller.
    """
    log = logger or _module_logger
    now = time.time()
    interval_seconds = time_interval * 60

    ppe_state = previous_alert_statuses.setdefault(
        "ppe_alert", {"status": False, "count": 0, "last_alert_time": 0}
    )

    ppe_validity = False
    if ppe_state["count"] > 0:
        ppe_state["count"] += 1
        if now - ppe_state["last_alert_time"] >= interval_seconds:
            ppe_state["count"] = 0
            ppe_state["last_alert_time"] = 0

    if has_violation and ppe_state["count"] == 0:
        ppe_validity = True
        ppe_state["count"] = 1
        ppe_state["last_alert_time"] = now

    ppe_state["status"] = has_violation

    log.info(f"ppe_status_check | has_violation={has_violation} | validity={ppe_validity}")
    return ppe_validity, previous_alert_statuses


def jewelry_status_check(rule, previous_alert_statuses, time_interval=0.1, logger=None):
    """
    Cooldown gate for jewelry rule events, one window per (camera, rule).

    Unlike PPE's continuous compliance stream, every jewelry message already
    represents a rule that fired past its own cooldown at the source (see
    jewelry_rules.AlertBus — each rule cooldown-gates itself, ~10s, before
    ever publishing to Kafka). This gate is deliberately short (default 6s)
    — it's dedup insurance against at-least-once Kafka redelivery on consumer
    restart/rebalance, not a real behavioral cooldown. Keyed per rule (not
    one shared window per camera like PPE) so an unrelated rule firing on the
    same camera is never suppressed by a different rule's window.

    Parameters
    ----------
    rule : str
        The rule name that fired (e.g. "LOITERING").
    previous_alert_statuses : dict
        Per-camera cooldown state dict loaded from Redis. Mutated in-place.
    time_interval : float
        Cooldown window in minutes (default 0.1 = 6s).
    logger : logging.Logger, optional

    Returns
    -------
    tuple[bool, dict]
        ``(jewelry_validity, previous_alert_statuses)``.
    """
    log = logger or _module_logger
    now = time.time()
    interval_seconds = time_interval * 60
    state_key = f"jewelry_alert_{rule}"

    rule_state = previous_alert_statuses.setdefault(
        state_key, {"status": False, "count": 0, "last_alert_time": 0}
    )

    jewelry_validity = False
    if rule_state["count"] > 0:
        rule_state["count"] += 1
        if now - rule_state["last_alert_time"] >= interval_seconds:
            rule_state["count"] = 0
            rule_state["last_alert_time"] = 0

    if rule_state["count"] == 0:
        jewelry_validity = True
        rule_state["count"] = 1
        rule_state["last_alert_time"] = now

    rule_state["status"] = True

    log.info(f"jewelry_status_check | rule={rule} | validity={jewelry_validity}")
    return jewelry_validity, previous_alert_statuses


# ══════════════════════════════════════════════════════════════════════════════
# OLD FUNCTIONS  (kept for reference — replaced by the implementation above)
# ══════════════════════════════════════════════════════════════════════════════
#
# The original implementation used a time-only gate (no count field) and
# received full alert_result_config / noobj_alert_result_config lists.
# It was replaced because:
#   1. The new API passes alert_results (name list) instead of full config docs,
#      which is simpler and avoids re-fetching config data in the hotpath.
#   2. The count field was added to give an audit trail of how many frames fired
#      during each cooldown window (useful for tuning and debugging).
#   3. The active/inactive key switching was added to prevent stale counts from
#      the wrong alert category from blocking notifications after a type switch.

# def email_status_check(
#     framebase_prediction, objectbase_prediction, no_object_status,
#     previous_alert_statuses, fps, alert_result_config, noobj_alert_result_config,
#     time_interval=60, logger=None,
# ):
#     log = logger or _module_logger
#     now = time.time()
#     try:
#         frame_anomaly_notif_validity, object_anomaly_notif_validity = frame_and_object_anomaly_validity(
#             time_interval, now, previous_alert_statuses, framebase_prediction, objectbase_prediction, logger=log)
#         alert_validity = [False] * len(previous_alert_statuses["detection_alert"])
#         no_object_validity = [False] * len(previous_alert_statuses["no_object"])
#         detect_key = "no_object" if no_object_status else "detection_alert"
#         alert_config = noobj_alert_result_config if no_object_status else alert_result_config
#         alert_res_names = [alert_data['Alert_Name'] for alert_data in alert_config]
#         for alert_name in previous_alert_statuses[detect_key]:
#             if alert_name not in alert_res_names:
#                 previous_alert_statuses[detect_key][alert_name]["last_notif_time"] = 0
#                 previous_alert_statuses[detect_key][alert_name]["status"] = False
#             else:
#                 last_notif_time = previous_alert_statuses[detect_key][alert_name].get("last_notif_time", 0)
#                 elapsed = (now - last_notif_time) if last_notif_time else float('inf')
#                 if elapsed >= time_interval:
#                     if no_object_status:
#                         no_object_validity[alert_res_names.index(alert_name)] = True
#                     else:
#                         idx = alert_res_names.index(alert_name) if alert_name in alert_res_names else None
#                         if idx is not None:
#                             alert_validity[idx] = True
#                     previous_alert_statuses[detect_key][alert_name]["last_notif_time"] = now
#                 previous_alert_statuses[detect_key][alert_name]["status"] = True
#         return frame_anomaly_notif_validity, object_anomaly_notif_validity, alert_validity, no_object_validity, previous_alert_statuses
#     except Exception as e:
#         log.error("Error in postfilter application", exc_info=True)
#         return False, False, [], [], previous_alert_statuses

# def frame_and_object_anomaly_validity(time_interval, now, previous_alert_statuses, framebase_prediction, objectbase_prediction, logger=None):
#     log = logger or _module_logger
#     frame_anomaly_notif_validity = False
#     object_anomaly_notif_validity = False
#     if not framebase_prediction:
#         previous_alert_statuses["frame_alert"]["last_notif_time"] = 0
#     else:
#         last = previous_alert_statuses["frame_alert"].get("last_notif_time", 0)
#         elapsed = (now - last) if last else float('inf')
#         if elapsed >= time_interval:
#             frame_anomaly_notif_validity = True
#             previous_alert_statuses["frame_alert"]["last_notif_time"] = now
#     if not objectbase_prediction:
#         previous_alert_statuses["object_alert"]["last_notif_time"] = 0
#     else:
#         last = previous_alert_statuses["object_alert"].get("last_notif_time", 0)
#         elapsed = (now - last) if last else float('inf')
#         if elapsed >= time_interval:
#             object_anomaly_notif_validity = True
#             previous_alert_statuses["object_alert"]["last_notif_time"] = now
#     previous_alert_statuses["frame_alert"]["status"] = framebase_prediction
#     previous_alert_statuses["object_alert"]["status"] = objectbase_prediction
#     return frame_anomaly_notif_validity, object_anomaly_notif_validity
