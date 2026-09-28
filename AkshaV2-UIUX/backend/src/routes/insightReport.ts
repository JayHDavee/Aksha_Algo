import * as express from 'express';
const { Router } = express;
import * as fs from 'fs';
import notification from "../models/resourceSchema";
import { checkFileExists, getFileFromBlob } from "../azure/blob";
import { getAllDatesBetween } from "../../utils/dateTime";
import moment from 'moment';

/**
 * Interface for insight report request body
 */
interface IInsightReportRequest {
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  cameras?: string[];
  objectsOfInterest?: string[];
}

/**
 * Interface for camera alert data
 */
interface ICameraAlert {
  object: string;
  timestamp: string;
  [key: string]: any;
}

/**
 * Interface for camera data in insight report
 */
interface ICameraData {
  alerts: { [key: string]: ICameraAlert };
  total_alerts_generated: number;
  object_detection_alerts: { [key: string]: number };
  [key: string]: any;
}

/**
 * Interface for insight report response
 */
interface IInsightReport {
  cameras: {
    [key: string]: ICameraData;
  };
}

/**
 * Insight Report Routes Module
 * 
 * This module handles insight report generation and management including:
 * - Generating comprehensive insight reports for date ranges
 * - Filtering reports by cameras, time ranges, and objects of interest
 * - Managing email alert report settings
 * - Processing data from Azure Blob Storage or local files
 * - Aggregating alert data across multiple dates and cameras
 * 
 * The module provides functionality for:
 * - Multi-date insight report generation with filtering capabilities
 * - Email notification settings for alert reports
 * - Data aggregation and statistical analysis
 * - File existence validation and error handling
 */

const router = express.Router();

router.use(express.json());

/**
 * POST /INSIGHT_REPORT (Environment variable endpoint)
 * 
 * Generates comprehensive insight reports for specified date ranges and cameras.
 * Aggregates alert data from multiple sources and applies various filters.
 * 
 * @route POST /api/{INSIGHT_REPORT}
 * @param {Object} req.body - Request body containing report parameters
 * @param {string} req.body.startDate - Start date for report (YYYY-MM-DD format)
 * @param {string} req.body.endDate - End date for report (YYYY-MM-DD format)
 * @param {string} req.body.startTime - Start time filter (HH:mm:ss format)
 * @param {string} req.body.endTime - End time filter (HH:mm:ss format)
 * @param {string[]} req.body.cameras - Array of camera names to include (optional)
 * @param {string[]} req.body.objectsOfInterest - Array of object types to filter (optional)
 * @returns {Object} Response containing aggregated insight report data
 * 
 * @example
 * POST /api/insight-report
 * Body: {
 *   "startDate": "2023-01-01",
 *   "endDate": "2023-01-07",
 *   "startTime": "09:00:00",
 *   "endTime": "17:00:00",
 *   "cameras": ["Camera1", "Camera2"],
 *   "objectsOfInterest": ["person", "vehicle"]
 * }
 */
