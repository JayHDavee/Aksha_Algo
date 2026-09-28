"""
ppe_dashboard_service — FastAPI backend for the PPE violation dashboard.

Reads exclusively from the shared `alerts` collection, filtered to
alert_type="PPE_VIOLATION" (see the Phase 2 design doc, Section 4.1).
Written by post_processor's dual-write, deployed and confirmed working
against real violation data before this service was built.

Does NOT touch meta_ppe_<camera> — that collection continues to serve
its original purpose (continuous per-frame compliance stream) unchanged.
"""

import os
import csv
import io
import json
import logging
import datetime as dt
from typing import Optional

from fastapi import FastAPI, Query, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from pymongo import MongoClient
from bson import ObjectId
import redis.asyncio as aioredis

# -------------------- CONFIG --------------------

MONGODB_URI = os.environ.get(
    "MONGODB_URI", "mongodb://mongo:mongo@mongodb/Aksha?authSource=admin&tls=false"
)
REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
REDIS_PPE_CHANNEL = os.environ.get("REDIS_PPE_CHANNEL", "ppe_live_alerts")
AKSHA_PATH = os.environ.get("AKSHA_PATH", "/Aksha")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ppe_dashboard_service")

client = MongoClient(MONGODB_URI)
db = client["Aksha"]
alerts = db["alerts"]

app = FastAPI(title="PPE Dashboard Service")

MATCH_PPE = {"alert_type": "PPE_VIOLATION"}


def serialize(doc):
    doc["_id"] = str(doc["_id"])
    if isinstance(doc.get("timestamp"), dt.datetime):
        doc["timestamp"] = doc["timestamp"].isoformat()
    if isinstance(doc.get("acknowledged_at"), dt.datetime):
        doc["acknowledged_at"] = doc["acknowledged_at"].isoformat()
    if isinstance(doc.get("resolved_at"), dt.datetime):
        doc["resolved_at"] = doc["resolved_at"].isoformat()
    return doc


# -------------------- 1. STATS TODAY --------------------

@app.get("/ppe/stats/today")
def stats_today():
    today_start = dt.datetime.combine(dt.date.today(), dt.time.min)

    by_severity = list(alerts.aggregate([
        {"$match": {**MATCH_PPE, "timestamp": {"$gte": today_start}}},
        {"$group": {"_id": "$severity", "count": {"$sum": 1}}},
    ]))
    total_today = sum(x["count"] for x in by_severity)

    active_cameras = len(alerts.distinct(
        "cam_name", {**MATCH_PPE, "timestamp": {"$gte": today_start}}
    ))
    resolved_count = alerts.count_documents({
        **MATCH_PPE, "timestamp": {"$gte": today_start}, "status": "RESOLVED"
    })

    return {
        "success": True,
        "violations_today": total_today,
        "active_cameras": active_cameras,
        "resolved_today": resolved_count,
        "by_severity": {x["_id"]: x["count"] for x in by_severity},
    }


# -------------------- 2. LIVE FEED --------------------

@app.get("/ppe/violations/live")
def violations_live():
    docs = alerts.find(MATCH_PPE).sort("timestamp", -1).limit(50)
    return {"success": True, "violations": [serialize(d) for d in docs]}


# -------------------- 3. SEARCH --------------------

def build_search_match(cam, vtype, severity, date_from, date_to):
    match = dict(MATCH_PPE)
    if cam:
        match["cam_name"] = cam
    if vtype:
        match["metadata.violated_ppe"] = vtype
    if severity:
        match["severity"] = severity
    if date_from or date_to:
        ts = {}
        if date_from:
            ts["$gte"] = dt.datetime.fromisoformat(date_from)
        if date_to:
            ts["$lte"] = dt.datetime.fromisoformat(date_to)
        match["timestamp"] = ts
    return match


