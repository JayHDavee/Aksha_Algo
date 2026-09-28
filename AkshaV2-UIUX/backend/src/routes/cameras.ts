import * as express from 'express';
const { Router } = express;

const FPS_HIGH    = 5;
const FPS_DEFAULT = 3;
const FPS_MIN     = 1;
import mongoose from "mongoose";
import config from "../models/configSchema";
import Alert from "../models/myAlertSchema";
import Resource from "../models/resourceSchema";
import * as path from 'path';
import * as fs from 'fs';
import moment from 'moment';
import axios from "axios";
import { serviceApiStartCamera } from "../functions/serviceApiCamera";
import CameraGroup from "../models/cameraGroupSchema";

const debug = require("debug")("author");

/**
 * Camera Management Routes Module
 * 
 * This module handles all camera-related operations including:
 * - Camera creation with validation and limit checking
 * - Camera listing with reference image handling
 * - Camera updates with metadata collection renaming
 * - Camera deletion with cleanup of associated data
 * - Camera activation/deactivation controls
 * - Alert configuration management (email/display alerts)
 * - Live camera status and surveillance controls
 * 
 * All routes integrate with external services and handle file system operations
 * for comprehensive camera management functionality.
 */

const router = express.Router();

/**
 * POST /CAMERA_CREATE (Environment variable endpoint)
 * 
 * Creates a new camera configuration with validation and limit checking.
 * Validates camera limits against AWS service and creates database entry.
 * 
 * @route POST /api/{CAMERA_CREATE}
 * @param {Object} req.body - Request body containing camera configuration
 * @param {string} req.body.Camera_Name - Unique name for the camera
 * @param {string} req.body.Rtsp_Link - RTSP stream URL for the camera
 * @param {string} req.body.Priority - Camera priority (Low/Medium/High)
 * @param {string} req.body.Feature - Camera feature description
 * @param {string} req.body.Description - Camera description
 * @param {string} req.body.rtsp_id - Unique RTSP identifier
 * @returns {Object} Response containing creation status and limit information
 */
router.get(process.env.FEATURE_FLAGS || '/feature-flags', (req: any, res: any) => {
  res.status(200).json({
    success: true,
    PPE_DETECTION: process.env.PPE_DETECTION === "true",
    JEWELRY_DETECTION: process.env.JEWELRY_DETECTION === "true",
  });
});


// Detection_Type -> Python controller deployment_mode. "standard" maps to
// undefined so the controller's own default applies, matching pre-existing
// camera behavior exactly.
const DETECTION_TYPE_TO_DEPLOYMENT_MODE: Record<string, string | undefined> = {
  standard: undefined,
  ppe: "ppe",
  jewelry: "jewelry",
};

// Enforced server-side, not just hidden in the UI — a request naming a
// flagged-off detection type is rejected outright.
//
// Flat shape (not a discriminated union) deliberately — this project's
// tsconfig has strictNullChecks:false, under which TS does not narrow
// `{ok:true,...} | {ok:false,message}` unions via `if (!x.ok)` reliably.
interface ModeResolution {
  ok: boolean;
  deployment_mode?: string;
  message?: string;
}

function resolveDeploymentMode(detectionType: string | undefined): ModeResolution {
  const type = detectionType || "standard";
  if (!(type in DETECTION_TYPE_TO_DEPLOYMENT_MODE)) {
    return { ok: false, message: `Unknown Detection_Type: ${type}` };
  }
  if (type === "ppe" && process.env.PPE_DETECTION !== "true") {
    return { ok: false, message: "PPE detection is not enabled" };
  }
  if (type === "jewelry" && process.env.JEWELRY_DETECTION !== "true") {
    return { ok: false, message: "Jewelry detection is not enabled" };
  }
  return { ok: true, deployment_mode: DETECTION_TYPE_TO_DEPLOYMENT_MODE[type] };
}

