import express, { Request, Response } from "express";
import mongoose from "mongoose";
import CameraNotificationManager from "../models/cameraNotificationManager";
import CameraGroup from "../models/cameraGroupSchema";

const router = express.Router();

/* =====================================================
   HELPER — TIME VALIDATION
===================================================== */
const isValidTime = (time: string): boolean => {
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return timeRegex.test(time);
};

/* =====================================================
   CREATE
===================================================== */
router.post("/add", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      camera_group_id,
      email,
      mobile_app,
      mobile,
      telegram,
      alerts_enabled,
      alerts_call_notification,
    } = req.body;

    if (!camera_group_id) {
      res.status(400).json({ message: "camera_group_id required" });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(camera_group_id)) {
      res.status(400).json({ message: "Invalid camera_group_id" });
      return;
    }

    const group = await CameraGroup.findById(camera_group_id);
    if (!group) {
      res.status(404).json({ message: "Camera group not found" });
      return;
    }

    const exists = await CameraNotificationManager.findOne({ camera_group_id });
    if (exists) {
      res.status(400).json({ message: "Notification config already exists" });
      return;
    }

    const config = await CameraNotificationManager.create({
      camera_group_id,
      email,
      mobile_app,   // { enabled, mobile_ids }
      mobile,       // { enabled, mobile_numbers }
      telegram,
      alerts_enabled: alerts_enabled ?? true,
      alerts_call_notification: alerts_call_notification
        ? {
            alert_call_enabled_notification:
              alerts_call_notification.alert_call_enabled_notification ?? false,
            start_time: alerts_call_notification.start_time || "21:00",
            end_time:   alerts_call_notification.end_time   || "09:00",
          }
        : undefined,
    });

    res.status(201).json({ success: true, id: config._id });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

/* =====================================================
   GET ALL
===================================================== */
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  try {
    const data = await CameraNotificationManager.find()
      .populate("camera_group_id", "group_name priority_type")
      .lean();

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

/* =====================================================
   GET BY GROUP
===================================================== */
router.get(
  "/group/:groupId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { groupId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(groupId)) {
        res.status(400).json({ message: "Invalid group ID" });
        return;
      }

      const config = await CameraNotificationManager.findOne({
        camera_group_id: groupId,
      });

      if (!config) {
        res.status(404).json({ message: "Notification manager not found" });
        return;
      }

      res.json({ success: true, config });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  }
);

/* =====================================================
   UPDATE (SAFE PARTIAL UPDATE)
===================================================== */
router.put("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid ID" });
      return;
    }

    const updated = await CameraNotificationManager.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );

    if (!updated) {
      res.status(404).json({ message: "Notification manager not found" });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

/* =====================================================
   UPDATE CALL TIME WINDOW
===================================================== */
router.put(
  "/call-time/:groupId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { groupId } = req.params;
      const { start_time, end_time } = req.body;

      if (!mongoose.Types.ObjectId.isValid(groupId)) {
        res.status(400).json({ message: "Invalid group ID" });
        return;
      }

      if (start_time && !isValidTime(start_time)) {
        res.status(400).json({ message: "Invalid start_time format HH:mm" });
        return;
      }

      if (end_time && !isValidTime(end_time)) {
        res.status(400).json({ message: "Invalid end_time format HH:mm" });
        return;
      }

      await CameraNotificationManager.updateOne(
        { camera_group_id: groupId },
        {
          $set: {
            ...(start_time && { "alerts_call_notification.start_time": start_time }),
            ...(end_time   && { "alerts_call_notification.end_time":   end_time   }),
          },
        }
      );

      res.json({ success: true, message: "Call time updated" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  }
);

/* =====================================================
   TOGGLE CALL NOTIFICATION (PER GROUP)
===================================================== */
router.put(
  "/toggle/group/:groupId/call",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { groupId } = req.params;
      const { enabled } = req.body;

      if (!mongoose.Types.ObjectId.isValid(groupId)) {
        res.status(400).json({ message: "Invalid group ID" });
        return;
      }

      await CameraNotificationManager.updateOne(
        { camera_group_id: groupId },
        {
          $set: {
            "alerts_call_notification.alert_call_enabled_notification": enabled,
          },
        }
      );

      res.json({
        success: true,
        message: `Call notifications ${enabled ? "enabled" : "disabled"} for group`,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  }
);

/* =====================================================
   TOGGLE CHANNEL (EMAIL / MOBILE_APP / MOBILE / TELEGRAM)
===================================================== */
router.put(
  "/toggle/group/:groupId/:channel",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { groupId, channel } = req.params;
      const { enabled } = req.body;

      // ← added mobile_app as a valid channel
      if (!["email", "mobile_app", "mobile", "telegram"].includes(channel)) {
        res.status(400).json({ message: "Invalid channel" });
        return;
      }

      await CameraNotificationManager.updateOne(
        { camera_group_id: groupId },
        { $set: { [`${channel}.enabled`]: enabled } }
      );

      res.json({
        success: true,
        message: `${channel} ${enabled ? "enabled" : "disabled"} for group`,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  }
);

/* =====================================================
   TOGGLE MASTER (PER GROUP)
===================================================== */
router.put(
  "/toggle/group/:groupId",
  async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;

      await CameraNotificationManager.updateOne(
        { camera_group_id: req.params.groupId },
        { $set: { alerts_enabled: enabled } }
      );

      res.json({
        success: true,
        message: `Notifications ${enabled ? "enabled" : "disabled"} for group`,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  }
);

/* =====================================================
   DELETE
===================================================== */
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid ID" });
      return;
    }

    const deleted = await CameraNotificationManager.findByIdAndDelete(req.params.id);

    if (!deleted) {
      res.status(404).json({ message: "Notification manager not found" });
      return;
    }

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;