router.post(process.env.INSIGHT_REPORT || '/insight-report', async (req: any, res: any) => {
  const { startDate, endDate, startTime, endTime, cameras, objectsOfInterest } = req.body;

  console.log(objectsOfInterest);

  // Validate required date parameters
  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      message: "date is missing, or in incorrect format",
      report: {},
    });
  }

  // Validate required time parameters
  if (!startTime || !endTime) {
    return res.status(400).json({
      success: false,
      message: "time is missing, or in incorrect format",
      report: {},
    });
  }

  try {
    // Legacy daemon status checking (currently disabled)
    let a = 5;
    if (a > 6) {
      // Check if daemon status log file exists for data validation
      if (fs.existsSync(`${process.cwd()}/Aksha/daemon_stat.log`)) {
        const logData = fs.readFileSync(
          `${process.cwd()}/Aksha/daemon_stat.log`,
          "utf-8"
        );
        
        // Validate daemon was active during requested date
        if (hasConsecutiveTrueStatus(logData, startDate) === false) {
          return res.status(400).json({
            success: false,
            message: "Docker daemon was inactive for the day, no data found",
          });
        } else {
          // Process local JSON file data
          let result: any = {};
          const fileData = fs.readFileSync(
            `${process.cwd()}/Aksha/insight_report/${startDate}.json`,
            "utf-8"
          );
          const jsonData = JSON.parse(fileData);

          if (Object.keys(jsonData)?.length > 0) {
            const sortedAlerts = reverseSortAlerts(jsonData);
            result = sortedAlerts;
          }

          if (Object.keys(result)?.length > 0) {
            return res.status(200).json(result);
          } else {
            return res.status(400).json({});
          }
        }
      } else {
        return res.status(400).json({
          success: false,
          message: "Daemon status log file not found, check if cron tab was set correctly",
        });
      }
    } else {
      // Main processing logic for Azure Blob Storage data
      
      // Get all dates between start and end date (inclusive)
      const dates = getAllDatesBetween(startDate, endDate);

      // Check if all required files exist in Azure Blob Storage
      const allFilesExist = await Promise.all(
        dates.map((date) => checkFileExists(date))
      );
      
    
      // Filter out dates for which files do not exist
      const existingDates = dates.filter((date, index) => allFilesExist[index]);

      if (existingDates.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No data found for the requested date range",
        });
      }

      console.log("All files exist");
      
      // Retrieve files from Azure Blob Storage with their corresponding dates
      const files = await Promise.all(
        existingDates.map(async (date) => ({
          date,
          data: await getFileFromBlob(date),
        }))
      );
 
    console.log(files);
      
      // Combine data from all files into a single aggregated structure
      const combinedData = files.reduce((acc: any, file) => {
         const data = file.data;
        const jsonData = JSON.parse(data);

        // Process each camera's data
        Object.keys(jsonData).forEach((camName) => {
          if (camName in acc) {
            // Merge alerts from existing camera data
            Object.keys(jsonData[camName].alerts).forEach((time) => {
              acc[camName].alerts[`${file.date} ${time}`] = jsonData[camName].alerts[time];
            });
          } else {
            // Initialize new camera data
            acc[camName] = jsonData[camName];
            // Add date prefix to alert timestamps
            acc[camName].alerts = Object.keys(jsonData[camName].alerts).reduce(
              (alerts: any, time) => {
                alerts[`${file.date} ${time}`] = jsonData[camName].alerts[time];
                return alerts;
              },
              {}
            );
          }
        });
        return acc;
      }, {});

       
      const result = {
        cameras: combinedData,
      };

      
      // Apply camera filter if specified
      if (cameras && cameras.length > 0) {
        Object.keys(result.cameras).forEach((camName) => {
          if (!cameras.includes(camName)) {
            delete result.cameras[camName];
          }
        });
      }

      console.log("result: ", Object.keys(result.cameras));

      // Apply time range filter to alerts
      Object.keys(result.cameras).forEach((camName) => {
        const alerts = result.cameras[camName].alerts;
      
        Object.keys(alerts).forEach((dateTime) => {
          const time = moment(dateTime.split(" ")[1], "HH:mm:ss");
          
          if (
            !time.isBetween(
              moment(startTime, "HH:mm:ss"),
              moment(endTime, "HH:mm:ss"),
            )
          ) {
            delete alerts[dateTime];
          }
          
        });
    
      });

      // Apply objects of interest filter if specified
      if (objectsOfInterest && objectsOfInterest.length > 0) {
        Object.keys(result.cameras).forEach((camName) => {
          const alerts = result.cameras[camName].alerts;
          
          Object.keys(alerts).forEach((time) => {
            const object = alerts[time].object;

            let objectsOfInteresttrim = objectsOfInterest.map(o => o.replace(/\r$/, ''));

            if (!objectsOfInteresttrim.includes(object)) {
              delete alerts[time];
            }
          });
          console.log(alerts);
        });
      }

      // Recalculate statistics after filtering
      Object.keys(result.cameras).forEach((camName) => {
        const alerts = result.cameras[camName].alerts;
        
        // Update total alerts count
        result.cameras[camName].total_alerts_generated = Object.keys(alerts).length;
        
        // Recalculate object detection statistics
        result.cameras[camName].object_detection_alerts = Object.keys(alerts).reduce(
          (acc: any, time) => {
            if (acc[alerts[time].object]) {
              acc[alerts[time].object] += 1;
            } else {
              acc[alerts[time].object] = 1;
            }
            
            return acc;
          },
          {}
        );
      });
      console.log('result',result);
      if (Object.keys(result.cameras)?.length > 0) {
        return res.status(200).json(result);
      } else {
        return res.status(400).json({
          success: false,
          message: "No data found for camera",
        });
      }
    }
  } catch (ex: any) {
    console.error(ex);
    return res.status(400).json({
      success: false,
      message: "Unable to process data required by the request. Check logs for more details",
      error: ex.message,
    });
  }
});

