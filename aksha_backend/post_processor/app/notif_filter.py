"""
notif_filter.py  —  Notification Dispatch Layer
================================================

Architecture: where this module fits
-------------------------------------

    ┌─────────────────────────────────────────────────────────────────┐
    │                   POST-PROCESSOR  (main.py)                     │
    │                                                                 │
    │  Kafka consumer                                                 │
    │    └── process_detection()     ← CPU thread pool               │
    │            │  ProcessingResult (check, result_img, flags)       │
    │            ▼                                                    │
    │       _handle_result()                                          │
    │            │                                                    │
    │            ├── Redis  GET  previous_alert_statuses              │
    │            │                                                    │
    │            ├──► NotificationService.send_notification()  ◄──── │ ← THIS FILE
    │            │         │                                          │
    │            │         ├── postfilter.email_status_check()        │
    │            │         │       └── returns validity flags +       │
    │            │         │           updated alert_statuses         │
    │            │         │                                          │
    │            │         └── builds notification_params dict        │
    │            │                                                    │
    │            ├── Redis  SET  updated_alert_statuses               │
    │            │                                                    │
    │            └── Kafka PRODUCE  notification_service topic        │
    │                    (only if notification_params is non-empty)   │
    └─────────────────────────────────────────────────────────────────┘

Notification decision flow (per frame)
---------------------------------------

    NotificationParams (from _handle_result)
          │
          ▼
    postfilter.email_status_check()
          │
          ├── frame_anomaly_validity   ─┐
          ├── object_anomaly_validity   │  cooldown-gated booleans
          ├── alert_validity[]          │  (True = "send now", False = "still in cooldown")
          ├── no_object_validity[]     ─┘
          └── previous_alert_statuses  →  updated state to write back to Redis
          │
          ▼
    check == "no_object"  → gate on no_object_validity
    check == "my_alert"   → gate on (alert_validity AND alert_notification_validity)
    check == "auto_alert" → gate on (Email_Auto_Alert config AND anomaly validity)
          │
          ▼
    notification_params dict  (non-empty → publish to Kafka)
                              (empty {}  → suppress, nothing published)

Three alert types and their notification payload ``Type`` field
----------------------------------------------------------------
  Alert type        check value      notification_params["Type"]
  ──────────────    ───────────      ───────────────────────────
  No-object         "no_object"      "No Object Alert"
  Detection-based   "my_alert"       "Alert"
  Anomaly model     "auto_alert"     "AutoAlert"

Cooldown summary
----------------
All cooldown state lives in Redis (keyed ``alert_status:<camera_name>``).
This module receives the current state, passes it through postfilter (which
mutates and returns it), then the caller writes the updated state back to Redis.
Current window: **30 s** (``time_interval=0.5`` minutes).
"""

# ── Standard library ──────────────────────────────────────────────────────────
import logging

# ── Internal modules ──────────────────────────────────────────────────────────
import postfilter   # Stateless cooldown/rate-limit gating logic


# ══════════════════════════════════════════════════════════════════════════════
# NotificationService
# ══════════════════════════════════════════════════════════════════════════════

