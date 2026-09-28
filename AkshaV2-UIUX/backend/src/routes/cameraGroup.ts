import express from "express";
import CameraGroup from "../models/cameraGroupSchema";
import config from "../models/configSchema";
import mongoose from "mongoose";
import CameraNotificationManager from "../models/cameraNotificationManager";

const router = express.Router();

/**
 * 1️⃣ Create a New Camera Group
 * Endpoint: POST /
 * Description:
 * - Validates unique group_name.
 * - Ensures no camera is part of another group.
 * - Saves new group & updates camera group references.
 */
router.post("/add", async (req: any, res: any) => {
  try {
    const { group_name, description, priority_type, cameras } = req.body;

    if (!group_name || !Array.isArray(cameras)) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Check unique group name
    const existingGroup = await CameraGroup.findOne({ group_name });
    if (existingGroup) {
      return res.status(400).json({ message: "Group name already exists." });
    }

    // Check if cameras already belong to a group
    const cameraIds = cameras.map(c => new mongoose.Types.ObjectId(c.camera_id));
    const alreadyGrouped = await config.find({
      _id: { $in: cameraIds },
      group_id: 1,
    });

    console.log(alreadyGrouped);
    if (alreadyGrouped.length > 0) {
      return res.status(400).json({
        message: "Some cameras already assigned to another group.",
        cameras: alreadyGrouped.map((c) => c.Camera_Name),
      });
    }

    // Create new group
    const newGroup = await CameraGroup.create({
      group_name,
      description,
      priority_type,
      cameras,
    });

    // Update cameras with group_id reference
    await config.updateMany(
      { _id: { $in: cameraIds } },
      { $set: { group_id: 1 } }
    );

    return res.status(201).json({
      success: true,
      message: "Group created successfully",
      group_id: newGroup._id,
    });
  } catch (error: any) {
    return res.status(500).json({ message: "Error creating group", error: error.message });
  }
});

/**
 * 2️⃣ Get All Camera Groups
 * Endpoint: GET /
 * Description:
 * - Fetches all existing groups with their cameras.
 */
router.get("/", async (req: any, res: any) => {
  try {
    const groups = await CameraGroup.find().lean();
    res.status(200).json({ groups });
  } catch (error: any) {
    res.status(500).json({ message: "Error fetching groups", error: error.message });
  }
});

/**
 * 3️⃣ Get Group by ID
 * Endpoint: GET /:id
 * Description:
 * - Fetches detailed group info including camera details.
 */
router.get("/:id", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const group = await CameraGroup.findById(id);
    if (!group) return res.status(404).json({ message: "Group not found" });

    const cameraIds = group.cameras.map((c) => c.camera_id);
    const cameraData = await config.find({ _id: { $in: cameraIds } }, "Camera_Name Rtsp_Link");

    const cameras = group.cameras.map((c) => {
      const cam = cameraData.find((x) => x._id.toString() === c.camera_id.toString());
      return {
        camera_id: c.camera_id,
        camera_name: cam ? cam.Camera_Name : c.camera_name,
        rtsp_link: cam ? cam.Rtsp_Link : "",
      };
    });

    res.status(200).json({
      success: true,
      group_name: group.group_name,
      description: group.description,
      priority_type: group.priority_type,
      cameras,
    });
  } catch (error: any) {
    res.status(500).json({ message: "Error fetching group details", error: error.message });
  }
});

/**
 * 4️⃣ Update Group Details
 * Endpoint: PUT /:id
 * Description:
 * - Updates group metadata and assigned cameras.
 */
router.put("/:id", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { group_name, description, priority_type, cameras } = req.body;

    const group = await CameraGroup.findById(id);
    if (!group)
      return res.status(404).json({ message: "Group not found" });

    const newCameraIds = cameras.map((c: any) => c.camera_id.toString());
    const oldCameraIds = group.cameras.map((c) => c.camera_id.toString());

    /*
     * ----------------------------------------------------------
     * 1️⃣ Check for conflicts ONLY from other groups
     * ----------------------------------------------------------
     */

    // Cameras that are NEWLY added (not already in this group)
    const newlyAddedCameras = newCameraIds.filter(
      (id) => !oldCameraIds.includes(id)
    );

    // Look for cameras that already belong to another group
    const conflicts = await config.find({
      _id: { $in: newlyAddedCameras },
      group_id: 1, // means "belongs to a group"
    });

    if (conflicts.length > 0) {
      return res.status(400).json({
        message: "Some cameras already assigned to another group.",
        cameras: conflicts.map((c) => c.Camera_Name),
      });
    }

    /*
     * ----------------------------------------------------------
     * 2️⃣ Unassign cameras that were removed from the group
     * ----------------------------------------------------------
     */
    const removedCameras = oldCameraIds.filter(
      (id) => !newCameraIds.includes(id)
    );

    if (removedCameras.length > 0) {
      await config.updateMany(
        { _id: { $in: removedCameras } },
        { $unset: { group_id: "" } }  // FIXED: correct unset
      );
    }

    /*
     * ----------------------------------------------------------
     * 3️ Update group fields
     * ----------------------------------------------------------
     */
    await CameraGroup.updateOne(
      { _id: id },
      {
        $set: {
          group_name,
          description,
          priority_type,
          cameras,
        },
      }
    );

    /*
     * ----------------------------------------------------------
     * 4️Assign group_id to newly added cameras
     * ----------------------------------------------------------
     */
    if (newlyAddedCameras.length > 0) {
      await config.updateMany(
        { _id: { $in: newlyAddedCameras } },
        { $set: { group_id: 1 } }
      );
    }

    return res.json({
      success: true,
      message: "Group updated successfully",
    });

  } catch (error: any) {
    return res.status(500).json({
      message: "Error updating group",
      error: error.message,
    });
  }
});

/**Endpoint: DELETE /:id
 * Description:
 * - Deletes the group and unassigns all linked cameras.
 */
router.delete("/:id", async (req: any, res: any) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid group id" });
    }

    const group = await CameraGroup.findById(id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }

    const cameraIds = Array.isArray(group.cameras)
      ? group.cameras
        .map((c: any) => c?.camera_id)
        .filter(Boolean)
      : [];

    // Unassign cameras from group
    if (cameraIds.length > 0) {
      await config.updateMany(
        { _id: { $in: cameraIds } },
        { $unset: { group_id: "" } }
      );
    }

    // Delete notification config linked to this group
    await CameraNotificationManager.deleteMany({
      camera_group_id: id,
    });

    // Delete the group itself
    await CameraGroup.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Group and related notifications deleted successfully",
    });
  } catch (error: any) {
    console.error("Delete group error:", error);
    res.status(500).json({
      message: "Error deleting group",
      error: error.message,
    });
  }
});

export default router;