/**
 * GET /MAIL_INSIGHT_REPORT_STATUS (Environment variable endpoint)
 * 
 * Retrieves the current status of email alert report notifications.
 * 
 * @route GET /api/{MAIL_INSIGHT_REPORT_STATUS}
 * @returns {Object} Response containing email alert report status
 */
router.get(process.env.MAIL_INSIGHT_REPORT_STATUS || '/mail-insight-report-status', async (req: any, res: any) => {
  try {
    const notificationData = await notification.findOne();
    if (!notificationData) {
      return res.status(404).json({
        success: false,
        message: "Notification settings not found",
      });
    }
    console.log(notificationData);
    const { send_alert_report } = notificationData;
    res.status(200).json({
      success: true,
      send_alert_report
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * PUT /MAIL_INSIGHT_REPORT (Environment variable endpoint)
 * 
 * Updates the email alert report notification settings.
 * 
 * @route PUT /api/{MAIL_INSIGHT_REPORT}
 * @param {Object} req.body - Request body containing email settings
 * @param {boolean} req.body.send_email - Whether to send email alert reports
 * @returns {Object} Response confirming settings update
 */
router.put(process.env.MAIL_INSIGHT_REPORT || '/mail-insight-report', async (req: any, res: any) => {
  const { send_email } = req.body;
  
  try {
    const data = await notification.findOne();
    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Notification settings not found",
      });
    }
    const { _id } = data;
    console.log('data = ', data);
    
    // Update email alert report setting
    await notification.updateOne(
      { id: _id },
      {
        $set: {
          "send_alert_report": send_email
        },
      }
    );
    
    res.status(200).json({
      success: true,
      message: "Alert Report status modified",
    });
  } catch (error: any) {
    console.log(error);
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

/**
 * Helper function to check if daemon had consecutive true status for a given date.
 * Validates that the system was active and collecting data properly.
 * 
 * @param {string} logData - Raw log data from daemon status file
 * @param {string} date - Date to check in YYYY-MM-DD format
 * @returns {boolean} True if daemon was consistently active, false otherwise
 */
function hasConsecutiveTrueStatus(logData: string, date: string): boolean {
  const lines = logData.split('\n');
  let consecutiveTrueCount = 0;
  
  try {
    for (const line of lines) {
      const parts = line.split(' ');
      if (parts.length >= 3 && parts[0] === date && parts[2] === 'True') {
        consecutiveTrueCount++;
        if (consecutiveTrueCount >= 4) {
          return true;
        }
      } else {
        consecutiveTrueCount = 0;
      }
    }
    return false;
  } catch (error) {
    console.log(error);
    return false;
  }
}

/**
 * Helper function to reverse sort alerts by timestamp.
 * Organizes alerts in descending chronological order for better presentation.
 * 
 * @param {Object} jsonData - Raw JSON data containing camera alerts
 * @returns {Object} Processed data with reverse-sorted alerts
 */
const reverseSortAlerts = (jsonData: any): any => {
  const resultObject: any = {};
  console.log('resultObject = ', resultObject);

  Object.keys(jsonData).forEach((camName) => {
    const camObject = jsonData[camName];
    const alerts: any = {};

    // Sort alert timestamps in descending order
    Object.keys(jsonData[camName].alerts)
      .sort((a, b) => b.localeCompare(a))
      .forEach((time) => {
        alerts[time] = jsonData[camName].alerts[time];
      });

    camObject.alerts = alerts;
    resultObject[camName] = camObject;
  });

  return resultObject;
};

export default router;
