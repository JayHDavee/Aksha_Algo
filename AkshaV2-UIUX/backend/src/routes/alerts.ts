import mongoose from "mongoose";
import * as express from 'express';
const { Router } = express;
import { getIsPointInsidePolygon } from "../../utils/getInsidePolygon";
import moment from 'moment';
import * as path from 'path';
import * as fs from 'fs';
import config from "../models/configSchema";
import { fileURLToPath } from "url";
import os from 'os';

const debug = require("debug")("author");

/**
 * Alerts Routes Module
 * 
 * This module handles all alert-related API endpoints including:
 * - Manual alerts retrieval with time and date filtering
 * - Auto alerts retrieval with metadata integration
 * - User feedback submission for alerts
 * - Recent alerts fetching based on time range
 * - Object of interest filtering with area of interest support
 * 
 * All routes handle image file system operations and database queries
 * for comprehensive alert management functionality.
 */

const router = express.Router();


/**
 * GET /RECENT_ALERT/:hours (Environment variable endpoint)
 * 
 * Retrieves recent alerts from all cameras within the specified number of hours.
 * Searches through alert directories and filters based on timestamp.
 * 
 * @route GET /api/{RECENT_ALERT}/:hours
 * @param {string} req.params.hours - Number of hours to look back for recent alerts
 * @returns {Object} Response containing recent alerts from all cameras
 */


router.get((process.env.RECENT_ALERT) , async (req, res) => {
  try {
    // Get all camera configurations
    console.log("recent alert");
    const findCamera = await config.find({});
    const result = findCamera.map((data) => data.Camera_Name);
    const filterResult = result;
    const filterInfo: any[] = [];

    // Process each camera for recent alerts
    filterResult.forEach((cameraName) => {
      const format = 'YYYY-MM-DD';
      const hoursByUser = req.params.hours;
      let fromdate = new Date(moment().format(format));
      let todate = new Date(moment().subtract(Number(hoursByUser), 'hours').format(format));
      let images: string[] = [];
      
      console.log('todate = ', todate);
      console.log('fromdate = ', fromdate);
      
      // Collect images within the time range
      while (todate <= fromdate) {
        const date = moment(todate).format("YYYY-MM-DD");
        todate = new Date(date);
        try {
          const image = fs.readdirSync(
            path.join(`${process.env.AKSHA_PATH}/${cameraName}/alerts/${date}/`)
          );
          images.push(...image);
        } catch {
          console.log('no folder for this date');
        }
        todate.setDate(todate.getDate() + 1);
      }
      
      console.log('images = ', images);
      
      // Filter all alert images
      const filterTimeStamp = images.filter((image) => {
        return image;
      });
      
      // Filter based on the specified time range
      const removeImageExt = filterTimeStamp.filter((image) => {

        let date =""
        if (process.platform === "win32"){
date = image
          .replace("_autoalert.jpg", "")
          .replace("_alert.jpg", "")
          .replace("", ":")
          .replace("", ":");
        }
        else{
          date = image
          .replace("_autoalert.jpg", "")
          .replace("_alert.jpg", "")
          .replace("_", ":")
          .replace("_", ":");
        }
        

          console.log(date);
        const customFormat = 'YYYY-MM-DD HH:mm:ss';
        const time = moment(date, customFormat);
        const beforeTime = moment(moment(), customFormat).subtract(Number(hoursByUser), 'hours');
        const afterTime = moment(moment(), customFormat);
        const condition = time.isBetween(beforeTime, afterTime, undefined, '[]');

        return condition === true;
      });

      // Add camera data if it has recent alerts
      if (removeImageExt.length > 0) {
        filterInfo.push({
          cameraName: cameraName,
          date: removeImageExt,
        });
      }
    });

    // Generate image URLs for recent alerts
    const filterAlert = filterInfo.map((data) => {
      return {
        cameraName: data.cameraName,
        images: data.date.map((info: string) => {
          const folderdate = info.split(' ')[0];
          return (
            `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${data.cameraName}/alerts/${folderdate}/` +
            `${info}`
          );
        }).reverse(),
      };
    });

    console.log('filteralert', filterAlert);
    res.status(200).json({
      success: true,
      message: "Recent Alerts are found successfully",
      alert: filterAlert,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
      alert: [],
    });
  }
});