@app.get("/ppe/violations/search")
def violations_search(
    cam: Optional[str] = None,
    type: Optional[str] = None,
    severity: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 25,
):
    match = build_search_match(cam, type, severity, date_from, date_to)
    total = alerts.count_documents(match)
    docs = (
        alerts.find(match)
        .sort("timestamp", -1)
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "success": True,
        "total": total,
        "page": page,
        "page_size": page_size,
        "violations": [serialize(d) for d in docs],
    }


# -------------------- 4. HEATMAP --------------------

@app.get("/ppe/heatmap")
def heatmap():
    totals = list(alerts.aggregate([
        {"$match": MATCH_PPE},
        {"$group": {"_id": "$cam_name", "total": {"$sum": 1}}},
        {"$sort": {"total": -1}},
    ]))
    by_item = list(alerts.aggregate([
        {"$match": MATCH_PPE},
        {"$unwind": "$metadata.violated_ppe"},
        {"$group": {
            "_id": {"cam": "$cam_name", "item": "$metadata.violated_ppe"},
            "count": {"$sum": 1},
        }},
    ]))
    breakdown = {}
    for row in by_item:
        cam = row["_id"]["cam"]
        item = row["_id"]["item"]
        breakdown.setdefault(cam, {})[item] = row["count"]

    return {
        "success": True,
        "cameras": [
            {"cam_name": t["_id"], "total": t["total"], "by_item": breakdown.get(t["_id"], {})}
            for t in totals
        ],
    }


# -------------------- 5. TREND --------------------

@app.get("/ppe/trend")
def trend(interval: str = Query("hour", pattern="^(hour|day)$"), series: Optional[str] = None):
    now = dt.datetime.now()
    if interval == "hour":
        window_start = now - dt.timedelta(hours=24)
        group_expr = {"$hour": "$timestamp"}
    else:
        window_start = now - dt.timedelta(days=30)
        group_expr = {"$dayOfMonth": "$timestamp"}

    group_id = {"bucket": group_expr}
    if series == "type":
        group_id["series"] = "$metadata.violated_ppe"
    elif series == "camera":
        group_id["series"] = "$cam_name"
    elif series == "severity":
        group_id["series"] = "$severity"

    pipeline = [
        {"$match": {**MATCH_PPE, "timestamp": {"$gte": window_start}}},
    ]
    if series == "type":
        pipeline.append({"$unwind": "$metadata.violated_ppe"})
    pipeline += [
        {"$group": {"_id": group_id, "count": {"$sum": 1}}},
        {"$sort": {"_id.bucket": 1}},
    ]
    rows = list(alerts.aggregate(pipeline))
    return {"success": True, "interval": interval, "series": series, "data": rows}


# -------------------- 6. FRAME / CROP IMAGE --------------------

