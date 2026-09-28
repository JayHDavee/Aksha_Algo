"""
ppe_alerts.py — Person-PPE association, violation classification, and severity.

Takes the flat detection list from ppe_detection.get_labels() and the frame
itself, and produces per-person structured alert data matching the
ppe_results Kafka payload schema (Step 5 of the PPE integration task).

Class mapping (8-class Harness model):
  worn classes:      Helmet, Harness, Shoes, Goggles
  violated classes:  No-Helmet, No-Shoes, No-Goggles
  (No "No-Harness" class exists — harness absence is inferred, not detected
   explicitly. Flagged as a known modeling gap.)
"""

WORN_CLASSES = {"Helmet", "Harness", "Shoes", "Goggles"}
VIOLATED_CLASSES = {"No-Helmet", "No-Shoes", "No-Goggles"}

# Maps a PPE item name (worn or violated form) to its severity level
SEVERITY_MAP = {
    "Helmet": "high",     "No-Helmet": "high",
    "Harness": "critical",  # no "No-Harness" class exists — see module docstring
    "Goggles": "medium",  "No-Goggles": "medium",
    "Shoes": "low",       "No-Shoes": "low",
}

# Base item name each violated/worn label maps to (for missing/violated pairing)
BASE_ITEM = {
    "Helmet": "Helmet",       "No-Helmet": "Helmet",
    "Harness": "Harness",
    "Goggles": "Goggles",     "No-Goggles": "Goggles",
    "Shoes": "Shoes",         "No-Shoes": "Shoes",
}


def _box_center(det):
    """Return (cx, cy) center point of a detection's bounding box."""
    return (det["x"] + det["w"] / 2, det["y"] + det["h"] / 2)


def _point_in_box(px, py, det, expand=0.3):
    """
    Check if point (px, py) falls within det's bounding box, expanded by
    `expand` fraction on each side (helmets sit above the person box,
    harnesses/shoes extend beyond it — a raw containment check misses these).
    """
    x, y, w, h = det["x"], det["y"], det["w"], det["h"]
    ex, ey = w * expand, h * expand
    return (x - ex) <= px <= (x + w + ex) and (y - ey) <= py <= (y + h + ey)


def associate_ppe_to_persons(detections):
    """
    Group PPE item detections under their nearest Person detection.

    Args:
        detections — list of dicts from ppe_detection.get_labels():
                     [{label, x, y, w, h, confidence}, ...]

    Returns:
        list of dicts, one per detected Person:
        [{
            "person_bbox": [x, y, w, h],
            "worn": [...],
            "violated": [...],
            "missing": [...],
            "severity": "critical" | "high" | "medium" | "low" | "none",
            "ppe_detections": [...],   # raw PPE detections assigned to this person
        }, ...]
    """
    persons = [d for d in detections if d["label"] == "Person"]
    ppe_items = [d for d in detections if d["label"] != "Person"]

    results = []
    for person in persons:
        px, py, pw, ph = person["x"], person["y"], person["w"], person["h"]
        assigned = []

        for item in ppe_items:
            icx, icy = _box_center(item)
            if _point_in_box(icx, icy, person):
                assigned.append(item)

        worn = [i["label"] for i in assigned if i["label"] in WORN_CLASSES]
        violated = [i["label"] for i in assigned if i["label"] in VIOLATED_CLASSES]

        # missing = same base items as violated (Approach A)
        missing = [BASE_ITEM[label] for label in violated]

        # severity = highest-priority violation present for this person
        severity_order = ["critical", "high", "medium", "low"]
        person_severities = [SEVERITY_MAP[label] for label in violated]
        severity = next((s for s in severity_order if s in person_severities), "none")

        results.append({
            "person_bbox": [px, py, pw, ph],
            "worn": worn,
            "violated": violated,
            "missing": missing,
            "severity": severity,
            "ppe_detections": assigned,
        })

    return results


def crop_person(frame, person_bbox):
    """Crop the person's region from the frame. Returns None if bbox is invalid."""
    x, y, w, h = person_bbox
    x, y = max(0, x), max(0, y)
    crop = frame[y:y + h, x:x + w]
    if crop.size == 0:
        return None
    return crop