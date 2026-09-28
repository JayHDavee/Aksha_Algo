import * as path from 'path';
import * as fs from 'fs';
import moment from 'moment';
import config from "../models/configSchema";

/**
 * Interface for live camera data structure
 */
interface ILiveCameraData {
  _id: any;
  rtsp_id: number;
  Rtsp_Link: string;
  Camera_Name: string;
  Description?: string;
  Feature: string[];
  Priority?: string;
  Status?: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  Active: boolean;
  FPS: number;
  Live: boolean;
  Surveillance_Status: string;
  PausedImage: string | null;
  image: string | null;
}

/**
 * Interface for spotlight camera data structure
 */
interface ISpotlightCameraData {
  camera_name: string;
  image: string;
}

/**
 * Interface for global configuration
 */
interface IGlobalConfig {
  workday: string;
}

/**
 * Camera Utility Functions Module
 * 
 * This module provides utility functions for camera data processing including:
 * - Retrieving live camera details with image URLs
 * - Processing spotlight camera information
 * - Handling workday/holiday image selection
 * - Managing paused camera states and frame references
 * 
 * The functions integrate with the file system to check for image availability
 * and construct appropriate URLs for camera feeds and static images.
 */

/**
 * Retrieves comprehensive live camera details with image URLs
 * 
 * This function fetches all camera configurations and enriches them with:
 * - Live image URLs based on workday/holiday status
 * - Paused image references for inactive cameras
 * - Surveillance status indicators
 * - Dynamic image path construction
 * 
 * @returns {Promise<ILiveCameraData[]>} Array of enriched camera data objects
 * 
 * @example
 * const cameras = await listLiveCamera();
 * cameras.forEach(camera => {
 *   console.log(`Camera: ${camera.Camera_Name}`);
 *   console.log(`Status: ${camera.Surveillance_Status}`);
 *   console.log(`Image URL: ${camera.image}`);
 * });
 */
export const listLiveCamera = async (): Promise<ILiveCameraData[]> => {
  // Fetch all camera configurations from database
  const cameraDetail = await config.find();
  
  // Process each camera to include image URLs and status information
  const newCameraDetail: ILiveCameraData[] = cameraDetail.map((data: any) => {
    // Construct path to live image directory for this camera
    const liveFolder = path.join(
      `${process.env.AKSHA_PATH}/${data.Camera_Name}/live`
    );

    // Read global configuration to determine workday/holiday status
    const days = fs.readFileSync(
      `${process.env.AKSHA_PATH}/global.json`,
      "utf-8"
    );
    const { workday }: IGlobalConfig = JSON.parse(days);

    // Construct base URL for serving images
    const nodeLink = `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`;

    // Determine appropriate image based on workday/holiday status
    let daysImage: string | null = null;
    if (workday === "true") {
      // Check for workday image
      if (fs.existsSync(path.join(liveFolder, "workday.jpg"))) {
        daysImage = `${nodeLink}/${data.Camera_Name}/live/workday.jpg`;
      }
    } else {
      // Check for holiday image
      if (fs.existsSync(path.join(liveFolder, "holiday.jpg"))) {
        daysImage = `${nodeLink}/${data.Camera_Name}/live/holiday.jpg`;
      }
    }

    // Construct paused image URL if camera is not live
    let pausedImage: string | null = null;
    if (data.Live === false && data.PausedTime && data.PausedTime !== "null") {
      const pausedDate = moment(data.PausedTime).format("YYYY-MM-DD");
      const pausedTime = moment(data.PausedTime).format("YYYY-MM-DD HH_mm_ss");
      const pausedImagePath = path.join(
        `${process.env.AKSHA_PATH}/${data.Camera_Name}/frame/${pausedDate}`,
        `${pausedTime}.jpg`
      );
      
      if (fs.existsSync(pausedImagePath)) {
        pausedImage = `${nodeLink}/${data.Camera_Name}/frame/${pausedDate}/${pausedTime}.jpg`;
      }
    }

    // Determine final image URL based on surveillance status
    let finalImage: string | null = null;
    if (data.Surveillance_Status === "stop") {
      // Use stop indicator image if surveillance is stopped
      const stopImagePath = path.join(`${process.env.AKSHA_PATH}`, "stop.jpg");
      if (fs.existsSync(stopImagePath)) {
        finalImage = `${nodeLink}/stop.jpg`;
      }
    } else {
      // Use workday/holiday image for active surveillance
      finalImage = daysImage;
    }

    // Return enriched camera data object
    return {
      _id: data._id,
      rtsp_id: data.rtsp_id,
      Rtsp_Link: data.Rtsp_Link,
      Camera_Name: data.Camera_Name,
      Description: data.Description,
      Feature: data.Feature,
      Priority: data.Priority,
      Status: data.Status,
      Email_Auto_Alert: data.Email_Auto_Alert,
      Display_Auto_Alert: data.Display_Auto_Alert,
      Active: data.Active,
      FPS: data.FPS,
      Live: data.Live,
      Surveillance_Status: data.Surveillance_Status,
      PausedImage: pausedImage,
      image: finalImage,
    };
  });

  return newCameraDetail;
};

/**
 * Retrieves spotlight camera information with appropriate images
 * 
 * This function processes camera configurations to find cameras with
 * available spotlight images based on the current workday/holiday status.
 * Only cameras with existing spotlight images are included in the result.
 * 
 * @returns {Promise<ISpotlightCameraData[]>} Array of spotlight camera objects
 * 
 * @example
 * const spotlightCameras = await listSpotlightCameras();
 * spotlightCameras.forEach(camera => {
 *   console.log(`Spotlight Camera: ${camera.camera_name}`);
 *   console.log(`Image URL: ${camera.image}`);
 * });
 */
export const listSpotlightCameras = async (): Promise<ISpotlightCameraData[]> => {
  // Fetch all camera configurations from database
  const cameraDetail = await config.find();
  
  // Read global configuration to determine workday/holiday status
  const days = fs.readFileSync(
    `${process.env.AKSHA_PATH}/global.json`,
    "utf-8"
  );
  const { workday }: IGlobalConfig = JSON.parse(days);

  // Construct base URL for serving images
  const nodeLink = `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`;

  // Filter cameras that have spotlight images available
  const filterInfo: ISpotlightCameraData[] = [];
  
  cameraDetail.forEach(({ Camera_Name: cameraName }) => {
    // Construct path to spotlight image directory for this camera
    const filePath = path.join(
      `${process.env.AKSHA_PATH}/${cameraName}/spotlight`
    );
    
    // Check for existence of workday and holiday spotlight images
    const workdayFile = fs.existsSync(path.join(filePath, "workday.jpg"));
    const holidayFile = fs.existsSync(path.join(filePath, "holiday.jpg"));
    
    // Include camera if appropriate spotlight image exists
    if (workdayFile && workday === "true") {
      // Add workday spotlight camera
      filterInfo.push({
        camera_name: cameraName,
        image: `${nodeLink}/${cameraName}/spotlight/workday.jpg`,
      });
    } else if (workday !== "true" && holidayFile) {
      // Add holiday spotlight camera
      filterInfo.push({
        camera_name: cameraName,
        image: `${nodeLink}/${cameraName}/spotlight/holiday.jpg`,
      });
    }
  });
  return filterInfo;
};
