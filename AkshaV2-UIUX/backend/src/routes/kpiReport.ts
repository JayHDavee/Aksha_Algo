import express, { Request, Response, Router } from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getAllDatesBetween } from "../../utils/dateTime";
import { RequestHandler } from "express";
dotenv.config();

const KPI_REPORT_ROUTE = process.env.KPI_REPORT;

if (!KPI_REPORT_ROUTE) {
  throw new Error("KPI_REPORT not defined in .env");
}

const router: Router = express.Router();
router.use(express.json());



interface KPIRequestBody {
  cameras: string[];
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
}

interface KPIFrame {
  timestamp: string;
  object_counts: Record<string, number>;
  frame_link: string;
}

interface KPICameraData {
  frames: Record<string, KPIFrame>;
}

interface KPIFileData {
  [cameraName: string]: KPICameraData;
}


const kpiReportHandler: RequestHandler<
  {},
  any,
  KPIRequestBody
> = async (req, res) => {
    try {
      const { cameras, startDate, endDate, startTime, endTime } = req.body;
      const akshaPath = process.env.AKSHA_PATH;

      if (!akshaPath) {
        res.status(500).json({
          success: false,
          message: "AKSHA_PATH not set in .env",
        });
        return;
      }

      if (!cameras || !startDate || !endDate || !startTime || !endTime) {
          res.status(400).json({
          success: false,
          message:
            "Missing required fields: cameras, startDate, endDate, startTime, or endTime",
        });
        return;
      }


      
      const allDates: string[] = getAllDatesBetween(startDate, endDate);
      const reports: any[] = [];
      const statusMessages: string[] = [];
   


      const daemonLogPath = path.join(akshaPath, "daemon_stat.log");
      const daemonLogData: string = fs.existsSync(daemonLogPath)
        ? fs.readFileSync(daemonLogPath, "utf-8")
        : "";

      for (const cam of cameras) {
        const cameraRecords: any[] = [];

        for (const date of allDates) {
          const filePath = path.join(
            akshaPath,
            "kpi_report",
            `${date}.json`
          );   console.log("Dates searched:", allDates);

          if (!fs.existsSync(filePath)) {
            if (daemonLogData && !hasConsecutiveTrueStatus(daemonLogData, date)) {
              const msg = `Skipped ${date}: Daemon inactive (no KPI data for ${cam}).`;
              console.log(msg);
              statusMessages.push(msg);
              continue;
            } else {
              const msg = `Skipped ${date}: KPI file not found for ${cam}, but daemon was active.`;
              console.log(msg);
              statusMessages.push(msg);
              continue;
            }
          }

          const fileData = fs.readFileSync(filePath, "utf-8");
          const jsonData: KPIFileData = JSON.parse(fileData);
          console.log("Looking for file:", filePath);

          if (!jsonData[cam] || !jsonData[cam].frames) continue;

          for (const [timeKey, frame] of Object.entries(
            jsonData[cam].frames
          )) {
            if (isTimeInRange(timeKey, startTime, endTime)) {
              cameraRecords.push({
                timestamp: frame.timestamp,
                counts: frame.object_counts,
                frame_link: frame.frame_link,
              });
            }
          }
        }

        if (cameraRecords.length > 0) {
          reports.push({
            camera_name: cam,
            records: cameraRecords,
          });
        }
      }

      if (reports.length === 0) {
         res.status(404).json({
          success: false,
          message: "No KPI data found for the given criteria",
          daemon_logs: statusMessages,
        });
        return;
      }

        res.status(200).json({
        success: true,
        report: reports,
    });
    return;

    } catch (error: any) {
      console.error("Error in KPI Report API:", error);
       res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
      return;
    }
};
router.post(KPI_REPORT_ROUTE, kpiReportHandler);

export default router;

/* -------------------- Helpers -------------------- */

function hasConsecutiveTrueStatus(logData: string, date: string): boolean {
  const lines = logData.split("\n");
  let consecutiveTrueCount = 0;

  for (const line of lines) {
    const parts = line.trim().split(" ");
    if (parts.length >= 3 && parts[0] === date && parts[2] === "True") {
      consecutiveTrueCount++;
      if (consecutiveTrueCount >= 4) return true;
    } else {
      consecutiveTrueCount = 0;
    }
  }

  return false;
}

function isTimeInRange(
  frameTime: string,
  startTime: string,
  endTime: string
): boolean {
  const [fh, fm] = frameTime.split(":").map(Number);
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);

  const frameMins = fh * 60 + fm;
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;

  return frameMins >= startMins && frameMins <= endMins;
}
