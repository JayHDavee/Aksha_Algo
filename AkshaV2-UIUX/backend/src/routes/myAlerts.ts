import express, { Request, Response } from "express";
import Alert from "../models/myAlertSchema";
import config from "../models/configSchema";

/**
 * Interface for alert creation/update request body
 */
interface IAlertRequest {
  Alert_Name: string;
  Object_Class: string[];
  Object_Area: number[][];
  Start_Time: string;
  End_Time: string;
  Days_Active: string[];
  Holiday_Status: boolean;
  Workday_Status: boolean;
  Alert_Status: string;
  Display_Activation: boolean;
  Email_Activation: boolean;
  Camera_Name: string[];
  Alert_Description?: string;
  No_Object_Status: boolean;
}

/**
 * Interface for alert deletion request body
 */
interface IDeleteAlertRequest {
  Camera_Name: string[];
}

/**
 * My Alerts Routes Module
 * 
 * This module handles custom alert management functionality including:
 * - Creating new custom alerts with specific parameters
 * - Updating existing alert configurations
 * - Retrieving alerts by camera name
 * - Deleting alerts and managing camera associations
 * - Finding cameras associated with specific alerts
 * 
 * Custom alerts allow users to define specific detection rules
 * with time constraints, object classes, areas of interest,
 * and notification preferences for enhanced monitoring capabilities.
 */

const router = express.Router();

/**
 * POST /CREATE_ALERT (Environment variable endpoint)
 * 
 * Creates a new custom alert with specified detection parameters.
 * Associates the alert with selected cameras and updates camera configurations.
 * 
 * @route POST /api/{CREATE_ALERT}
 * @param {Object} req.body - Request body containing alert configuration
 * @param {string} req.body.Alert_Name - Unique name for the alert
 * @param {string[]} req.body.Object_Class - Array of object types to detect
 * @param {Object} req.body.Object_Area - Polygon coordinates defining detection area
 * @param {string} req.body.Start_Time - Start time for alert activation (HH:mm format)
 * @param {string} req.body.End_Time - End time for alert activation (HH:mm format)
 * @param {string[]} req.body.Days_Active - Array of days when alert is active
 * @param {boolean} req.body.Holiday_Status - Whether alert is active on holidays
 * @param {boolean} req.body.Workday_Status - Whether alert is active on workdays
 * @param {boolean} req.body.Alert_Status - Overall alert activation status
 * @param {boolean} req.body.Display_Activation - Whether to show display notifications
 * @param {boolean} req.body.Email_Activation - Whether to send email notifications
 * @param {string[]} req.body.Camera_Name - Array of camera names to associate with alert
 * @param {string} req.body.Alert_Description - Description of the alert purpose
 * @param {boolean} req.body.No_Object_Status - Whether to alert when no objects detected
 * @returns {Object} Response confirming alert creation status
 */
