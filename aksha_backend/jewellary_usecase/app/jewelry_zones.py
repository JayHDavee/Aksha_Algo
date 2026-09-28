"""
jewelry_zones.py — zone/line geometry for the jewelry rule engine.

Ported from the reference notebook (jewelry_store_ai_surveillance_aksha.py,
section "4 - Zones and lines"). Zones are stored normalized (0-1) so the same
layout works regardless of the camera's actual resolution.

No per-camera zone editor exists yet in the dashboard — every camera uses the
"default" layout below until that UI ships. Redraw these by hand for a given
store's counter/vault geometry.
"""

import numpy as np
import cv2
import math


def denorm_poly(pts, w, h):
    return np.array([[int(x * w), int(y * h)] for x, y in pts], dtype=np.int32)


def denorm_pt(p, w, h):
    return (int(p[0] * w), int(p[1] * h))


class Zone:
    def __init__(self, name, cfg, w, h):
        self.name, self.role = name, cfg["role"]
        self.poly = denorm_poly(cfg["points"], w, h)
        self.contour = self.poly.reshape((-1, 1, 2)).astype(np.int32)

    def contains(self, pt):
        return cv2.pointPolygonTest(self.contour, (float(pt[0]), float(pt[1])), False) >= 0


class Line:
    def __init__(self, name, cfg, w, h):
        self.name, self.role = name, cfg["role"]
        self.a, self.b = denorm_pt(cfg["a"], w, h), denorm_pt(cfg["b"], w, h)
        self.alert_on = cfg.get("alert_on")

    def side(self, pt):
        # >0 left of A->B, <0 right. Sign is the "which side" test.
        return ((self.b[0] - self.a[0]) * (pt[1] - self.a[1])
                - (self.b[1] - self.a[1]) * (pt[0] - self.a[0]))

    def crossed(self, p_prev, p_now):
        # Returns "a_to_b", "b_to_a" or None. Segment-segment intersection so a
        # track that teleports past the line's end doesn't count as a crossing.
        s1, s2 = self.side(p_prev), self.side(p_now)
        if s1 == 0 or s2 == 0 or (s1 > 0) == (s2 > 0):
            return None
        if not self._segments_intersect(p_prev, p_now, self.a, self.b):
            return None
        return "a_to_b" if s1 > 0 else "b_to_a"

    @staticmethod
    def _ccw(p, q, r):
        return (r[1] - p[1]) * (q[0] - p[0]) > (q[1] - p[1]) * (r[0] - p[0])

    @classmethod
    def _segments_intersect(cls, p1, p2, p3, p4):
        return (cls._ccw(p1, p3, p4) != cls._ccw(p2, p3, p4)
                and cls._ccw(p1, p2, p3) != cls._ccw(p1, p2, p4))


DEFAULT_ZONES = {
    "staff_side": {
        "type": "polygon", "role": "restricted",
        "points": [(0.42, 0.30), (0.72, 0.24), (0.86, 0.55), (0.55, 0.72), (0.40, 0.48)],
    },
    "gold_counter_front": {
        "type": "polygon", "role": "loiter",
        "points": [(0.05, 0.45), (0.42, 0.36), (0.52, 0.70), (0.30, 0.99), (0.02, 0.95)],
    },
    "billing_queue": {
        "type": "polygon", "role": "queue",
        "points": [(0.60, 0.60), (0.99, 0.52), (0.99, 0.99), (0.62, 0.99)],
    },
}

DEFAULT_LINES = {
    # A -> B. "inside" is the LEFT-hand side of the vector A->B.
    "counter_boundary": {
        "role": "counter_jump",
        "a": (0.40, 0.34), "b": (0.86, 0.56),
        "alert_on": "a_to_b",       # customer side -> staff side
    },
    "entrance": {
        "role": "footfall",
        "a": (0.00, 0.30), "b": (0.30, 0.22),
        "alert_on": None,           # counted, not alerted
    },
}

ZONE_SETS = {
    "default": {"zones": DEFAULT_ZONES, "lines": DEFAULT_LINES},
    # Add a per-camera layout here (e.g. "vault_cam": {...}) once a zone editor exists.
}


def layout_for(zone_set_key):
    key = zone_set_key or "default"
    if key not in ZONE_SETS:
        key = "default"
    return ZONE_SETS[key]


def build_geometry(zone_set_key, w, h):
    # Zones are denormalized against THIS camera's frame size, so a 720p and a
    # 4K camera can share the same normalized layout.
    L = layout_for(zone_set_key)
    zones = {n: Zone(n, c, w, h) for n, c in L["zones"].items()}
    lines = {n: Line(n, c, w, h) for n, c in L["lines"].items()}
    return zones, lines


def foot_point(box):
    # Bottom-centre of the box ~ where the person stands. Far more reliable than
    # the centroid for zone tests on an overhead camera.
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, y2)


def box_centre(box):
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0