/**
 * POST /MY_ALERT (Environment variable endpoint)
 * 
 * Retrieves manual alerts for a specific camera within a given time range.
 * Searches through alert directories and filters images based on timestamp.
 * 
 * @route POST /api/{MY_ALERT}
 * @param {Object} req.body - Request body containing filter parameters
 * @param {string} req.body.Start_Time - Start time for filtering (HH:mm format)
 * @param {string} req.body.End_Time - End time for filtering (HH:mm format)
 * @param {string} req.body.Camera_Name - Name of the camera to search alerts for
 * @param {string} req.body.Start_Date - Start date for filtering (YYYY-MM-DD format)
 * @param {string} req.body.End_Date - End date for filtering (YYYY-MM-DD format)
 * @returns {Object} Response containing filtered alert images with URLs
 */
router.post(process.env.MY_ALERT || '/my-alert', async (req: any, res: any) => {
  console.log("myAlert calling");
  const { Start_Time, End_Time, Camera_Name, Start_Date, End_Date } = req.body;
  

  try {

    

    // Validate required parameters
    if (!Start_Time || !End_Time || !Camera_Name || !Start_Date || !End_Date) {
      return res.status(400).json({
        success: false,
        message: "please provide all detail",
      });
    }

    // Get all camera configurations from database
    const findCamera = await config.find({});
    const result = findCamera.map((data) => data.Camera_Name);

    // Filter cameras that match the requested camera name
    const filterResult = result.filter((folderName) => {
      return folderName.includes(Camera_Name);
    });

   // console.log('filterResult =', filterResult);

    const filterInfo: any[] = [];

    // Process each matching camera
    filterResult.forEach((cameraName) => {
      const currentdate = moment(Start_Date, "DD/MM/YY").toDate();
      const enddate = moment(End_Date, "DD/MM/YY").toDate();
      let images: string[] = [];
      
      // Iterate through date range to collect all alert images
      while (currentdate <= enddate) {
        const date = moment(currentdate).format("YYYY-MM-DD");
        try {
          const image = fs.readdirSync(
            path.join(`${process.env.AKSHA_PATH}/${cameraName}/alerts/${date}/`)
          );
          //console.log(images);
          images.push(...image);
        } catch {
          console.log('no folder for this date');
        }
        currentdate.setDate(currentdate.getDate() + 1);
      }
      
      // Filter images that are manual alerts (contain "_alert.jpg")
      const filterTimeStamp = images.filter((image) => {
        return image.includes("_alert.jpg");
      });
      
      // Filter images based on time range
      const removeImageExt = filterTimeStamp.filter((image) => {
      

       
        let date = "";
if (process.platform === "win32") {
   date = image
          .replace("_alert.jpg", "")
          .replace("", ":")
          .replace("", ":");
} else if (process.platform === "linux") {
   date = image
          .replace("_alert.jpg", "")
          .replace(":", ":")
          .replace(":", ":");
}
       

       const startDateTime = moment(`${Start_Date} ${Start_Time}`, "DD/MM/YY HH:mm");
const endDateTime = moment(`${End_Date} ${End_Time}`, "DD/MM/YY HH:mm");
const dateMoment = moment(date, "YYYY-MM-DD HH:mm");

const dateValidate = dateMoment.isBetween(startDateTime, endDateTime, undefined, "[]"); 

        if (dateValidate === true) {
          const format = "HH:mm:ss";
          const time = moment(moment(date).format("HH:mm"), format);
          const start = moment(Start_Time, format);
          const end = moment(End_Time, format);

          return time.isBetween(start, end);
        } else {
          return false;
        }
      });

      
      
      debug(filterInfo);
      
      // Add camera data if it has matching alerts
      if (removeImageExt.length > 0) {
        filterInfo.push({
          cameraName: cameraName,
          date: removeImageExt,
        });
      }
    });

    // Generate image URLs for the specific requested camera
    const filterAlert = filterInfo.map((data) => {
      
      if (data.cameraName === Camera_Name) {
        return {
          cameraName: data.cameraName,
          images: data.date.map((info: string) => {
           
            const images_date =(info.split(' ')[0]);
            return (
              `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${data.cameraName}/alerts/${images_date}/` +
              `${info}`
            );
          }),
        };
      } else {
        return {};
      }
    });
   
    res.status(200).json({
      success: true,
      message: "My Alerts are found successfully",
      alert: filterAlert,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
      alert: [],
    });
  }
});

