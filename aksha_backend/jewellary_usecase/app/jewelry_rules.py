"""
jewelry_rules.py — jewelry store rule engine.

Ported from the reference notebook (jewelry_store_ai_surveillance_aksha.py,
sections "7 - The alert bus" and "8 - Rule engine"), adapted from a batch/video
pipeline to a live per-camera streaming service (see jewelry_reader.py):

  - AlertBus.emit() now produces to Kafka topic "jewelry_results" instead of
    writing a local JSONL file — jewelry_alert_consumer.py picks these up the
    same way ppe_alert_consumer.py picks up ppe_results.
  - There is no synthetic "stream_start_time" here — this runs against a live
    camera, so wall-clock time (time.time() / datetime.now()) is used directly
    for both rule timers and the after-hours check.

Explicitly excluded (per scope): FaceRecognitionRule and everything that
depends on it (staff vault access, unauthorized-vault, attendance, VIP/
blacklist). Every rule below is detection/zone/timer/tracking driven only.
"""

import base64
import json
import math
import os
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional

import cv2
import numpy as np
from kafka import KafkaProducer

from jewelry_zones import foot_point, box_centre, iou

TOPIC = "jewelry_results"

CFG = {
    # ---- inference ---------------------------------------------------------
    "conf_threshold": 0.25,
    "iou_threshold": 0.50,
    "imgsz": 640,

    # ---- business hours (after-hours intrusion) -----------------------------
    "business_hours": {"open": "10:00", "close": "20:30"},

    # ---- rule thresholds ---------------------------------------------------
    "helmet_sustain_frames": 3,
    "loiter_seconds": 8.0,
    "queue_min_people": 3,
    "queue_sustain_seconds": 4.0,
    "open_state_seconds": 8.0,
    "bag_unattended_seconds": 8.0,
    "bag_unattended_radius_px": 180,
    "fall_sustain_frames": 5,
    "occupancy_alert_threshold": 12,

    # ---- camera health -----------------------------------------------------
    "tamper_blur_var": 45.0,
    "tamper_dark_mean": 28.0,
    "tamper_scene_corr": 0.35,
    "tamper_sustain_frames": 8,
    "offline_timeout_s": 5.0,
    "min_healthy_fps": 5.0,

    # ---- alerting ------------------------------------------------------------
    "alert_cooldown_s": 10.0,

    # ---- class bindings ------------------------------------------------------
    # Left = logical role a rule asks for. Right = class name as embedded in
    # yolov10.onnx's own metadata (read via ultralytics' model.names at
    # runtime — NOT object_detection_service/coco.names, which is a stale,
    # differently-formatted duplicate: verified by actually loading the model,
    # its real names are {'person','supine person','helmet','no_helmet','car',
    # 'bicycle','truck','motorbike','backpack','handbag','gate_open',
    # 'gate_closed','fork_lift'} — underscores on no_helmet/gate_open/
    # gate_closed, space on "supine person". Retrain with the jewelry-specific
    # Phase-1 classes and only this map changes.
    "class_map": {
        "person": "person",
        "fallen": "supine person",
        "bag": ["backpack", "handbag"],
        "showcase_open": "gate_open",       # proxy -> "showcase_open"
        "showcase_closed": "gate_closed",   # proxy -> "showcase_closed"
        "cash_drawer_open": None,           # -> "cash_drawer" (not in model yet)
        "safe_door_open": None,             # -> "safe_door"   (not in model yet)
    },
}

# Human-readable rule/alert-type name -> severity. These names are exactly
# what deployment/Aksha/labels_jewelry.txt lists as "Object of Interest"
# options, and what post_processor prefixes with "JEWELRY_" when writing to
# the shared `alerts` collection.
SEVERITY = {
    "AFTER_HOURS_INTRUSION": "CRITICAL",
    "COUNTER_JUMP": "CRITICAL",
    "CAMERA_TAMPERING": "CRITICAL",
    "CAMERA_OFFLINE": "CRITICAL",
    "FACE_CONCEALMENT_INDOORS": "CRITICAL",
    "SHOWCASE_LEFT_OPEN": "HIGH",
    "CASH_DRAWER_OPEN": "HIGH",
    "SAFE_DOOR_OPEN": "HIGH",
    "RESTRICTED_AREA_ENTRY": "HIGH",
    "PERSON_FALL": "HIGH",
    "BAG_LEFT_BEHIND": "HIGH",
    "LOITERING": "MEDIUM",
    "QUEUE_BUILDUP": "MEDIUM",
    "OCCUPANCY_EXCEEDED": "MEDIUM",
}


