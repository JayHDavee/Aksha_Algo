import * as express from 'express';
import mongoose from 'mongoose';

/**
 * Jewelry Dashboard Routes
 *
 * Reads from the shared `alerts` MongoDB collection (written directly by
 * post_processor's _handle_jewelry_result — see aksha_backend/post_processor)
 * filtered to alert_type values prefixed "JEWELRY_". Behind the
 * JEWELRY_DETECTION feature flag at the route level, matching how the
 * Detection Type selector is gated for camera creation.
 *
 * Note: these endpoints report alert-derived metrics only. True continuous
 * footfall/occupancy time series would need a periodic snapshot emitted from
 * the jewelry detection service (it currently only emits on a fired rule, to
 * keep Kafka/Mongo write volume down) — not implemented in this pass, so the
 * "footfall" endpoint below reports hourly alert volume, not true footfall.
 */

const router = express.Router();

const JEWELRY_ALERT_TYPE_REGEX = /^JEWELRY_/;

function requireJewelryFlag(req: any, res: any, next: any) {
  if (process.env.JEWELRY_DETECTION !== "true") {
    return res.status(403).json({ success: false, message: "Jewelry detection is not enabled" });
  }
  next();
}

function alertsCollection() {
  return mongoose.connection.db.collection("alerts");
}

// Strips the AKSHA_PATH prefix from an absolute frame_path and returns a
// browser-servable URL, mirroring the pattern used in insight.ts.
function frameUrl(framePath: string | null | undefined): string | null {
  if (!framePath) return null;
  const akshaPath = process.env.AKSHA_PATH || "";
  const relative = akshaPath && framePath.startsWith(akshaPath)
    ? framePath.slice(akshaPath.length).replace(/^\/+/, "")
    : framePath.replace(/^\/+/, "");
  return `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${relative}`;
}

router.get(process.env.JEWELRY_DASHBOARD_SUMMARY || '/jewelry/dashboard/summary', requireJewelryFlag, async (req: any, res: any) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [activeAlerts, alertsToday, criticalActive, bySeverityAgg] = await Promise.all([
      alertsCollection().countDocuments({ alert_type: JEWELRY_ALERT_TYPE_REGEX, status: "NEW" }),
      alertsCollection().countDocuments({ alert_type: JEWELRY_ALERT_TYPE_REGEX, timestamp: { $gte: startOfToday } }),
      alertsCollection().countDocuments({ alert_type: JEWELRY_ALERT_TYPE_REGEX, status: "NEW", severity: /^critical$/i }),
      alertsCollection().aggregate([
        { $match: { alert_type: JEWELRY_ALERT_TYPE_REGEX, status: "NEW" } },
        { $group: { _id: { $toLower: "$severity" }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const row of bySeverityAgg) {
      if (row._id in bySeverity) bySeverity[row._id] = row.count;
    }

    res.status(200).json({
      success: true,
      summary: {
        active_alerts: activeAlerts,
        alerts_today: alertsToday,
        critical_active: criticalActive,
        by_severity: bySeverity,
      },
    });
  } catch (error: any) {
    console.log("jewelry dashboard summary error", error);
    res.status(500).json({ success: false, message: "unable to fetch jewelry dashboard summary" });
  }
});

router.get(process.env.JEWELRY_DASHBOARD_ALERTS || '/jewelry/dashboard/alerts', requireJewelryFlag, async (req: any, res: any) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const cameraName = req.query.camera_name as string | undefined;

    const query: any = { alert_type: JEWELRY_ALERT_TYPE_REGEX };
    if (cameraName) query.cam_name = cameraName;

    const rows = await alertsCollection()
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    const alerts = rows.map((row: any) => ({
      id: row._id,
      camera_name: row.cam_name,
      rule: typeof row.alert_type === "string" ? row.alert_type.replace(JEWELRY_ALERT_TYPE_REGEX, "") : null,
      severity: row.severity,
      zone: row.metadata?.zone ?? null,
      timestamp: row.timestamp,
      status: row.status,
      frame_url: frameUrl(row.frame_path),
    }));

    res.status(200).json({ success: true, alerts });
  } catch (error: any) {
    console.log("jewelry dashboard alerts error", error);
    res.status(500).json({ success: false, message: "unable to fetch jewelry alerts" });
  }
});

router.get(process.env.JEWELRY_DASHBOARD_FOOTFALL || '/jewelry/dashboard/footfall', requireJewelryFlag, async (req: any, res: any) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await alertsCollection().aggregate([
      { $match: { alert_type: JEWELRY_ALERT_TYPE_REGEX, timestamp: { $gte: since } } },
      { $group: { _id: { $hour: "$timestamp" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();

    const hourly = rows.map((row: any) => ({ hour: row._id, alert_count: row.count }));

    res.status(200).json({
      success: true,
      note: "Hourly alert volume, not true footfall — a continuous footfall metric needs a periodic snapshot the detection service does not yet emit.",
      hourly,
    });
  } catch (error: any) {
    console.log("jewelry dashboard footfall error", error);
    res.status(500).json({ success: false, message: "unable to fetch jewelry alert volume" });
  }
});

export default router;