/**
 * POST /AUTO_ALERT (Environment variable endpoint)
 * 
 * Retrieves auto-generated alerts with metadata integration.
 * Combines file system alert images with database metadata for comprehensive alert information.
 * 
 * @route POST /api/{AUTO_ALERT}
 * @param {Object} req.body - Request body containing filter parameters
 * @param {string} req.body.camera_name - Name of the camera to search alerts for
 * @param {string} req.body.start_date - Start date for filtering
 * @param {string} req.body.end_date - End date for filtering
 * @param {string} req.body.start_time - Start time for filtering
 * @param {string} req.body.end_time - End time for filtering
 * @returns {Object} Response containing auto alerts with metadata and user feedback
 */
router.post(process.env.AUTO_ALERT || '/auto-alert', async (req: any, res: any) => {
  const { camera_name, start_date, end_date, start_time, end_time } = req.body;

  // Validate required parameters
  if (!camera_name || !start_date || !end_date || !start_time || !end_time) {
    return res.status(400).json({
      success: false,
      message: "please provide proper data to find alert",
      alert: [],
    });
  }

  try {
    // Get camera configurations and metadata
    const findCamera = await config.find({});
    const result = findCamera.map((data) => data.Camera_Name);

    const metaAlert = mongoose.connection.db.collection(`meta_${camera_name}`);
    const findMeta = await metaAlert.find().toArray();

    // Filter cameras matching the requested name
    const filterResult = result.filter((folderName) => {
      return folderName.includes(camera_name);
    });

    const filterInfo: any[] = [];

    // Process each matching camera for auto alerts
    filterResult.forEach((cameraName) => {
      let currentdate = new Date(start_date);
      const enddate = new Date(end_date);
      let images: string[] = [];
      
      // Collect auto alert images across date range
      while (currentdate <= enddate) {
        const date = moment(currentdate).format("YYYY-MM-DD");
        try {
          const image = fs.readdirSync(
            path.join(`${process.env.AKSHA_PATH}/${cameraName}/alerts/${date}/`)
          );
          images.push(...image);
        } catch {
          console.log('no folder for this date');
        }
        currentdate.setDate(currentdate.getDate() + 1);
      }
      
      console.log('images = ', images);
      
      // Filter for auto alert images
      const filterTimeStamp = images.filter((image) => {
        return image.includes("_autoalert.jpg");
      });
      
      console.log('filterTimeStamp = ', filterTimeStamp);
      
      // Filter based on time range
      const removeImageExt = filterTimeStamp.filter((image) => {

        let date = "";
        if (process.platform === "win32") {
   date = image
          .replace("_autoalert.jpg", "")
          .replace("", ":")
          .replace("", ":");
} else if (process.platform === "linux") {
   date = image
          .replace("_autoalert.jpg", "")
          .replace(":", ":")
          .replace(":", ":");
}
else{
  date = image
          .replace("_autoalert.jpg", "")
          .replace(":", ":")
          .replace(":", ":");
   
}


        const dateValidate = moment(moment(date).format("YYYY-MM-DD HH:mm"))
          .isBetween(
            `${moment(start_date).format("YYYY-MM-DD")} ${start_time}`,
            `${moment(end_date).format("YYYY-MM-DD")} ${end_time}`,
            undefined,
            "[]"
          );
        
        
        if (dateValidate === true) {
          const format = "HH:mm:ss";
          const time = moment(moment(date).format("HH:mm"), format);
          const start = moment(start_time, format);
          const end = moment(end_time, format);

          return time.isBetween(start, end);
        } else {
          return false;
        }
      });

      // Add camera data if it has matching auto alerts
      if (removeImageExt.length > 0) {
        filterInfo.push({
          cameraName: cameraName,
          date: removeImageExt,
        });
      }
    });

    // Combine alert images with metadata information
    const filterAlert = filterInfo.map((data) => {
      const newDate = data.date.map((infoDate: string) => {

        let formatDate = "";
        
        if (process.platform === "win32") {
   formatDate = infoDate
          .replace("_autoalert.jpg", "")
          .replace("", ":")
          .replace("", ":");
} else if (process.platform === "linux") {
  formatDate = infoDate
          .replace("_autoalert.jpg", "")
          .replace(":", ":")
          .replace(":", ":");
}
else{
  formatDate = infoDate
          .replace("_autoalert.jpg", "")
          .replace(":", ":")
          .replace(":", ":");
}


        
        return moment.utc(formatDate).format("YYYY-MM-DD HH:mm:ss");
      });
      
      console.log('newDate = ', newDate);
     
      if (data.cameraName === camera_name) {
        return {
          cameraName: data.cameraName,
          info: findMeta.map((metaData) => {
            // console.log('moment.utc(metaData.Timestamp).format("YYYY-MM-DD HH:mm:ss") = ', moment.utc(metaData.Timestamp).format("YYYY-MM-DD HH:mm:ss"));
            
            if (newDate.includes(moment.utc(metaData.Timestamp).format("YYYY-MM-DD HH:mm:ss"))) {
              let fileName = moment.utc(metaData.Timestamp).format("YYYY-MM-DD HH:mm:ss");
              if (process.platform === "win32") {
    fileName= moment.utc(metaData.Timestamp).format("YYYY-MM-DD HH:mm:ss").replace(/:/g, '');
} 
       
              console.log(fileName)
              return {
                _id: metaData._id,
                UserFeedback: metaData.UserFeedback,
                images:
                  `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${data.cameraName}/alerts/${moment.utc(metaData.Timestamp).format("YYYY-MM-DD")}/` +
                  `${fileName}_autoalert.jpg`,
              };
            }
          }),
        };
      } else {
        return {};
      }
    });
    
    // Filter out undefined entries from metadata mapping
    const nullFilter = filterAlert.map((e) => {
      return {
        cameraName: e.cameraName,
        info: e.info ? e.info.filter((info: any) => info !== undefined) : [],
      };
    });
    
    res.status(200).json({
      success: true,
      message: "Auto Alerts are found successfully",
      alert: nullFilter,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
      alert: [],
    });
  }
});