def resolve_role_ids(cfg, name_to_id):
    """Map every CFG['class_map'] role to the set of class ids present in the
    loaded model. A role with no matching class in the model resolves to an
    empty set, and any rule that depends on it simply idles."""
    role_ids = {}
    for role, spec in cfg["class_map"].items():
        if spec is None:
            role_ids[role] = set()
            continue
        names = spec if isinstance(spec, list) else [spec]
        role_ids[role] = {name_to_id[n] for n in names if n in name_to_id}
    return role_ids


@dataclass
class FrameContext:
    frame: np.ndarray
    frame_idx: int
    t_now: float           # time.time() at this frame
    wall_time: datetime    # real wall-clock time
    dets: list             # all detections
    persons: list          # detections in the "person" role
    dt: float              # seconds since previous processed frame


class AlertBus:
    """Kafka-backed counterpart of the notebook's file-based AlertBus."""

    SCHEMA_VERSION = "1.0"

    def __init__(self, cfg, camera_name, producer, logger):
        self.cfg, self.camera_name, self.producer, self.logger = cfg, camera_name, producer, logger
        self._last_fired = {}      # (alert_type, subject) -> t_now of last fire

    def _cooldown_ok(self, alert_type, subject, t_now):
        key = (alert_type, subject)
        last = self._last_fired.get(key)
        if last is not None and (t_now - last) < self.cfg["alert_cooldown_s"]:
            return False
        self._last_fired[key] = t_now
        return True

    def emit(self, alert_type, *, t_now, wall_time, frame_idx, frame=None,
              subject="global", confidence=1.0, track_id=None, zone=None,
              box=None, metadata=None):
        if not self._cooldown_ok(alert_type, subject, t_now):
            return None

        frame_b64 = None
        if frame is not None:
            ok, buf = cv2.imencode(".jpg", frame)
            if ok:
                frame_b64 = base64.b64encode(buf.tobytes()).decode("utf-8")

        payload = {
            "schema_version": self.SCHEMA_VERSION,
            "event_id": str(uuid.uuid4()),
            "camera_name": self.camera_name,
            # Named "rule", not "alert_type" — post_processor reserves
            # "alert_type" as the pipeline dispatch tag ("jewelry", matching
            # PPE's "ppe" convention); jewelry_alert_consumer.py sets that
            # tag when it forwards this payload. This field is the specific
            # rule that fired (e.g. "LOITERING").
            "rule": alert_type,
            "severity": SEVERITY.get(alert_type, "MEDIUM").lower(),
            "confidence": round(float(confidence), 3),
            "track_id": track_id,
            "zone": zone,
            "bbox": [round(v) for v in box] if box else None,
            "frame_id": frame_idx,
            "timestamp": wall_time.isoformat(),
            "frame": frame_b64,
            "metadata": metadata or {},
        }
        try:
            self.producer.send(TOPIC, payload)
            self.logger.info(f"[JEWELRY ALERT SENT] type={alert_type} | subject={subject} | zone={zone}")
        except Exception as e:
            self.logger.error(f"Failed to publish jewelry alert | type={alert_type} | error={e}")
        return payload


class Rule:
    alert_type = "GENERIC"

    def __init__(self, bus, cfg):
        self.bus, self.cfg = bus, cfg

    def update(self, ctx):
        raise NotImplementedError

    def fire(self, ctx, **kw):
        return self.bus.emit(self.alert_type, t_now=ctx.t_now, wall_time=ctx.wall_time,
                              frame_idx=ctx.frame_idx, frame=ctx.frame, **kw)


# ---------------------------------------------------------------- After-hours intrusion
class AfterHoursIntrusionRule(Rule):
    alert_type = "AFTER_HOURS_INTRUSION"

    def __init__(self, bus, cfg):
        super().__init__(bus, cfg)
        o = [int(x) for x in cfg["business_hours"]["open"].split(":")]
        c = [int(x) for x in cfg["business_hours"]["close"].split(":")]
        self.open_t = o[0] * 60 + o[1]
        self.close_t = c[0] * 60 + c[1]

    def _is_after_hours(self, wt):
        m = wt.hour * 60 + wt.minute
        if self.open_t <= self.close_t:
            return not (self.open_t <= m <= self.close_t)
        return self.close_t < m < self.open_t

    def update(self, ctx):
        if not self._is_after_hours(ctx.wall_time):
            return
        for d in ctx.persons:
            self.fire(ctx, subject=f"track:{d.track_id}", confidence=d.conf,
                      track_id=d.track_id, box=d.box,
                      metadata={"local_time": ctx.wall_time.strftime("%H:%M:%S"),
                                "business_hours": self.cfg["business_hours"]})