@app.get("/ppe/frame/{alert_id}")
def get_frame(alert_id: str, type: str = Query("frame", pattern="^(frame|crop)$")):
    try:
        doc = alerts.find_one({"_id": ObjectId(alert_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid alert id")
    if not doc:
        raise HTTPException(status_code=404, detail="Alert not found")

    path = doc.get("frame_path") if type == "frame" else doc.get("person_crop_path")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"{type} image not available for this alert")
    return FileResponse(path, media_type="image/jpeg")


# -------------------- 7. ACKNOWLEDGE --------------------

@app.post("/ppe/acknowledge/{alert_id}")
def acknowledge(alert_id: str, acknowledged_by: str = Query(...)):
    try:
        oid = ObjectId(alert_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid alert id")
    result = alerts.update_one(
        {"_id": oid},
        {"$set": {
            "status": "ACK",
            "acknowledged_by": acknowledged_by,
            "acknowledged_at": dt.datetime.now(),
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"success": True}


# -------------------- 8. RESOLVE --------------------

@app.post("/ppe/resolve/{alert_id}")
def resolve(alert_id: str):
    try:
        oid = ObjectId(alert_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid alert id")
    result = alerts.update_one(
        {"_id": oid},
        {"$set": {"status": "RESOLVED", "resolved_at": dt.datetime.now()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"success": True}


# -------------------- 9. SHIFT REPORT --------------------

SHIFT_WINDOWS = {
    "morning": (dt.time(6, 0), dt.time(14, 0)),
    "afternoon": (dt.time(14, 0), dt.time(22, 0)),
    "night": (dt.time(22, 0), dt.time(6, 0)),
}


@app.get("/ppe/report/shift")
def shift_report(shift: str = Query(..., pattern="^(morning|afternoon|night)$"), date: Optional[str] = None):
    day = dt.date.fromisoformat(date) if date else dt.date.today()
    start_t, end_t = SHIFT_WINDOWS[shift]
    shift_start = dt.datetime.combine(day, start_t)
    if shift == "night":
        shift_end = dt.datetime.combine(day + dt.timedelta(days=1), end_t)
    else:
        shift_end = dt.datetime.combine(day, end_t)

    pipeline = [
        {"$match": {**MATCH_PPE, "timestamp": {"$gte": shift_start, "$lt": shift_end}}},
        {"$facet": {
            "total": [{"$count": "count"}],
            "worst_camera": [
                {"$group": {"_id": "$cam_name", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}}, {"$limit": 1},
            ],
            "most_common": [
                {"$unwind": "$metadata.violated_ppe"},
                {"$group": {"_id": "$metadata.violated_ppe", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}}, {"$limit": 1},
            ],
            "peak_hour": [
                {"$group": {"_id": {"$hour": "$timestamp"}, "n": {"$sum": 1}}},
                {"$sort": {"n": -1}}, {"$limit": 1},
            ],
        }},
    ]
    result = list(alerts.aggregate(pipeline))[0]

    return {
        "success": True,
        "shift": shift,
        "date": day.isoformat(),
        "total_violations": result["total"][0]["count"] if result["total"] else 0,
        "worst_camera": result["worst_camera"][0] if result["worst_camera"] else None,
        "most_common_violation": result["most_common"][0] if result["most_common"] else None,
        "peak_hour": result["peak_hour"][0] if result["peak_hour"] else None,
        "compliant_percent": None,
    }


# -------------------- 10. EXPORT CSV --------------------

@app.get("/ppe/export/csv")
def export_csv(
    cam: Optional[str] = None,
    type: Optional[str] = None,
    severity: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    match = build_search_match(cam, type, severity, date_from, date_to)
    docs = alerts.find(match).sort("timestamp", -1)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp", "cam_name", "severity", "violated_ppe", "missing_ppe", "status"])
    for d in docs:
        writer.writerow([
            d.get("timestamp"),
            d.get("cam_name"),
            d.get("severity"),
            ";".join(d.get("metadata", {}).get("violated_ppe", [])),
            ";".join(d.get("metadata", {}).get("missing_ppe", [])),
            d.get("status"),
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=ppe_violations.csv"},
    )


# -------------------- 11. WEBSOCKET LIVE FEED --------------------

connected_clients: set = set()


@app.websocket("/ppe/live")
async def ws_live(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f"WS client connected | total={len(connected_clients)}")
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(websocket)
        logger.info(f"WS client disconnected | total={len(connected_clients)}")


async def redis_subscriber():
    r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe(REDIS_PPE_CHANNEL)
    logger.info(f"Subscribed to Redis channel: {REDIS_PPE_CHANNEL}")
    async for message in pubsub.listen():
        if message["type"] != "message":
            continue
        dead = []
        for ws in connected_clients:
            try:
                await ws.send_text(message["data"])
            except Exception:
                dead.append(ws)
        for ws in dead:
            connected_clients.discard(ws)

_background_tasks = set()

@app.on_event("startup")
async def on_startup():
    import asyncio
    task = asyncio.create_task(redis_subscriber())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    logger.info("ppe_dashboard_service started")


@app.get("/health")
def health():
    return {"success": True, "service": "ppe_dashboard_service"}