router.post(process.env.CAMERA_CREATE || '/camera-create', async (req: any, res: any) => {
  try {
    const { Camera_Name, Rtsp_Link, Priority, Feature, Description, rtsp_id, PPE_Detection, Detection_Type } = req.body;

    // Validate required fields
    if (!Camera_Name || !Rtsp_Link || !Priority || !Feature) {
      return res.status(400).json({
        success: false,
        message: "please fill the missing information",
      });
    }

    const modeResolution = resolveDeploymentMode(Detection_Type);
    if (!modeResolution.ok) {
      return res.status(403).json({ success: false, message: modeResolution.message });
    }

    // Set FPS based on priority level
    let FPS = FPS_DEFAULT;
    if (Priority === 'Low') {
      FPS = FPS_MIN;
    } else if (Priority === 'High') {
      FPS = FPS_HIGH;
    } else {
      FPS = FPS_DEFAULT;
    }

    // Check if camera name already exists (case insensitive)
    const camera = await config.findOne({ 
      Camera_Name: { $regex: new RegExp("^" + Camera_Name.toLowerCase() + "$", "i") } 
    });
    
    if (camera) {
      return res.status(400).json({
        success: false,
        message: "camera name already exists",
      });
    }

    // Get current camera count from local database
    const cameras = await config.find().distinct("Rtsp_Link");

    // Read application configuration for AWS integration
    let data = fs.readFileSync(`${process.env.AKSHA_PATH}/app.config`, {
      encoding: "utf8",
    });
    data = data.toString();
    let lines = data.split("\n").filter((i) => i !== "");
    console.log(lines);
    lines.shift();
    console.log("after shift: ", lines);
    
    // Parse configuration file
    let conf: any = {};
    lines.forEach((line) => {
      const [key, value] = line.split("=");
      conf[key.trim()] = value.trim();
    });
    

    //Check camera limit via AWS Lambda function

    ///Camera limit should not be more than 15 cammera. 
    const isCamLimitExceeded = cameras.length >= 100;

    if (isCamLimitExceeded) {
      //Failed network requests to the backend
    
      return res.status(200).json({
        success: true,
        isCamLimitExceeded: isCamLimitExceeded,
        message: "Camera limit exceeded",
      });
    }

    // Create camera configuration in database
    const dbPromise = config.create({
      rtsp_id: rtsp_id,
      Rtsp_Link: Rtsp_Link,
      Camera_Name: Camera_Name,
      Description: Description,
      Feature: Feature,
      Priority: Priority,
      Status: "creating",
      Email_Auto_Alert: true,
      Display_Auto_Alert: true,
      Email_Alert: true,
      Display_Alert: true,
      FPS: FPS,
      Alert: [],
      Active: true,
      PPE_Detection: Boolean(PPE_Detection),
      Detection_Type: Detection_Type || "standard",
    });

    // Start camera service via external API
    const serviceApiPromise = serviceApiStartCamera({
      rtsp_id: rtsp_id,
      rtsp_link: Rtsp_Link,
      camera_name: Camera_Name,
      prev_camera_name: "",
      priority: Priority,
      email_auto_alert: true,
      display_auto_alert: true,
      email_alert: true,
      display_alert: true,
      deployment_mode: modeResolution.deployment_mode,
    });

    await Promise.all([dbPromise]);
    
    // Delayed response to allow service initialization
    setTimeout(() => {
      res.status(200).json({
        success: true,
        isCamLimitExceeded: isCamLimitExceeded,
        message: "camera creation successful",
      });
    }, 3000);

  } catch (error: any) {
    console.log(error);
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * GET /CAMERA_LIST (Environment variable endpoint)
 * 
 * Retrieves all camera configurations with reference images.
 * Checks for reference image existence and constructs image URLs.
 * 
 * @route GET /api/{CAMERA_LIST}
 * @returns {Object} Response containing array of camera configurations with image URLs
 */
router.get(process.env.CAMERA_LIST || '/camera-list', async (req: any, res: any) => {
  debug("req");
  try {
    const cameras = await config.find();
    let filteredCameras: any[] = [];
    
    // Process each camera to include reference image information
    cameras.forEach((info) => {
      const joinPath = path.join(
        `${process.env.AKSHA_PATH}/Reference_images/${info.Camera_Name}.jpg`
      );
      const imageUrl = `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/Reference_images/${info.Camera_Name}.jpg`;
      const fileExist = fs.existsSync(joinPath);
      
      // Create camera object with or without image URL
      const cameraData = {
        _id: info._id,
        Rtsp_Link: info.Rtsp_Link,
        Camera_Name: info.Camera_Name,
        Description: info.Description,
        Feature: info.Feature,
        Priority: info.Priority,
        Status: info.Status,
        Email_Auto_Alert: info.Email_Auto_Alert,
        Display_Auto_Alert: info.Display_Auto_Alert,
        Email_Alert: info.Email_Alert,
        Display_Alert: info.Display_Alert,
        Skip_Interval: (info as any).Skip_Interval,
        Alert: info.Alerts,
        image: fileExist ? imageUrl : "",
        Active: info.Active,
        group_id: info.group_id,
      };
      
      filteredCameras.push(cameraData);
    });

    res.status(200).json({
      success: true,
      message: "fetch camera successful",
      cameras: filteredCameras,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to get cameras",
    });
  }
});

/**
 * POST /CAMERA_LIMIT (Environment variable endpoint)
 * 
 * Checks current camera count against configured limits.
 * Integrates with AWS service to validate camera limits.
 * 
 * @route POST /api/{CAMERA_LIMIT}
 * @returns {Object} Response containing limit status and current count
 */
router.post(process.env.CAMERA_LIMIT || '/camera-limit', async (req: any, res: any) => {
  try {
    // Get current camera count
    let cameras = await config.find().distinct('Rtsp_Link');

    // Read application configuration
    let data = fs.readFileSync(`${process.env.AKSHA_PATH}/app.config`, { encoding: 'utf8' });
    data = data.toString();
    let lines = data.split('\n').filter(i => i !== '');
    lines.shift();
    
    // Parse configuration
    let conf: any = {};
    lines.forEach(line => {
      const [key, value] = line.split('=');
      conf[key.trim()] = value.trim();
    });
    let AppID = conf["APP_ID"];
    console.log(AppID);

    // Get camera limit from AWS service
    const response : any = await axios.post(
      'https://8ygyexnre1.execute-api.ap-south-1.amazonaws.com/dev/get-camera-limit',
      {
        "AppID": AppID
      }
    );
    const cam_limit = response.data.MaxCamera;

    // Determine if limit is exceeded
    let isCamLimit: boolean;
    let resMsg: string;

    if (cameras.length >= cam_limit) {
      isCamLimit = true;
      resMsg = "Camera limit exceeded";
    } else {
      isCamLimit = false;
      resMsg = "Camera limit not exceeded";
    }

    res.status(200).json({
      success: true,
      camLimit: cam_limit,
      isCamLimitExceeded: isCamLimit,
      message: resMsg
    });

  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * PUT /UPDATE_CAMERA/:id (Environment variable endpoint)
 * 
 * Updates camera configuration with support for name changes.
 * Handles metadata collection renaming when camera name changes.
 * 
 * @route PUT /api/{UPDATE_CAMERA}/:id
 * @param {string} req.params.id - Camera ID to update
 * @param {Object} req.body - Updated camera configuration
 * @returns {Object} Response confirming update status
 */
router.put(process.env.UPDATE_CAMERA || '/update-camera', async (req: any, res: any) => {
  let {
    rtsp_id,
    Rtsp_Link,
    Camera_Name,
    Prev_Camera_Name,
    Description,
    Feature,
    Priority,
    Email_Auto_Alert,
    Display_Auto_Alert,
    Email_Alert,
    Display_Alert,
    PPE_Detection,
    Detection_Type,
  } = req.body;

  // Validate required fields
  if (
    !rtsp_id ||
    !Camera_Name ||
    !Rtsp_Link ||
    !Priority ||
    !Feature ||
    Email_Auto_Alert === "" ||
    Display_Auto_Alert === "" ||
    Email_Alert === "" ||
    Display_Alert === ""
  ) {
    return res.status(400).json({
      success: false,
      message: "please fill the missing information",
    });
  }

  const modeResolution = resolveDeploymentMode(Detection_Type);
  if (!modeResolution.ok) {
    return res.status(403).json({ success: false, message: modeResolution.message });
  }

  try {
    // Get the current camera name before update
    const camarr = await config.findOne({ "_id": `${req.params.id}` });
    if (!camarr) {
      return res.status(404).json({
        success: false,
        message: "Camera not found",
      });
    }
    let old_camera_name = camarr.Camera_Name;

    let dbPromise: any;
    
    // Set FPS based on priority
    let FPS = 1;
    if (Priority === 'Low') {
      FPS = 1;
    } else if (Priority === 'Medium') {
      FPS = 2;
    } else {
      FPS = 3;
    }

    if (Camera_Name === old_camera_name) {
      // Update without name change
      dbPromise = config.updateOne(
        { _id: req.params.id },
        {
          $set: {
            Rtsp_Link: Rtsp_Link,
            Camera_Name: Camera_Name,
            Description: Description,
            Feature: Feature,
            Priority: Priority,
            Email_Auto_Alert: Email_Auto_Alert,
            Display_Auto_Alert: Display_Auto_Alert,
            Email_Alert: Email_Alert,
            Display_Alert: Display_Alert,
            FPS: FPS,
            PPE_Detection: Boolean(PPE_Detection),
            Detection_Type: Detection_Type || "standard",
          },
        }
      );
      console.log("config collection updated with latest data");

    } else {
      // Handle camera name change
      console.log("inside else block");
      
      // Update all alerts with new camera name
      await Alert.updateMany(
        { Camera_Name: `${old_camera_name}` },
        { $set: { Camera_Name: `${Camera_Name}` } }
      );

      // Update camera configuration
      dbPromise = config.updateOne(
        { _id: req.params.id },
        {
          $set: {
            Rtsp_Link: Rtsp_Link,
            Camera_Name: Camera_Name,
            Description: Description,
            Feature: Feature,
            Priority: Priority,
            Email_Auto_Alert: Email_Auto_Alert,
            Display_Auto_Alert: Display_Auto_Alert,
            Email_Alert: Email_Alert,
            Display_Alert: Display_Alert,
            FPS: FPS,
            PPE_Detection: Boolean(PPE_Detection),
            Detection_Type: Detection_Type || "standard",
          },
        }
      );

      // Rename metadata collection
      let startTime = Date.now();
      mongoose.connection.db.collection(`meta_${old_camera_name}`).rename(`meta_${Camera_Name}`)
        .then(() => {
          console.log('Collection renamed successfully');
        })
        .catch(e => {
          console.error('Failed to rename collection:', e.message);
        });
      let endTime = Date.now();
      let differenceInSeconds = (endTime - startTime) / 1000;
      console.log(`config cam name changed in ${differenceInSeconds} seconds`);
    }

    // Restart camera service with new configuration
    const serviceApiPromise = serviceApiStartCamera({
      rtsp_id: rtsp_id,
      rtsp_link: Rtsp_Link,
      camera_name: Camera_Name,
      prev_camera_name: Prev_Camera_Name,
      priority: Priority,
      email_auto_alert: Email_Auto_Alert,
      display_auto_alert: Display_Auto_Alert,
      email_alert: Email_Alert,
      display_alert: Display_Alert,
      deployment_mode: modeResolution.deployment_mode,
    }, true); // restart the camera service

    await Promise.all([dbPromise]);
    
    // Delayed response to allow service restart
    setTimeout(() => {
      res.status(200).json({
        success: true,
        message: "camera update successful"
      });
      console.log('response sent');
    }, 4000);

  } catch (error: any) {
    console.log('error = ', error);
    res.status(400).json({
      success: false,
      message: "unable to update camera",
      errormsg: error.message
    });
  }
});

/**
 * DELETE /DELETE_CAMERA/:id (Environment variable endpoint)
 * 
 * Deletes camera configuration and cleans up associated data.
 * Removes metadata collections, alerts, and stops camera service.
 * 
 * @route DELETE /api/{DELETE_CAMERA}/:id
 * @param {string} req.params.id - Camera ID to delete
 * @returns {Object} Response confirming deletion status
 */
router.delete(process.env.DELETE_CAMERA || '/delete-camera', async (req: any, res: any) => {
  const _id = req.params.id;
  try {
    // Delete camera configuration and get camera details
    const camName = await config.findByIdAndDelete(_id);
    if (!camName) {
      return res.status(404).json({
        success: false,
        message: "Camera not found",
      });
    }
    const cameraName = camName.Camera_Name;
    
    // Prepare parameters for stopping camera service
    let params = {
      camera_list: [
        {
          camera_name: camName.Camera_Name,
          rtsp_link: camName.Rtsp_Link,
        }
      ],
      type: "stop",
    };

    // Check if metadata collection exists and delete it
    const listCollections = await mongoose.connection.db.listCollections().toArray();
    const collectionexist = listCollections.some((i) => i.name === `meta_${cameraName}`);

    if (collectionexist) {
      mongoose.connection.db.dropCollection(`meta_${cameraName}`).catch((_e: any) => {});
    }

    // Delete associated alerts
    const AlertDetails = await Alert.findOne({ Camera_Name: cameraName });
    if (AlertDetails != null) {
      const result = await Alert.deleteMany({ Camera_Name: cameraName });
    }


    //  Remove camera from any groups
    await CameraGroup.updateMany(
      { "cameras.camera_id": _id }, // groups containing this camera
      { $pull: { cameras: { camera_id: _id } } } // remove it from cameras array
    );


        //  Delete groups that now have zero cameras
        await CameraGroup.deleteMany({
            cameras: { $size: 0 }
        });

    // Send stop command to camera service
    const deletionMessage = axios.post(
      `http://API_SERVICE:4000/Surveillance`,
      params,
      {
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
      }
    );
    console.log('deletionMessage = ', deletionMessage);

    res.status(200).json({
      success: true,
      message: "camera Inactive successful",
    });
  } catch (error: any) {
    console.log('err = ', error);
    res.status(400).json({
      success: false,
      message: "unable to Inactive camera",
    });
  }
});

/**
 * GET /ACTIVATE_CAMERA/:id (Environment variable endpoint)
 * 
 * Activates a camera by setting its Active status to true.
 * 
 * @route GET /api/{ACTIVATE_CAMERA}/:id
 * @param {string} req.params.id - Camera ID to activate
 * @returns {Object} Response confirming activation status
 */
router.get(process.env.ACTIVATE_CAMERA || '/activate-camera', async (req: any, res: any) => {
  const _id = req.params.id;
  try {
    await config.findByIdAndUpdate(_id, { Active: true });
    res.status(200).json({
      success: true,
      message: "camera Activation successful",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to Activation camera",
    });
  }
});

/**
 * GET /ACTIVE_EMAIL_AUTO_ALERT (Environment variable endpoint)
 * 
 * Toggles email auto alert settings for all cameras.
 * 
 * @route GET /api/{ACTIVE_EMAIL_AUTO_ALERT}
 * @param {string} req.query.alert - Boolean string indicating desired alert state
 * @returns {Object} Response confirming email auto alert update
 */
router.get(process.env.ACTIVE_EMAIL_AUTO_ALERT || '/active-email-auto-alert', async (req: any, res: any) => {
  let isAlertActive = JSON.parse(req.query["alert"]);
  try {
    await config.updateMany(
      {
        Email_Auto_Alert: !isAlertActive,
      },
      { $set: { Email_Auto_Alert: isAlertActive } }
    );
    res.status(200).json({
      success: true,
      message: "all email auto alert are active",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to make all email auto alert active",
    });
  }
});

/**
 * GET /ACTIVE_DISPLAY_AUTO_ALERT (Environment variable endpoint)
 * 
 * Toggles display auto alert settings for all cameras.
 * 
 * @route GET /api/{ACTIVE_DISPLAY_AUTO_ALERT}
 * @param {string} req.query.alert - Boolean string indicating desired alert state
 * @returns {Object} Response confirming display auto alert update
 */
router.get(process.env.ACTIVE_DISPLAY_AUTO_ALERT || '/active-display-auto-alert', async (req: any, res: any) => {
  let isAlertActive = JSON.parse(req.query["alert"]);
  try {
    await config.updateMany(
      {
        Display_Auto_Alert: !isAlertActive,
      },
      {
        $set: {
          Display_Auto_Alert: isAlertActive,
        },
      }
    );
    res.status(200).json({
      success: true,
      message: "all display auto alert are active",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to make all display auto alert active",
    });
  }
});

/**
 * GET /ACTIVE_EMAIL_ALERT (Environment variable endpoint)
 * 
 * Toggles email alert settings for all cameras.
 * 
 * @route GET /api/{ACTIVE_EMAIL_ALERT}
 * @param {string} req.query.alert - Boolean string indicating desired alert state
 * @returns {Object} Response confirming email alert update
 */
router.get(process.env.ACTIVE_EMAIL_ALERT || '/active-email-alert', async (req: any, res: any) => {
  let isAlertActive = JSON.parse(req.query["alert"]);
  try {
    await config.updateMany(
      {
        Email_Alert: !isAlertActive,
      },
      { $set: { Email_Alert: isAlertActive } }
    );
    res.status(200).json({
      success: true,
      message: "all email alert are active",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to make all email alert active",
    });
  }
});

/**
 * GET /ACTIVE_DISPLAY_ALERT (Environment variable endpoint)
 * 
 * Toggles display alert settings for all cameras.
 * 
 * @route GET /api/{ACTIVE_DISPLAY_ALERT}
 * @param {string} req.query.alert - Boolean string indicating desired alert state
 * @returns {Object} Response confirming display alert update
 */
router.get(process.env.ACTIVE_DISPLAY_ALERT || '/active-display-alert', async (req: any, res: any) => {
  let isAlertActive = JSON.parse(req.query["alert"]);
  try {
    await config.updateMany(
      {
        Display_Alert: !isAlertActive,
      },
      {
        $set: {
          Display_Alert: isAlertActive,
        },
      }
    );
    res.status(200).json({
      success: true,
      message: "all display alert are active",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to make all display alert active",
    });
  }
});

/**
 * GET /ENABLECAMERA (Environment variable endpoint)
 * 
 * Controls camera live status and handles pause/resume functionality.
 * When pausing, captures the last frame timestamp for reference.
 * 
 * @route GET /api/{ENABLECAMERA}
 * @param {string} req.query.Live - Boolean string indicating live status
 * @param {string} req.query.Camera_Name - Name of the camera to control
 * @returns {Object} Response confirming camera operation status
 */
router.get(process.env.ENABLECAMERA || '/enable-camera', async (req: any, res: any) => {
  let { Live, Camera_Name } = req.query;

  try {
    let liveParse = JSON.parse(Live);
    
    if (liveParse === false) {
      // Camera is being paused - capture last frame timestamp
      var result = fs.readdirSync(
        path.join(`${process.env.AKSHA_PATH}/${Camera_Name}/frame`)
      );
      
      // Process frame filenames to get timestamps
      let filterResult = result.map((fileName) => {
        return moment(
          fileName.split(".jpg")[0].replace("_", ":").replace("_", ":")
        ).format("YYYY-MM-DD HH:mm:ss");
      });

      // Update camera with paused status and last frame time
      await config.updateOne(
        { Camera_Name },
        {
          Live,
          PausedTime:
            filterResult.sort().slice(-1).length > 0
              ? filterResult.sort().slice(-1)[0]
              : "null",
        }
      );

      return res.status(200).json({
        success: true,
        message: "success to perform camera operation",
      });
    }

    // Camera is being resumed - clear paused time
    await config.updateOne({ Camera_Name }, { Live, PausedTime: "null" });

    res.status(200).json({
      success: true,
      message: "success to perform camera operation",
    });
  } catch (error: any) {
    debug(error);
    res.status(400).json({
      success: false,
      message: "unable to perform camera operation",
    });
  }
});

/**
 * GET /SURVEILLANCESTATUS (Environment variable endpoint)
 * 
 * Updates the surveillance status for a specific camera.
 * Controls whether the camera is actively monitoring or stopped.
 * 
 * @route GET /api/{SURVEILLANCESTATUS}
 * @param {string} req.query.Surveillance_Status - New surveillance status
 * @param {string} req.query.Camera_Name - Name of the camera to update
 * @returns {Object} Response confirming surveillance status update
 */
router.get(process.env.SURVEILLANCESTATUS || '/surveillance-status', async (req: any, res: any) => {
  let { Surveillance_Status, Camera_Name } = req.query;

  try {
    await config.updateOne({ Camera_Name }, { Surveillance_Status });

    res.status(200).json({
      success: true,
      message: "success to perform Surveillance operation",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: "unable to perform Surveillance operation",
    });
  }
});

export default router;
