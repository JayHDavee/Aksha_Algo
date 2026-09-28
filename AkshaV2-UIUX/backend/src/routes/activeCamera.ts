import { Router } from "express";
import { listLiveCamera, listSpotlightCameras } from "../functions/camera";

/**
 * Active Camera Routes
 * 
 * This module handles API routes for active camera operations including:
 * - Retrieving live camera details for monitoring
 * - Fetching spotlight camera information for display
 * 
 * All routes are prefixed with /api/active in the main application
 */

const activeCamera: Router = Router();

/**
 * GET /getLiveCamera
 * 
 * Retrieves the list of live cameras for the Monitor/Active Page.
 * This endpoint fetches all active camera configurations along with their
 * current status, live images, and metadata.
 * 
 * @route GET /api/active/getLiveCamera
 * @returns {Object} Response object containing success status, message, and camera details
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.info - Array of live camera objects with detailed information
 */
activeCamera.get("/getLiveCamera", async (req: any, res: any) => {
  try {
    // Fetch live camera details from the camera service
    const cameraDetail = await listLiveCamera();
     console.log(cameraDetail);
    return res.send({
      success: true,
      message: "initial live camera details",
      info: cameraDetail,
    });
  } catch (error) {
    // Handle any errors that occur during camera detail retrieval
    console.error("Error fetching live camera details:", error);
    return res.status(500).send({
      success: false,
      message: "Failed to retrieve live camera details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /getSpotlightCamera
 * 
 * Retrieves the list of spotlight cameras for the Monitor/Spotlight Page.
 * This endpoint fetches cameras that have spotlight images available,
 * filtered based on workday/holiday status.
 * 
 * @route GET /api/active/getSpotlightCamera
 * @returns {Object} Response object containing success status, message, and spotlight camera details
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.info - Array of spotlight camera objects with name and image URL
 */
activeCamera.get("/getSpotlightCamera", async (req: any, res: any) => {
  try {
    // Fetch spotlight camera details from the camera service
    const cameraDetail = await listSpotlightCameras();

    return res.send({
      success: true,
      message: "initial camera spotlight details",
      info: cameraDetail,
    });
  } catch (error) {
    // Handle any errors that occur during spotlight camera detail retrieval
    console.error("Error fetching spotlight camera details:", error);
    return res.status(500).send({
      success: false,
      message: "Failed to retrieve spotlight camera details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default activeCamera;