# ---------------------------------------------------------------- Face concealment indoors
class HelmetIndoorsRule(Rule):
    """Fires when a person is wearing a helmet / full-face covering indoors —
    the strongest early-warning signal for bike-borne snatch-and-grab. Uses the
    model's existing `helmet` class directly (no proxying, no face recognition)."""
    alert_type = "FACE_CONCEALMENT_INDOORS"

    def __init__(self, bus, cfg):
        super().__init__(bus, cfg)
        self._streak = defaultdict(int)

    def update(self, ctx):
        seen_this_frame = set()
        for d in ctx.dets:
            if d.cls_name != "helmet":
                continue
            key = d.track_id if d.track_id and d.track_id >= 0 else id(d)
            seen_this_frame.add(key)
            self._streak[key] += 1
            if self._streak[key] < self.cfg["helmet_sustain_frames"]:
                continue
            self.fire(ctx, subject=str(key), confidence=d.conf,
                      track_id=d.track_id if d.track_id and d.track_id >= 0 else None,
                      box=d.box, metadata={"detail": "helmet / face covering worn indoors"})
        for key in list(self._streak):
            if key not in seen_this_frame:
                self._streak[key] = 0


# ---------------------------------------------------------------- Counter jump
class CounterJumpRule(Rule):
    alert_type = "COUNTER_JUMP"

    def __init__(self, bus, cfg, line):
        super().__init__(bus, cfg)
        self.line = line
        self.prev = {}

    def update(self, ctx):
        for d in ctx.persons:
            if d.track_id < 0:
                continue
            p = foot_point(d.box)
            q = self.prev.get(d.track_id)
            self.prev[d.track_id] = p
            if q is None:
                continue
            direction = self.line.crossed(q, p)
            if direction and direction == self.line.alert_on:
                self.fire(ctx, subject=f"track:{d.track_id}", confidence=d.conf,
                          track_id=d.track_id, box=d.box, zone=self.line.name,
                          metadata={"direction": direction,
                                    "note": "person crossed into staff-only side"})


# ---------------------------------------------------------------- Loitering / restricted area
class ZoneDwellRule(Rule):
    # One class covers loitering (timed) and restricted-area entry (near-immediate).
    def __init__(self, bus, cfg, zone, alert_type, threshold_s):
        super().__init__(bus, cfg)
        self.zone, self.alert_type, self.threshold = zone, alert_type, threshold_s
        self.dwell = defaultdict(float)

    def update(self, ctx):
        inside = set()
        for d in ctx.persons:
            if d.track_id < 0 or not self.zone.contains(foot_point(d.box)):
                continue
            inside.add(d.track_id)
            self.dwell[d.track_id] += ctx.dt
            if self.dwell[d.track_id] >= self.threshold:
                self.fire(ctx, subject=f"{self.zone.name}:track:{d.track_id}",
                          confidence=d.conf, track_id=d.track_id, box=d.box,
                          zone=self.zone.name,
                          metadata={"dwell_seconds": round(self.dwell[d.track_id], 1),
                                    "threshold_seconds": self.threshold})
        for tid in list(self.dwell):
            if tid not in inside:
                self.dwell[tid] = max(0.0, self.dwell[tid] - ctx.dt * 2)


# ---------------------------------------------------------------- Queue buildup
class QueueRule(Rule):
    alert_type = "QUEUE_BUILDUP"

    def __init__(self, bus, cfg, zone):
        super().__init__(bus, cfg)
        self.zone = zone
        self.sustained = 0.0

    def update(self, ctx):
        in_q = [d for d in ctx.persons if self.zone.contains(foot_point(d.box))]
        n = len(in_q)
        self.sustained = self.sustained + ctx.dt if n >= self.cfg["queue_min_people"] else 0.0
        if self.sustained >= self.cfg["queue_sustain_seconds"]:
            self.fire(ctx, subject=self.zone.name, zone=self.zone.name,
                      metadata={"queue_length": n, "threshold": self.cfg["queue_min_people"]})
            self.sustained = 0.0