/**
 * POST /USERFEEDBACK (Environment variable endpoint)
 * 
 * Updates user feedback for a specific alert in the metadata collection.
 * Toggles the UserFeedback boolean value for the specified alert.
 * 
 * @route POST /api/{USERFEEDBACK}
 * @param {Object} req.body - Request body containing feedback parameters
 * @param {string} req.body.cameraName - Name of the camera
 * @param {string} req.body._id - MongoDB ObjectId of the alert
 * @param {boolean} req.body.UserFeedback - Current feedback status to toggle
 * @returns {Object} Response confirming feedback submission
 */
router.post(process.env.USERFEEDBACK || '/user-feedback', async (req: any, res: any) => {
  const { cameraName, _id, UserFeedback } = req.body;

  // Validate required parameters
  if (!cameraName || !_id || UserFeedback === "") {
    res.status(400).json({
      success: false,
      message: "please provide required field",
    });
  }

  try {
    // Update user feedback in the metadata collection
    const metaAlert = mongoose.connection.db.collection(`meta_${cameraName}`);
    await metaAlert.updateOne(
      { _id: new mongoose.Types.ObjectId(_id) },
      { $set: { UserFeedback: !UserFeedback } }
    );

    res.status(200).json({
      success: true,
      message: "user feedback submitted successfully",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});


/**
 * POST /OBJECT_OF_INTEREST (Environment variable endpoint)
 * 
 * Advanced alert filtering based on object detection and area of interest.
 * Searches metadata for specific objects and optionally filters by geographical area.
 * Supports crowd detection with configurable thresholds.
 * 
 * @route POST /api/{OBJECT_OF_INTEREST}
 * @param {Object} req.body - Request body containing filter parameters
 * @param {string} req.body.camera_name - Name of the camera to search
 * @param {string} req.body.start_date - Start date for filtering
 * @param {string} req.body.end_date - End date for filtering
 * @param {string} req.body.start_time - Start time for filtering
 * @param {string} req.body.end_time - End time for filtering
 * @param {string[]} req.body.object_of_interest - Array of object labels to search for
 * @param {number[][]} req.body.area_of_interest - Polygon coordinates for area filtering (optional)
 * @returns {Object} Response containing filtered alerts with object detection data
 */
router.post(process.env.OBJECT_OF_INTEREST || '/object-of-interest', async (req: any, res: any) => {
  // Destructure request parameters
  const {
    camera_name,
    start_date,
    end_date,
    start_time,
    end_time,
    object_of_interest,
    area_of_interest,
  } = req.body;

  // Validate required parameters
  if (
    !camera_name ||
    !start_date ||
    !end_date ||
    !start_time ||
    !end_time ||
    !object_of_interest
  ) {
    return res.status(400).json({
      success: false,
      message: "Unable to find alert",
      alert: [],
    });
  }

  try {
    // Find metadata collection for the specified camera
    const collection = await mongoose.connection.db.listCollections().toArray();
    const metaCollection = collection.filter((data) =>
      data.name.includes(`meta_${camera_name}`)
    );

    if (metaCollection.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No data found for the given camera",
        alert: [],
      });
    }

    // Get metadata with detection results
    const coll = mongoose.connection.db.collection(metaCollection[0].name);
    const filterMeta = await coll.find({ Result: { $not: { $size: 0 } } }).toArray();
 
    const allAlert: any[] = [];

     
    // Process each metadata entry
    filterMeta.forEach((data) => {
      let modifyiedData = moment.utc(data.Timestamp).format('YYYY-MM-DD HH:mm:ss');
  
      const joinPath = path.join(`${process.env.AKSHA_PATH}/${metaCollection[0].name.split("_")[1]}/`);
      
      const fileExist = fs.existsSync(path.join(`${joinPath}/frame/${moment.utc(data.Timestamp).format("YYYY-MM-DD")}`, `${modifyiedData}.jpg`)
      );
      

      // Generate image URL if file exists
      const imageUrl = fileExist
        ? `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/${metaCollection[0].name.split("_")[1]}/frame/${moment.utc(data.Timestamp).format("YYYY-MM-DD")}/` +
          `${modifyiedData}.jpg`
        : "";

    
    // Transform detection results into bounding box coordinates
      allAlert.push({
        _id: data._id,
        Timestamp: data.Timestamp,
        Results: data.Results.map((result: any, i: number) => {
          const x1 = [result.x, result.y];
          const x2 = [result.x + result.w, result.y];
          const x3 = [result.x + result.w, result.y + result.h];
          const x4 = [result.x, result.y + result.h];

          return {
            label: result.label,
            x: x1,
            y: x2,
            w: x3,
            h: x4,
          };
        }),
        Frame_Anomaly: data.Frame_Anomaly,
        Object_Anomaly: data.Object_Anomaly,
        camera_name: metaCollection[0].name.split("_")[1],
        image: imageUrl,
      });
    });

    

    // Filter alerts based on time range
    const filterOnTime = allAlert.filter((data) => {
      const dateValidate = moment(moment.utc(data.Timestamp).format("YYYY-MM-DD HH:mm")).isBetween(
        `${moment.utc(start_date).format("YYYY-MM-DD")} ${start_time}`,
        `${moment.utc(end_date).format("YYYY-MM-DD")} ${end_time}`,
        undefined,
        "[]"
      );
      
    
      if (dateValidate === true) {
        const format = "HH:mm:ss";
        const time = moment(moment.utc(data.Timestamp).format("HH:mm:ss"), format);
        const start = moment(start_time, format);
        const end = moment(end_time, format);
        return time.isBetween(start, end);
      } else {
        return false;
      }
    });

    filterOnTime.reverse();

    /**
     * Helper function to filter objects based on crowd detection logic
     * Handles special case for crowd detection with person counting
     * 
     * @param {Object} data - Alert data with detection results
     * @returns {Array} Filtered array of detected objects
     */
    const isCrowd = (data: any) => {
      let countarr: any[] = [];
      const crowd_thresh = 6;
      
      if (object_of_interest.includes('crowd')) {
        let personcount = 0;
        
        // Count persons and collect relevant objects
        data.Results.forEach((resultVal: any) => {
          if (resultVal.label === 'person') {
            personcount += 1;
          }
          if (object_of_interest.includes(resultVal.label) || resultVal.label === 'person') {
            countarr.push(resultVal);
          }
        });
        
        // Filter based on crowd threshold
        const shortlisted_images: any[] = [];
        for (let i = 0; i < countarr.length; i++) {
          if (countarr[i].label === 'person' && (personcount >= crowd_thresh || object_of_interest.includes('person'))) {
            shortlisted_images.push(countarr[i]);
          } else if (countarr[i].label !== 'person') {
            shortlisted_images.push(countarr[i]);
          }
        }
        countarr = shortlisted_images;
        return countarr;
      } else {
        // Standard object filtering
        data.Results.forEach((resultVal: any) => {
          if (object_of_interest.includes(resultVal.label)) {
            countarr.push(resultVal);
          }
        });
        return countarr;
      }
    };

    // Filter alerts based on object of interest
   
    const filterAlert = filterOnTime
      .map((data) => ({
        _id: data._id,
        Timestamp: data.Timestamp,
        Results: isCrowd(data),
        Frame_Anomaly: data.Frame_Anomaly,
        Object_Anomaly: data.Object_Anomaly,
        camera_name: data.camera_name,
        image: data.image,
      }))
      .filter((data) => data.Results.length > 0);

    // Return results if no area of interest specified
    if (area_of_interest.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Data found successfully",
        alert: filterAlert,
      });
    }

    // Filter based on area of interest using centroid calculation
    const newFilterAlert: any[] = [];
  
    filterAlert.forEach((data) => {
      const insiderPoints = data.Results.filter((Results: any) => {
        // Calculate centroid of bounding box
        const centroid_of_bounding_box_X = (Results.x[0] + Results.y[0]) / 2;
        const centroid_of_bounding_box_Y = (Results.x[1] + Results.h[1]) / 2;
        const centroid: [number, number] = [centroid_of_bounding_box_X, centroid_of_bounding_box_Y];
        
        // Check if centroid is inside the area of interest
        return ![getIsPointInsidePolygon(centroid, area_of_interest)].includes(false);
      });

      // Add alert if it has objects inside the area of interest

      if (insiderPoints.length > 0) {
        newFilterAlert.push({
          _id: data._id,
          Timestamp: data.Timestamp,
          Results: insiderPoints,
          Frame_Anomaly: data.Frame_Anomaly,
          Object_Anomaly: data.Object_Anomaly,
          camera_name: data.camera_name,
          image: data.image,
        });
      }
    });

    res.status(200).json({
      success: true,
      message: "Data found successfully",
      alert: newFilterAlert,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
      alert: [],
    });
  }
});

export default router;