import express, { Router, Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import "./db/connection";
import * as path from 'path';
import "dotenv/config";
import cookieParser from "cookie-parser";
import axios from "axios";


import alerts from "./routes/alerts";
import investigation from "./routes/investigation";
import cameras from "./routes/cameras";
import myAlerts from "./routes/myAlerts";
import insight from "./routes/insight";
import insightReport from "./routes/insightReport";
import days from "./routes/days";
import monitor from "./routes/monitor";
import notification from "./routes/notification";
import jwtAuthMiddleware from "./middleware/jwtAuthMiddleware";
import activeCamera from "./routes/activeCamera";
import cameraGroup from "./routes/cameraGroup"
import cameraNotificationManager from "./routes/cameraNotificationManager";
import schedule from "node-schedule";
import kpiReportRoutes from "./routes/kpiReport";
import jewelryDashboardRoutes from "./routes/jewelryDashboard";

const appRoutes: Router = Router();

/**
 * Application Routes Setup
 * 
 * This module sets up all the API routes, middleware, and scheduled jobs.
 * It includes:
 * - Body parsing and cookie parsing middleware
 * - JWT authentication middleware
 * - API route handlers for alerts, investigation, cameras, etc.
 * - A scheduled job to clear cache daily at 22:30
 */

 // Body parser middleware

appRoutes.use(bodyParser.json());

// Parse cookies for this app. Using express built-in middleware
appRoutes.use((cookieParser as any)());

appRoutes.use(express.urlencoded({ extended: true }));
appRoutes.use(express.json());
appRoutes.use(express.static(path.resolve(`${process.env.AKSHA_PATH || ""}`)));

/**
 * Middleware to set API timeout to 30 seconds
 */
function apiTimeOut(req: Request, res: Response, next: NextFunction): void {
  res.setTimeout(30000);
  next();
}


// Unauthenticated routes accessible without JWT token
appRoutes.use("/api", monitor, apiTimeOut);
appRoutes.use('/ping',(req,res) => { 
  res.send("pong");
})
// JWT Authentication middleware for protected routes
// appRoutes.use((req, res, next) => {
//   Promise.resolve(jwtAuthMiddleware(req, res, next)).catch(next);
// });

// Authenticated routes requiring JWT token
appRoutes.use("/api", alerts, apiTimeOut);
appRoutes.use("/api", investigation, apiTimeOut);
appRoutes.use("/api", cameras, apiTimeOut);
appRoutes.use("/api", myAlerts, apiTimeOut);
appRoutes.use("/api", insight, apiTimeOut);
appRoutes.use("/api", insightReport, apiTimeOut);
appRoutes.use("/api", days, apiTimeOut);
appRoutes.use("/api", notification, apiTimeOut);
appRoutes.use("/api/active", activeCamera, apiTimeOut);
appRoutes.use("/api/camgroup", cameraGroup, apiTimeOut);
appRoutes.use("/api", kpiReportRoutes, apiTimeOut);
appRoutes.use("/api", jewelryDashboardRoutes, apiTimeOut);
appRoutes.use("/api/notification", cameraNotificationManager, apiTimeOut);

/**
 * Catch-all route for unmatched API requests
 */
appRoutes.use("/api", (req: Request, res: Response) => {
  res.status(404).send("Not Found");
});

/**
 * Function to clear cache by sending a POST request to API_SERVICE
 */
async function Clearcache(): Promise<any> {
  try {
    const response = await axios.post(`http://API_SERVICE:4000/DockerClean`);
    console.log("response = ", response.data);
    return response.data;
  } catch (error) {
    console.log("Could not restart cameras", error);
  }
}

/**
 * Schedule a daily job at 22:30 to clear cache
 */
schedule.scheduleJob({ hour: 22, minute: 30 }, () => {
  Clearcache()
    .then((result) => {
      console.log("POST request successful:", result);
    })
    .catch((error) => {
      console.error("Failed to send POST request:", error);
    });
});

export default appRoutes;