# ---------------------------------------------------------------- Footfall (counted, not alerted)
class FootfallRule(Rule):
    alert_type = "FOOTFALL"

    def __init__(self, bus, cfg, line):
        super().__init__(bus, cfg)
        self.line = line
        self.prev = {}
        self.entries, self.exits = set(), set()

    def update(self, ctx):
        for d in ctx.persons:
            if d.track_id < 0:
                continue
            p = foot_point(d.box)
            q = self.prev.get(d.track_id)
            self.prev[d.track_id] = p
            if q is None:
                continue
            direction = self.line.crossed(q, p)
            if direction == "a_to_b":
                self.entries.add(d.track_id)
            elif direction == "b_to_a":
                self.exits.add(d.track_id)


# ---------------------------------------------------------------- Occupancy
class OccupancyDwellRule(Rule):
    alert_type = "OCCUPANCY_EXCEEDED"

    def __init__(self, bus, cfg):
        super().__init__(bus, cfg)
        self.first_seen, self.last_seen = {}, {}

    def update(self, ctx):
        ids = {d.track_id for d in ctx.persons if d.track_id >= 0}
        for tid in ids:
            self.first_seen.setdefault(tid, ctx.t_now)
            self.last_seen[tid] = ctx.t_now
        if len(ids) > self.cfg["occupancy_alert_threshold"]:
            self.fire(ctx, subject="store",
                      metadata={"occupancy": len(ids),
                                "threshold": self.cfg["occupancy_alert_threshold"]})


