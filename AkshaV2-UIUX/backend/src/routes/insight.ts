import * as express from 'express';
const { Router } = express;
import axios from "axios";
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Insight Routes Module
 * 
 * This module handles insight video generation and retrieval.
 * It integrates with external services to generate heatmap videos
 * based on camera data within specified time ranges.
 * 
 * The module provides functionality to:
 * - Request insight video generation from external API service
 * - Check video file status and availability
 * - Generate secure URLs with hash parameters for video access
 * - Handle video generation progress and completion states
 */

const router = express.Router();

/**
 * POST /INSIGHT (Environment variable endpoint)
 * 
 * Generates and retrieves insight heatmap videos for a specific camera
 * within a given time range. The endpoint triggers video generation
 * via external API service and returns the video URL when ready.
 * 
 * @route POST /api/{INSIGHT}
 * @param {Object} req.body - Request body containing insight parameters
 * @param {string} req.body.Start_Date - Start date for insight analysis (YYYY-MM-DD format)
 * @param {string} req.body.Start_Time - Start time for insight analysis (HH:mm format)
 * @param {string} req.body.End_Date - End date for insight analysis (YYYY-MM-DD format)
 * @param {string} req.body.End_Time - End time for insight analysis (HH:mm format)
 * @param {string} req.body.Camera_Name - Name of the camera to analyze
 * @returns {Object} Response containing insight video URL or generation status
 * 
 * @example
 * POST /api/insight
 * Body: {
 *   "Start_Date": "2023-01-01",
 *   "Start_Time": "09:00",
 *   "End_Date": "2023-01-01", 
 *   "End_Time": "17:00",
 *   "Camera_Name": "Camera1"
 * }
 */
router.post(process.env.INSIGHT || '/insight', async (req: any, res: any) => {
  const { Start_Date, Start_Time, End_Date, End_Time, Camera_Name } = req.body;

  // Validate required parameters
  if (!Start_Date || !Start_Time || !End_Date || !End_Time || !Camera_Name) {
    return res.status(400).json({
      success: false,
      message: "please provide all detail",
      insight: {},
    });
  }

  // Request insight video generation from external service
  try {
    // Prepare request body for insight video generation
    const reqBody = {
      camera_name: Camera_Name,
      start_date: Start_Date,
      end_date: End_Date,
      start_time: Start_Time,
      end_time: End_Time,
    };

    console.log({ reqBody });

    // Send request to API service to generate insight video
    await axios.post(`http://API_SERVICE:4000/Insight`, reqBody);
  } catch (error: any) {
    const message =
      error?.response?.data?.detail || error?.message || "Could not generate insight video";
    console.log("Could not generate insight video", message);
    return res.status(500).json({
      success: false,
      message,
      insight: {},
    });
  }

  // Check video file status and return appropriate response
  try {
    // Construct path to the generated heatmap video
    const filePath = path.join(
      `${process.env.AKSHA_PATH}/${Camera_Name}/insight/heatmap_video_${Camera_Name}.mp4`
    );
    
    // Check file status asynchronously
    fs.stat(filePath, (err, stats) => {
      if (err) {
        // File not found or other error occurred
        return res.status(400).json({
          success: false,
          message: "Video not found.",
          insight: {},
        });
      }

      if (stats.isFile() && stats.size === 0) {
        // File exists but is empty (still being generated)
        return res.status(200).json({
          success: true,
          message: "Video is still being formed. Please wait",
          insight: {},
        });
      }

      // Generate secure hash for video URL
      const hash = crypto
        .createHash("sha256")
        .update(
          `camera_name: ${Camera_Name}, start_date: ${Start_Date}, end_date: ${End_Date}, start_time: ${Start_Time}, end_time: ${End_Time}`
        )
        .digest("hex");

      // Construct secure video URL with hash parameter
      const imageUrl = `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${Camera_Name}/insight/heatmap_video_${Camera_Name}.mp4?hash=${hash}`;
      
      // Return successful response with video URL
      return res.status(200).json({
        success: true,
        message: "fetch insight successful",
        insight: {
          camera_Name: Camera_Name,
          image: imageUrl,
        },
      });
    });
  } catch (error: any) {
    console.log(error);
    res.status(400).json({
      success: false,
      message: error,
      insight: {},
    });
  }
});

export default router;