router.post(process.env.CREATE_ALERT || '/create-alert', async (req: any, res: any) => {
  const {
    Alert_Name,
    Object_Class,
    Object_Area,
    Start_Time,
    End_Time,
    Days_Active,
    Holiday_Status,
    Workday_Status,
    Alert_Status,
    Display_Activation,
    Email_Activation,
    Camera_Name,
    Alert_Description,
    No_Object_Status
  } = req.body;

  try {
    // Create new alert document with provided configuration
    const newAlert = new Alert({
      Alert_Name: Alert_Name,
      Object_Class: Object_Class,
      Object_Area: Object_Area,
      Start_Time: Start_Time,
      End_Time: End_Time,
      Days_Active: Days_Active,
      Holiday_Status: Holiday_Status,
      Workday_Status: Workday_Status,
      Alert_Status: Alert_Status,
      Display_Activation: Display_Activation,
      Email_Activation: Email_Activation,
      Camera_Name: Camera_Name,
      Alert_Description: Alert_Description,
      No_Object_Status: No_Object_Status,
    });

    // Save the new alert to database
    await newAlert.save();

    // Update camera configurations to include reference to new alert
    await config.updateMany(
      { Camera_Name: { $in: Camera_Name } },
      { $push: { Alerts: newAlert.id } }
    );

    res.status(200).json({
      success: true,
      message: "alert creation successful",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * PUT /UPDATE_ALERT/:id (Environment variable endpoint)
 * 
 * Updates an existing alert configuration with new parameters.
 * Modifies alert settings and updates camera associations.
 * 
 * @route PUT /api/{UPDATE_ALERT}/:id
 * @param {string} req.params.id - Alert ID to update
 * @param {Object} req.body - Updated alert configuration (same structure as CREATE_ALERT)
 * @returns {Object} Response confirming alert update status
 */
router.put(process.env.UPDATE_ALERT || '/update-alert', async (req: any, res: any) => {
  const {
    Alert_Name,
    Object_Class,
    Object_Area,
    Start_Time,
    End_Time,
    Days_Active,
    Holiday_Status,
    Workday_Status,
    Alert_Status,
    Display_Activation,
    Email_Activation,
    Camera_Name,
    Alert_Description,
    No_Object_Status
  } = req.body;

  try {
    // Update alert document with new configuration
    await Alert.findByIdAndUpdate(
      { _id: req.params.id },
      {
        Alert_Name,
        Object_Class,
        Object_Area,
        Start_Time,
        End_Time,
        Days_Active,
        Holiday_Status,
        Workday_Status,
        Alert_Status,
        Display_Activation,
        Email_Activation,
        Camera_Name,
        Alert_Description,
        No_Object_Status
      }
    );

    // Update camera configurations with alert reference
    await config.updateMany(
      { Camera_Name: { $in: Camera_Name } },
      { $push: { Alert: Alert_Name } }
    );

    res.status(200).json({
      success: true,
      message: "update alert successful",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * GET /ALERT_BY_CAMERA_NAME/:camera_name (Environment variable endpoint)
 * 
 * Retrieves all alerts associated with a specific camera.
 * Used to display camera-specific alert configurations.
 * 
 * @route GET /api/{ALERT_BY_CAMERA_NAME}/:camera_name
 * @param {string} req.params.camera_name - Name of the camera to get alerts for
 * @returns {Object} Response containing array of alerts for the specified camera
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.alerts - Array of alert objects associated with the camera
 */
router.get(process.env.ALERT_BY_CAMERA_NAME || '/alert-by-camera', async (req: any, res: any) => {
  try {
    // Find all alerts that include the specified camera name
    const alerts = await Alert.find({
      Camera_Name: { $in: [req.params.camera_name] },
    });
   
  
    res.status(200).json({
      success: true,
      message: "alert list found",
      alerts,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to found alert",
    });
  }
});

/**
 * PUT /DELETE_ALERT/:id (Environment variable endpoint)
 * 
 * Removes camera associations from an alert or deletes the alert entirely.
 * If all cameras are removed, the alert is completely deleted.
 * 
 * @route PUT /api/{DELETE_ALERT}/:id
 * @param {string} req.params.id - Alert ID to modify
 * @param {Object} req.body - Request body containing cameras to remove
 * @param {string[]} req.body.Camera_Name - Array of camera names to remove from alert
 * @returns {Object} Response confirming deletion/modification status
 */
router.put(process.env.DELETE_ALERT || '/delete-alert', async (req: any, res: any) => {
  const _id = req.params.id;
  
  try {
    // Get current alert information
    const alertInfo = await Alert.findById(_id);
    if (!alertInfo) {
      return res.status(404).json({
        success: false,
        message: "Alert not found",
      });
    }

    // Filter out cameras that should be removed from the alert
    const filterByCName = alertInfo.Camera_Name.filter((name: string) => {
      return !req.body.Camera_Name.includes(name);
    });

    // Update alert with remaining cameras
    const updatedRecord = await Alert.findByIdAndUpdate(
      _id,
      {
        Camera_Name: filterByCName,
      },
      { new: true }
    );

    // Remove alert reference from camera configuration
    await config.findOneAndUpdate(
      { Camera_Name: req.body.Camera_Name },
      {
        $pull: {
          'Alerts': _id
        }
      }
    );

    // If no cameras remain associated with alert, delete the alert entirely
    if (!updatedRecord || updatedRecord.Camera_Name.length === 0) {
      await Alert.findByIdAndDelete(_id);
      return res.status(200).json({
        success: true,
        message: "delete alert successful",
      });
    }

    res.status(200).json({
      success: true,
      message: "delete alert successful",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * GET /FIND_CAMERA_BY_ALERT_ID/:id (Environment variable endpoint)
 * 
 * Retrieves all cameras associated with a specific alert.
 * Used to display which cameras are configured for a particular alert.
 * 
 * @route GET /api/{FIND_CAMERA_BY_ALERT_ID}/:id
 * @param {string} req.params.id - Alert ID to get associated cameras for
 * @returns {Object} Response containing array of camera names
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string} response.message - Descriptive message about the operation
 * @returns {Array} response.CameraNames - Array of camera names associated with the alert
 */
router.get(process.env.FIND_CAMERA_BY_ALERT_ID || '/find-camera-by-alert', async (req: any, res: any) => {
  const _id = req.params.id;
  
  try {
    // Find alert and extract associated camera names
    const alertInfo = await Alert.findById(_id);
    if (!alertInfo) {
      return res.status(404).json({
        success: false,
        message: "Alert not found",
      });
    }
    
    res.status(200).json({
      success: true,
      message: "successfully found cameras",
      CameraNames: alertInfo.Camera_Name,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

export default router;
