import * as express from 'express';
const { Router } = express;
import multer from "multer";
import * as fs from 'fs';

/**
 * Monitor Routes Module
 * 
 * This module handles real-time camera monitoring functionality including:
 * - Live image streaming from cameras to connected clients
 * - Image type filtering based on workday/holiday status
 * - Socket.IO integration for real-time communication
 * - File upload handling for camera images
 * 
 * The module processes incoming camera images and broadcasts them
 * to connected clients via WebSocket connections, enabling real-time
 * monitoring capabilities in the frontend application.
 */

const router = express.Router();
const upload = multer();

let _globalCache: { workday: string } | null = null;
let _globalCacheTs = 0;
const GLOBAL_TTL_MS = 10000;

function getImageType(): string {
  const now = Date.now();
  if (!_globalCache || now - _globalCacheTs > GLOBAL_TTL_MS) {
    try {
      const raw = fs.readFileSync(`${process.env.AKSHA_PATH}/global.json`, 'utf-8');
      _globalCache = JSON.parse(raw);
      _globalCacheTs = now;
    } catch (_) {}
  }
  return _globalCache?.workday === 'true' ? 'workday' : 'holiday';
}

/**
 * POST /monitor
 * 
 * Handles real-time camera image streaming and broadcasting.
 * Processes uploaded camera images and emits them to connected clients
 * via Socket.IO based on workday/holiday configuration.
 * 
 * @route POST /api/monitor
 * @param {Object} req.body - Request body containing camera data
 * @param {string} req.body.camera_name - Name of the camera sending the image
 * @param {string} req.body.camera_img_url - URL of the camera image
 * @param {string} req.body.image_type - Type of image (workday/holiday)
 * @param {string} req.body.timestamp - Timestamp when image was captured
 * @param {File} req.file - Uploaded image file (via multer)
 * @returns {Object} Response confirming image publication status
 * 
 * @example
 * POST /api/monitor
 * Content-Type: multipart/form-data
 * Body: {
 *   "camera_name": "Camera1",
 *   "camera_img_url": "http://example.com/image.jpg",
 *   "image_type": "workday",
 *   "timestamp": "2023-01-01T12:00:00Z"
 * }
 * File: image binary data
 */


router.post("/monitor", upload.single("image"), (req: any, res: any) => {
  let itype = true;

  console.log("req.file:", req.file);
  console.log("req.body:", req.body);
  try {
    // Read global configuration to determine current day type
    const days = fs.readFileSync(`${process.env.AKSHA_PATH}/global.json`, "utf-8");
    const { workday } = JSON.parse(days);
    
    // Determine image type based on workday status

    let imagetype_determine: string;
    if (workday === "true") {
      imagetype_determine = "workday";
    } else {
      imagetype_determine = "holiday";
    }

    // Only process and broadcast images that match current day type
    if (req.body.image_type === imagetype_determine) {
      // Emit real-time image data to connected clients via Socket.IO
      // Note: 'io' should be available from the global scope or passed via middleware
       req.io.emit(req.body.camera_name, {
        image_url: req.body.camera_img_url,
        type: req.file.mimetype,
        image: req.file.buffer,
        timestamp: req.body.timestamp,
      });
    }
  
    // Send success response regardless of whether image was broadcasted
    res.status(200).json({
      success: true,
      message: "Successfully Published Image for Camera: " + req.body.camera_name,
    });
    
  } catch (error: any) {
    console.error("Error in monitor:", error.message);
    res.status(500).send('Unable to publish image');
  }
});

export default router;