class NotificationService:
    """
    Notification gating and payload construction service.

    Responsibilities
    ----------------
    1. Receive a ``NotificationParams`` dataclass packed by ``_handle_result``
       containing every piece of per-frame context needed for a decision.
    2. Delegate the cooldown / rate-limiting decision to
       ``postfilter.email_status_check`` — this returns updated validity flags
       and a mutated ``previous_alert_statuses`` dict.
    3. Based on the ``check`` field (alert type) and the validity flags, either:
       - Build and return a notification payload dict  → Kafka publish will happen.
       - Return an empty dict ``{}``                  → Kafka publish is skipped.

    Thread safety
    -------------
    This class holds **no mutable instance state** — ``previous_alert_statuses``
    is passed in and out per call.  The same single instance is safely shared
    across all concurrent ``_handle_result`` coroutines that run in the thread
    pool (one per frame in a batch).

    Caller chain
    ------------
    ``_handle_result`` (main.py)
        └── ``loop.run_in_executor(None, self.notification_service.send_notification, notification_data)``
                └── ``NotificationService.send_notification``  ← this class
                        └── ``postfilter.email_status_check``
    """

    # ── Constructor ───────────────────────────────────────────────────────────

    def __init__(self, logger=None):
        """
        Initialise the notification service with a shared logger.

        The logger is injected from ``KafkaService.__init__`` so all pipeline
        components write to the same rotating per-host log file.  A NullHandler
        fallback is provided for unit-test environments where no logger exists.

        Parameters
        ----------
        logger : logging.Logger, optional
            Shared logger from ``KafkaService``.  Pass ``None`` only in tests.
        """
        if logger is not None:
            # Use the caller's logger — all pipeline stages share one rotating file
            self.logger = logger
        else:
            # Fallback: silent NullHandler so library users don't get "no handlers" warnings
            self.logger = logging.getLogger("notif_filter")
            if not self.logger.handlers:
                self.logger.addHandler(logging.NullHandler())

        self.logger.info("NotificationService initialised")

    # ── Core method ───────────────────────────────────────────────────────────

    def send_notification(self, notification_data):
        """
        Gate and dispatch a notification for a single processed camera frame.

        This is the single public method of ``NotificationService``.  It is
        called synchronously from the thread pool (via ``run_in_executor``) once
        per frame in the batch, after ``process_detection`` has already decided
        that an alert condition exists on this frame.

        What this method does NOT decide
        ---------------------------------
        Whether an alert *fired* — that decision is made upstream in DeepStream
        and carried in ``stream_result.alert_results`` / ``no_object_status``.
        This method only decides whether a notification should be *sent now*,
        given how recently the last notification for this alert was dispatched.

        Processing pipeline inside this method
        ----------------------------------------
        Step 1  UNPACK    — extract every field from the NotificationParams dataclass
                            so individual variables are easy to reference below.

        Step 2  POSTFILTER — call ``postfilter.email_status_check`` which applies
                             the per-alert cooldown window and returns:
                               • validity flags (bool per alert) — True = "send now"
                               • updated ``previous_alert_statuses`` — write back to Redis

        Step 3  GATE+BUILD — for each alert type (no_object / my_alert / auto_alert):
                               • check the appropriate validity list from postfilter
                               • if approved, build a notification payload dict
                               • if suppressed, leave ``notification_params = {}``

        Step 4  RETURN     — return the 6-tuple that ``_handle_result`` destructures:
                             ``(frame_anomaly_validity, object_anomaly_validity,
                               alert_validity, no_object_validity,
                               previous_alert_statuses, notification_params)``

        Parameters
        ----------
        notification_data : NotificationParams
            Dataclass packed by ``NotificationParams.from_stream_and_processing_results``
            in ``_handle_result``.  Contains: frame_id, camera_name, check, timestamp,
            alert flags, alert lists, config, previous Redis state.

        Returns
        -------
        tuple[bool, bool, list[bool], list[bool], dict, dict]
            6-tuple consumed directly by ``_handle_result``:
            - ``frame_anomaly_validity``   bool    frame-level anomaly approved
            - ``object_anomaly_validity``  bool    object-level anomaly approved
            - ``alert_validity``           list    per-alert cooldown gate result
            - ``no_object_validity``       list    per-no-object-alert gate result
            - ``previous_alert_statuses``  dict    updated Redis state to write back
            - ``notification_params``      dict    payload to Kafka (empty = suppress)
        """

        # ── Step 1: UNPACK ────────────────────────────────────────────────────
        # Extract every field from the NotificationParams dataclass into local
        # variables for clarity.  These are all read-only; only
        # previous_alert_statuses is mutated (by postfilter, passed by reference).

        check = notification_data.check                     # alert type: "no_object" | "my_alert" | "auto_alert" | "no_alert"
        frame_id = notification_data.frame_id               # "<camera>@<HH:MM:SS.ffffff>"  for tracing
        camera_name = notification_data.camera_name         # camera identifier string

        # Alert result lists — parallel arrays (same index = same alert)
        alert_results = notification_data.alert_results                           # list[str]:  triggered alert names
        alert_description = notification_data.alert_description                   # list[str]:  human-readable descriptions
        alert_notification_validity = notification_data.alert_notification_validity  # list[bool]: upstream gate from DeepStream

        # Alert type flags — what kind of anomaly did this frame trigger?
        frame_anomaly_status = notification_data.frame_anomaly_status   # bool: frame-level model fired
        object_anomaly_status = notification_data.object_anomaly_status # bool: object-level model fired
        no_object_status = notification_data.no_object_status           # bool: expected object absent

        # Redis state — current cooldown counters loaded by _handle_result before this call
        previous_alert_statuses = notification_data.previous_alert_statuses  # dict: mutated in-place by postfilter

        # Camera config from MongoDB — used for auto_alert email gate
        autoalert_notification_email_service = notification_data.autoalert_notification_email_service  # bool: Email_Auto_Alert per-camera flag
        camera_configuration = notification_data.camera_configuration  # full MongoDB config doc

        # Unused config lists (kept for potential future use in postfilter extensions)
        alert_result_config = notification_data.alert_result_config         # list: alert config docs for my_alert
        noobj_alert_result_config = notification_data.noobj_alert_result_config  # list: alert config docs for no_object

        fps = notification_data.fps           # float|None: camera FPS (reserved for frame-count cooldown)
        timestamp = notification_data.timestamp  # str: "%Y-%m-%d %H:%M:%S.%f" aligned to frame_id time

        self.logger.info(
            f"send_notification called | frame_id={frame_id} | camera={camera_name} "
            f"| check={check} | alerts={alert_results} | no_object_status={no_object_status}"
        )

        # ── Step 2: POSTFILTER ────────────────────────────────────────────────
        # Ask postfilter whether each alert's cooldown window has elapsed.
        # Input:  current alert flags + previous Redis state (previous_alert_statuses)
        # Output: validity flags (True = approved to send) + updated Redis state
        #
        # The validity flags produced here are the primary gate for all three
        # alert type branches below.  If postfilter says False for every alert,
        # notification_params stays {} and nothing is published to Kafka.
        try:
            notification_params = {}   # default: suppressed — only overwritten if a gate passes below

            self.logger.info(
                f"Running postfilter | frame_id={frame_id} | camera={camera_name} "
                f"| fps={fps} | frame_anomaly={frame_anomaly_status} | object_anomaly={object_anomaly_status}"
            )

            # OLD API (kept for reference): passed full alert_result_config lists
            # postfilter.email_status_check(
            #     frame_anomaly_status, object_anomaly_status, no_object_status,
            #     previous_alert_statuses, fps, alert_result_config, noobj_alert_result_config,
            #     logger=self.logger
            # )

            # NEW API: passes alert_results (name list) + explicit time_interval keyword.
            # LAG FIX: time_interval reduced from 1.0 min → 0.5 min (30 s cooldown).
            # The original 60 s window was suppressing all alerts for a full minute after
            # the first one fired, causing operators to miss 4–6 real events per camera.
            # Halving the window to 30 s still prevents notification floods while letting
            # genuine repeated detections through in near-real-time.
            (
                frame_anomaly_validity,   # bool: frame model approved by cooldown
                object_anomaly_validity,  # bool: object model approved by cooldown
                alert_validity,           # list[bool]: per-named-alert cooldown result
                no_object_validity,       # list[bool]: per-no-object-alert cooldown result
                previous_alert_statuses   # dict: MUTATED — updated counts + timestamps
            ) = postfilter.email_status_check(
                frame_anomaly_status,          # current frame-anomaly flag
                object_anomaly_status,         # current object-anomaly flag
                no_object_status,              # current no-object flag
                alert_results,                 # list of triggered alert names this frame
                previous_alert_statuses,       # current Redis state (mutated in-place)
                fps=fps,                       # camera FPS (currently unused by postfilter)
                time_interval=0.5,             # cooldown window in minutes (30 s)
                logger=self.logger             # share the rotating log file
            )

            self.logger.info(
                f"Postfilter result | frame_id={frame_id} | frame_anomaly_valid={frame_anomaly_validity} "
                f"| object_anomaly_valid={object_anomaly_validity} "
                f"| alert_validity={alert_validity} | no_object_validity={no_object_validity}"
            )
        except Exception as e:
            # If postfilter itself throws, log and continue — notification_params stays {}
            # so nothing gets published, which is the safe fallback.
            self.logger.exception(f"Postfilter failed | frame_id={frame_id}: {e}")

        # ── Step 3: GATE + BUILD ──────────────────────────────────────────────
        # Three mutually exclusive branches, one per alert type.
        # Each branch:
        #   a) checks whether the postfilter approved at least one alert
        #   b) if yes, populates notification_params with the Kafka payload dict
        #   c) if no,  leaves notification_params = {} (suppressed)
        #
        # The payload schema is the same across all types:
        #   camera, Type, frame_id, Timestamp, alert_notification_validity,
        #   alert, description, RTSP_Link, RTSP_Down
        # RTSP_Link and RTSP_Down are always None — reserved for future live-stream linking.

        # ── Branch A: NO-OBJECT ALERT ─────────────────────────────────────────
        # Condition: an expected object (person, vehicle, etc.) is ABSENT from
        # the defined area-of-interest zone during operating hours.
        # Gate: at least one entry in no_object_validity must be True.
        if check == "no_object":
            self.logger.info(
                f"Evaluating no_object notification | frame_id={frame_id} "
                f"| no_object_validity={no_object_validity}"
            )

            if True in no_object_validity:
                # At least one no-object alert passed the cooldown gate → build payload
                notification_params = {
                    "camera": camera_name,                           # identifies which camera on the frontend
                    "Type": "No Object Alert",                       # payload type tag read by notification_service consumer
                    "frame_id": str(frame_id),                       # trace ID linking notification to the exact frame
                    "Timestamp": timestamp,                          # frame-aligned time string for display / storage
                    "alert_notification_validity": no_object_validity,  # per-alert bool list for notification_service to use
                    "alert": alert_results,                          # list of alert names that fired (e.g. ["Zone A No Person"])
                    "description": alert_description,               # list of human-readable descriptions for each alert
                    "RTSP_Link": None,                               # reserved: future live-stream URL
                    "RTSP_Down": None,                               # reserved: future stream-health flag
                }
                self.logger.info(
                    f"No-object notification approved | frame_id={frame_id} | camera={camera_name}"
                )
            else:
                # All no-object alerts are still within the 30 s cooldown window → suppress
                self.logger.info(
                    f"No-object notification suppressed by postfilter | frame_id={frame_id}"
                )

        # ── Branch B: MY-ALERT (detection-based) ─────────────────────────────
        # Condition: a user-defined detection alert rule matched — an object of
        # a specified class entered a defined area-of-interest zone.
        # Gate: DUAL — postfilter cooldown AND the upstream DeepStream gate must
        #        both be True for the same alert index.
        elif check == "my_alert":
            self.logger.info(
                f"Evaluating my_alert notification | frame_id={frame_id} "
                f"| alert_validity={alert_validity} "
                f"| alert_notification_validity={alert_notification_validity}"
            )

            # Merge the two independent gates using element-wise AND.
            # alert_validity[i]                — postfilter cooldown: True = "30 s has elapsed"
            # alert_notification_validity[i]   — DeepStream upstream gate: True = "consecutive frames threshold met"
            # Both must be True for alert index i to trigger a notification.
            min_len = min(len(alert_validity), len(alert_notification_validity))  # guard against length mismatch
            for i in range(min_len):
                # Overwrite alert_notification_validity[i] with the AND of both gates.
                # After this loop, alert_notification_validity is the final merged gate list.
                alert_notification_validity[i] = bool(alert_validity[i] and alert_notification_validity[i])

            if True in alert_notification_validity:
                # At least one alert index passed both gates → build payload
                notification_params = {
                    "camera": camera_name,                                  # identifies which camera
                    "Type": "Alert",                                        # detection-based alert type tag
                    "frame_id": str(frame_id),                              # trace ID for the triggering frame
                    "Timestamp": timestamp,                                 # frame-aligned timestamp
                    "alert_notification_validity": alert_notification_validity,  # merged gate list (one bool per alert)
                    "alert": alert_results,                                 # alert names that fired (e.g. ["Intruder Zone"])
                    "description": alert_description,                      # descriptions paired with alert_results
                    "RTSP_Link": None,                                      # reserved
                    "RTSP_Down": None,                                      # reserved
                }
                self.logger.info(
                    f"My-alert notification approved | frame_id={frame_id} "
                    f"| camera={camera_name} | alerts={alert_results}"
                )
            else:
                # Every alert is still suppressed by one or both gates
                self.logger.info(
                    f"My-alert notification suppressed by postfilter | frame_id={frame_id}"
                )

        # ── Branch C: AUTO-ALERT (anomaly model) ─────────────────────────────
        # Condition: the frame-level or object-level anomaly model (ML-based)
        # flagged this frame as anomalous, independent of any user-defined rule.
        # Gate: TRIPLE —
        #   1. autoalert_notification_email_service  (runtime flag from camera config)
        #   2. camera_configuration["Email_Auto_Alert"]  (MongoDB config flag)
        #   3. at least one of (object_anomaly_validity, frame_anomaly_validity) is True
        elif check == "auto_alert":
            self.logger.info(
                f"Evaluating auto_alert notification | frame_id={frame_id} "
                f"| object_anomaly_valid={object_anomaly_validity} "
                f"| frame_anomaly_valid={frame_anomaly_validity}"
            )

            # Gate condition:
            #   autoalert_notification_email_service — True if Email_Auto_Alert was set at service start
            #   camera_configuration.get("Email_Auto_Alert") — current MongoDB config value (re-checked live)
            #   At least one anomaly type passed the postfilter cooldown gate AND is still active on this frame
            if (
                autoalert_notification_email_service                         # service-level flag
                and camera_configuration.get("Email_Auto_Alert")            # camera-level flag from MongoDB
                and (
                    (object_anomaly_validity and object_anomaly_status)     # object anomaly: cooldown cleared AND model still active
                    or
                    (frame_anomaly_validity and frame_anomaly_status)       # frame anomaly: cooldown cleared AND model still active
                )
            ):
                # All three gates passed → build auto-alert payload
                notification_params = {
                    "camera": camera_name,                  # identifies which camera
                    "Type": "AutoAlert",                    # anomaly-model alert type tag
                    "frame_id": str(frame_id),              # trace ID
                    "Timestamp": timestamp,                 # frame-aligned timestamp
                    "alert_notification_validity": None,    # N/A for auto-alerts — no named alert list
                    "alert": None,                          # N/A — anomaly model has no named alert
                    "description": None,                    # N/A — no user-defined description for ML anomalies
                    "RTSP_Link": None,                      # reserved
                    "RTSP_Down": None,                      # reserved
                }
                self.logger.info(
                    f"Auto-alert notification approved | frame_id={frame_id} | camera={camera_name}"
                )
            else:
                # One or more of the three gates blocked the notification
                self.logger.info(
                    f"Auto-alert notification suppressed | frame_id={frame_id}"
                )

        # ── Step 4: RETURN ────────────────────────────────────────────────────
        # Return the 6-tuple that _handle_result destructures immediately after this call:
        #
        #   frame_anomaly_validity, object_anomaly_validity   → written to camera_config_dict cache
        #   alert_validity, no_object_validity                → written to camera_config_dict cache
        #   previous_alert_statuses                           → written back to Redis (24 h TTL)
        #   notification_params                               → if non-empty, published to Kafka
        #                                                        notification_service topic

        self.logger.info(
            f"send_notification complete | frame_id={frame_id} | camera={camera_name} "
            f"| notification_will_send={bool(notification_params)}"
        )
        return (
            frame_anomaly_validity,    # bool: frame anomaly cooldown gate result
            object_anomaly_validity,   # bool: object anomaly cooldown gate result
            alert_validity,            # list[bool]: per-detection-alert gate results
            no_object_validity,        # list[bool]: per-no-object-alert gate results
            previous_alert_statuses,   # dict: updated cooldown state → Redis
            notification_params        # dict: Kafka payload, or {} to suppress
        )

    # ── PPE branch ────────────────────────────────────────────────────────────

    def send_ppe_notification(self, camera_name, violated, missing, severity, timestamp, previous_alert_statuses):
        """
        Gate and build a notification payload for a PPE compliance-stream message.

        Parallel to ``send_notification`` above but for the PPE pipeline
        (``ppe_alert_consumer.py`` → ``post_processing`` topic), which forwards
        every frame regardless of severity. Gating is delegated to
        ``postfilter.ppe_status_check`` — a single shared per-camera cooldown,
        since PPE violated-item names aren't pre-registered per camera the way
        user-defined detection alerts are (see that function's docstring).

        Parameters
        ----------
        camera_name : str
        violated : list[str]
            PPE items violated on this frame (e.g. ``["No-Helmet"]``).
        missing : list[str]
            Base PPE item names missing (paired with ``violated``).
        severity : str
            One of ``"critical" | "high" | "medium" | "low" | "none"``.
        timestamp : str
            Frame-aligned timestamp string.
        previous_alert_statuses : dict
            Per-camera cooldown state loaded from Redis by the caller.

        Returns
        -------
        tuple[dict, dict]
            ``(previous_alert_statuses, notification_params)`` — caller must
            persist the former to Redis and publish the latter to Kafka if
            non-empty.
        """
        has_violation = bool(violated) and severity not in (None, "none")
        notification_params = {}
        try:
            ppe_validity, previous_alert_statuses = postfilter.ppe_status_check(
                has_violation, previous_alert_statuses, time_interval=0.5, logger=self.logger
            )
            if ppe_validity:
                notification_params = {
                    "camera": camera_name,
                    "Type": "PPE Alert",
                    "frame_id": None,
                    "Timestamp": timestamp,
                    "alert_notification_validity": [True],
                    "alert": violated,
                    "description": [f"Missing: {', '.join(missing or [])} (severity: {severity})"],
                    "RTSP_Link": None,
                    "RTSP_Down": None,
                }
                self.logger.info(f"PPE notification approved | camera={camera_name} | severity={severity}")
            else:
                self.logger.info(f"PPE notification suppressed by cooldown | camera={camera_name}")
        except Exception as e:
            self.logger.exception(f"PPE postfilter failed | camera={camera_name}: {e}")
        return previous_alert_statuses, notification_params

    # ── Jewelry branch ───────────────────────────────────────────────────────

    def send_jewelry_notification(self, camera_name, rule, zone, severity, timestamp, previous_alert_statuses):
        """
        Gate and build a notification payload for a jewelry rule-engine event.

        Parallel to ``send_ppe_notification`` but for the jewelry pipeline
        (``jewelry_alert_consumer.py`` → ``post_processing`` topic). Gating is
        delegated to ``postfilter.jewelry_status_check`` — a short per-(camera,
        rule) window, since the rule itself already cooldown-gated at the
        source (see jewelry_rules.AlertBus); this is dedup insurance against
        Kafka at-least-once redelivery, not a real behavioral cooldown.

        Parameters
        ----------
        camera_name : str
        rule : str
            The rule that fired (e.g. "LOITERING").
        zone : str, optional
            The zone/line name the rule fired against, if any.
        severity : str
            One of "critical" | "high" | "medium" | "low".
        timestamp : str
            Frame-aligned timestamp string.
        previous_alert_statuses : dict
            Per-camera cooldown state loaded from Redis by the caller.

        Returns
        -------
        tuple[dict, dict]
            ``(previous_alert_statuses, notification_params)`` — caller must
            persist the former to Redis and publish the latter to Kafka if
            non-empty.
        """
        notification_params = {}
        try:
            jewelry_validity, previous_alert_statuses = postfilter.jewelry_status_check(
                rule, previous_alert_statuses, logger=self.logger
            )
            if jewelry_validity:
                notification_params = {
                    "camera": camera_name,
                    "Type": "Jewelry Alert",
                    "frame_id": None,
                    "Timestamp": timestamp,
                    "alert_notification_validity": [True],
                    "alert": [rule],
                    "description": [f"{rule.replace('_', ' ').title()} (severity: {severity})" + (f" in {zone}" if zone else "")],
                    "RTSP_Link": None,
                    "RTSP_Down": None,
                }
                self.logger.info(f"Jewelry notification approved | camera={camera_name} | rule={rule} | severity={severity}")
            else:
                self.logger.info(f"Jewelry notification suppressed by cooldown | camera={camera_name} | rule={rule}")
        except Exception as e:
            self.logger.exception(f"Jewelry postfilter failed | camera={camera_name}: {e}")
        return previous_alert_statuses, notification_params
