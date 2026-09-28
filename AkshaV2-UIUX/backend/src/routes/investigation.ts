import * as express from 'express';
const { Router } = express;
import config from "../models/configSchema";
import * as fs from 'fs';
import * as path from 'path';

const debug = require("debug")("author");

/**
 * Investigation Routes Module
 * 
 * This module handles investigation-related API endpoints that support
 * the investigation functionality in the application. It provides:
 * - Camera information retrieval for investigation setup
 * - Object detection labels for filtering and analysis
 * - Reference image access for camera identification
 * 
 * These endpoints are typically used by the frontend investigation
 * interface to populate dropdowns, display reference images, and
 * configure investigation parameters.
 */

/**
 * GET /CAMERA_NAMES (Environment variable endpoint)
 * 
 * Retrieves all camera configurations from the database.
 * This endpoint is used to populate camera selection dropdowns
 * in the investigation interface.
 * 
 * @route GET /api/{CAMERA_NAMES}
 * @returns {Object} Response containing array of all camera configurations
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.cameras - Array of camera configuration objects
 * 
 * @example
 * GET /api/camera-names
 * Response: {
 *   "success": true,
 *   "message": "Fetch All Camera Name Successfully",
 *   "cameras": [...]
 * }
 */
const router = express.Router();
router.get(process.env.CAMERA_NAMES || '/camera-names', async (req: any, res: any) => {
  try {
    // Retrieve all camera configurations from database
    const cameras = await config.find({}, {});
    res.status(200).json({
      success: true,
      message: "Fetch All Camera Name Successfully empty",
      cameras: cameras,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
      cameras: [],
    });
  }
});

/**
 * GET /OBJECT_OF_INTEREST_LABELS (Environment variable endpoint)
 * 
 * Retrieves all available object detection labels from the labels.txt file.
 * These labels are used for filtering and configuring object detection
 * parameters in investigations.
 * 
 * @route GET /api/{OBJECT_OF_INTEREST_LABELS}
 * @returns {Object} Response containing array of detection labels
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.labels - Array of object detection label strings
 * 
 * @example
 * GET /api/object-labels
 * Response: {
 *   "success": true,
 *   "message": "Fetch All Labels Successfully",
 *   "labels": ["person", "vehicle", "bicycle", ...]
 * }
 */
router.get('/object-labels', (req: any, res: any) => {
  try {
    // Use case selects which labels file to read (labels_{use_case}.txt).
    // Falls back to the default labels.txt when no use_case is given, so
    // existing cameras/callers keep working unchanged.
    const useCase = (req.query.use_case as string || "").trim().toLowerCase();
    const filename = useCase ? `labels_${useCase}.txt` : "labels.txt";
    const joinPath = path.join(`${process.env.AKSHA_PATH}/${filename}`);
    const labels = fs.readFileSync(joinPath, "utf-8")
      .split("\n")
      .map((l: string) => l.replace(/\r/g, "").trim())
      .filter(Boolean);

    debug(labels);

    res.status(200).json({
      success: true,
      message: "Fetch All Labels Successfully",
      labels: labels,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
      labels: [],
    });
  }
});

/**
 * GET /REFERENCE_IMAGE/:camera_name (Environment variable endpoint)
 * 
 * Retrieves the reference image for a specific camera by camera name.
 * The endpoint looks up the camera's RTSP ID from rtsplinks.json and
 * returns the corresponding reference image URL if it exists.
 * 
 * @route GET /api/{REFERENCE_IMAGE}/:camera_name
 * @param {string} req.params.camera_name - Name of the camera to get reference image for
 * @returns {Object} Response containing reference image URL or null
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {string|null} response.image - URL to reference image or null if not found
 * 
 * @example
 * GET /api/reference-image/Camera1
 * Response: {
 *   "success": true,
 *   "message": "Fetch Reference Image Successfully",
 *   "image": "http://localhost:3000/Reference_images/123.jpg"
 * }
 */
router.get(process.env.REFERENCE_IMAGE || '/reference-image', (req: any, res: any) => {
  try {
    // Get camera name from URL parameters
    const cam = req.params.camera_name;
   console.log(cam); 
    // Read RTSP links configuration file
    const fileData = fs.readFileSync(`${process.env.AKSHA_PATH}/rtsplinks.json`, 'utf-8');
    const rtspData = JSON.parse(fileData);
    
    // Search for camera in RTSP configuration
    for (const key in rtspData) {
      if (rtspData[key]['cam_name'] === cam) {
        const cam_rtsp_id = rtspData[key]['rtsp_id'];

        // Construct reference image URL and file path
        const imageUrl = `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/Reference_images/${cam_rtsp_id}.jpg`;
        const joinPath = path.join(`${process.env.AKSHA_PATH}/Reference_images/${cam_rtsp_id}.jpg`);
 
        // Check if reference image file exists
        const fileExist = fs.existsSync(path.join(joinPath));
         
        if (fileExist === true) {
          // Set CORS header for image access
          res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
          return res.status(200).json({
            success: true,
            message: "Fetch Reference Image Successfully",
            image: imageUrl,
          });
        }

        // Camera found but no reference image available
        return res.status(200).json({
          success: true,
          message: "Fetch Reference Image Successfully",
          image: null,
        });
      }
    }
    
    // Camera not found in RTSP configuration
    res.status(200).json({
      success: true,
      message: "Camera not found in RTSP configuration",
      image: null,
    });
    
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
      image: null,
    });
  }
});

export default router;