# ------------------------------------------------- Showcase / cash drawer / safe door
class OpenStateTimerRule(Rule):
    # Showcase left open, cash drawer open, safe door open - the same rule with a
    # different class binding. Currently bound to proxy classes; retrain and only
    # the binding in CFG['class_map'] changes.
    def __init__(self, bus, cfg, role, alert_type, threshold_s, role_ids):
        super().__init__(bus, cfg)
        self.role, self.alert_type, self.threshold = role, alert_type, threshold_s
        self.ids = role_ids.get(role, set())
        self.open_since = {}

    @staticmethod
    def _key(box):
        # Fixtures don't move, so a coarse grid cell is a stable identity.
        cx, cy = box_centre(box)
        return (int(cx // 80), int(cy // 80))

    def update(self, ctx):
        if not self.ids:
            return
        seen = set()
        for d in ctx.dets:
            if d.cls_id not in self.ids:
                continue
            k = self._key(d.box)
            seen.add(k)
            self.open_since.setdefault(k, ctx.t_now)
            elapsed = ctx.t_now - self.open_since[k]
            if elapsed >= self.threshold:
                self.fire(ctx, subject=f"{self.role}:{k}", confidence=d.conf, box=d.box,
                          metadata={"open_seconds": round(elapsed, 1),
                                    "bound_class": d.cls_name, "logical_role": self.role})
        for k in list(self.open_since):
            if k not in seen:
                del self.open_since[k]


# ---------------------------------------------------------------- Camera tampering
class CameraTamperRule(Rule):
    alert_type = "CAMERA_TAMPERING"

    def __init__(self, bus, cfg):
        super().__init__(bus, cfg)
        self.baseline_hist = None
        self.streak = defaultdict(int)

    def update(self, ctx):
        gray = cv2.cvtColor(ctx.frame, cv2.COLOR_BGR2GRAY)
        blur_var = cv2.Laplacian(gray, cv2.CV_64F).var()
        mean_int = float(gray.mean())

        hist = cv2.calcHist([gray], [0], None, [64], [0, 256])
        cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
        if self.baseline_hist is None:
            self.baseline_hist = hist
            corr = 1.0
        else:
            corr = float(cv2.compareHist(self.baseline_hist, hist, cv2.HISTCMP_CORREL))
            self.baseline_hist = 0.98 * self.baseline_hist + 0.02 * hist

        checks = {
            "defocus_or_covered": blur_var < self.cfg["tamper_blur_var"],
            "blacked_out": mean_int < self.cfg["tamper_dark_mean"],
            "scene_changed": corr < self.cfg["tamper_scene_corr"],
        }
        for name, bad in checks.items():
            self.streak[name] = self.streak[name] + 1 if bad else 0
            if self.streak[name] == self.cfg["tamper_sustain_frames"]:
                self.fire(ctx, subject=name,
                          metadata={"reason": name, "blur_var": round(blur_var, 1),
                                    "mean_intensity": round(mean_int, 1),
                                    "hist_corr": round(corr, 3)})


# ---------------------------------------------------------------- Fall detection
class FallDetectionRule(Rule):
    alert_type = "PERSON_FALL"

    def __init__(self, bus, cfg, role_ids):
        super().__init__(bus, cfg)
        self.ids = role_ids.get("fallen", set())
        self.streak = defaultdict(int)

    def update(self, ctx):
        if not self.ids:
            return
        hits = [d for d in ctx.dets if d.cls_id in self.ids]
        seen = set()
        for d in hits:
            k = d.track_id if d.track_id >= 0 else int(box_centre(d.box)[0] // 60)
            seen.add(k)
            self.streak[k] += 1
            if self.streak[k] == self.cfg["fall_sustain_frames"]:
                self.fire(ctx, subject=f"fall:{k}", confidence=d.conf,
                          track_id=d.track_id if d.track_id >= 0 else None, box=d.box,
                          metadata={"detected_class": d.cls_name})
        for k in list(self.streak):
            if k not in seen:
                self.streak[k] = 0


# ---------------------------------------------------------------- Bag left behind
class UnattendedBagRule(Rule):
    alert_type = "BAG_LEFT_BEHIND"

    def __init__(self, bus, cfg, role_ids):
        super().__init__(bus, cfg)
        self.ids = role_ids.get("bag", set())
        self.static_since = {}

    def update(self, ctx):
        if not self.ids:
            return
        people = [foot_point(d.box) for d in ctx.persons]
        seen = set()
        for d in ctx.dets:
            if d.cls_id not in self.ids:
                continue
            c = box_centre(d.box)
            k = (int(c[0] // 60), int(c[1] // 60))
            seen.add(k)
            t0, c0 = self.static_since.get(k, (ctx.t_now, c))
            if math.dist(c, c0) > 40:
                t0, c0 = ctx.t_now, c
            self.static_since[k] = (t0, c0)
            near = any(math.dist(c, p) < self.cfg["bag_unattended_radius_px"] for p in people)
            elapsed = ctx.t_now - t0
            if not near and elapsed >= self.cfg["bag_unattended_seconds"]:
                self.fire(ctx, subject=f"bag:{k}", confidence=d.conf, box=d.box,
                          metadata={"unattended_seconds": round(elapsed, 1),
                                    "detected_class": d.cls_name})
        for k in list(self.static_since):
            if k not in seen:
                del self.static_since[k]


def arm_rules(bus, cfg, zones, lines, role_ids):
    """Build every rule for one camera, mirroring the notebook's Pipeline._arm()."""
    rules = [
        AfterHoursIntrusionRule(bus, cfg),
        HelmetIndoorsRule(bus, cfg),
        CameraTamperRule(bus, cfg),
        FallDetectionRule(bus, cfg, role_ids),
        UnattendedBagRule(bus, cfg, role_ids),
        OccupancyDwellRule(bus, cfg),
    ]

    for name, l in lines.items():
        if l.role == "counter_jump":
            rules.append(CounterJumpRule(bus, cfg, l))
        elif l.role == "footfall":
            rules.append(FootfallRule(bus, cfg, l))

    for name, z in zones.items():
        if z.role == "loiter":
            rules.append(ZoneDwellRule(bus, cfg, z, "LOITERING", cfg["loiter_seconds"]))
        elif z.role == "restricted":
            rules.append(ZoneDwellRule(bus, cfg, z, "RESTRICTED_AREA_ENTRY", 0.4))
        elif z.role == "queue":
            rules.append(QueueRule(bus, cfg, z))

    rules += [
        OpenStateTimerRule(bus, cfg, "showcase_open", "SHOWCASE_LEFT_OPEN", cfg["open_state_seconds"], role_ids),
        OpenStateTimerRule(bus, cfg, "cash_drawer_open", "CASH_DRAWER_OPEN", cfg["open_state_seconds"], role_ids),
        OpenStateTimerRule(bus, cfg, "safe_door_open", "SAFE_DOOR_OPEN", cfg["open_state_seconds"], role_ids),
    ]
    return rules


def load_kafka_producer():
    server = os.environ.get("KAFKA_BOOTSTRAP_SERVERS")
    if not server:
        server = "broker:9092" if os.path.exists("/.dockerenv") else "localhost:9092"
    return KafkaProducer(
        bootstrap_servers=server,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )
