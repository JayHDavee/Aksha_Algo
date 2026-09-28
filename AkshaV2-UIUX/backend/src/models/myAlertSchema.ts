import mongoose, { Document, Schema } from "mongoose";
import * as moment from 'moment';

/**
 * Interface representing a custom alert document
 * 
 * This interface defines the structure of custom alert configurations
 * that users can create to monitor specific objects, areas, and time periods
 * with customizable notification preferences.
 */
export interface IAlert extends Document {
  Alert_Name: string;
  No_Object_Status: boolean;
  Object_Class: string;
  Object_Area: number[][];
  Start_Time: string;
  End_Time: string;
  Days_Active: string[];
  Holiday_Status: boolean;
  Workday_Status: boolean;
  Alert_Status: string;
  Display_Activation: boolean;
  Email_Activation: boolean;
  Timestamp: string;
  Camera_Name: string[];
  Alert_Description?: string;
}

/**
 * Mongoose schema for custom alerts
 * 
 * Defines the structure and validation rules for user-defined alert configurations:
 * - Alert identification and description
 * - Object detection parameters (class, area)
 * - Time-based activation rules (schedule, days)
 * - Notification preferences (display, email)
 * - Camera associations
 * - Status tracking
 */
const alert: Schema = new Schema<IAlert>(
  {
    Alert_Name: {
      type: String,
      required: [true, "alert name is required"],
      unique: true,
    },
    No_Object_Status: {
      type: Boolean,
      required: [true, "no object status is required"],
    },
    Object_Class: {
      type: String,
      required: [true, "object class is required"],
    },
    // Array of polygon coordinates defining detection areas
    Object_Area: [[{ type: Number }]],
    Start_Time: {
      type: String,
      required: [true, "start time is required"],
    },
    End_Time: {
      type: String,
      required: [true, "end time is required"],
    },
    Days_Active: [
      { type: String, required: [true, "Days Active is required"] },
    ],
    Holiday_Status: {
      type: Boolean,
      required: [true, "holiday status is required"],
    },
    Workday_Status: {
      type: Boolean,
      required: [true, "workday status is required"],
    },
    Alert_Status: {
      type: String,
      required: [true, "alert status is required"],
    },
    Display_Activation: {
      type: Boolean,
      required: [true, "display activation is required"],
    },
    Email_Activation: {
      type: Boolean,
      required: [true, "email activation is required"],
    },
    Timestamp: String,
    Camera_Name: [
      { type: String, required: [true, "camera name is required"] },
    ],
    Alert_Description: String,
  },
  {
    collection: "Alerts",
    // Add timestamps for tracking document changes
    timestamps: true,
  }
);

/**
 * Pre-save middleware to automatically set timestamp
 * 
 * This middleware runs before saving an alert document and automatically
 * sets the Timestamp field to the current UTC time in ISO format.
 */
alert.pre<IAlert>("save", async function (next) {
  this.Timestamp = moment.utc().format();
  next();
});

/**
 * Mongoose model for custom alerts
 * 
 * This model provides an interface to the alerts collection in MongoDB,
 * enabling CRUD operations on custom alert configurations.
 * 
 * @example
 * // Create a new alert
 * const newAlert = await Alerts.create({
 *   Alert_Name: "Motion Detection Alert",
 *   No_Object_Status: false,
 *   Object_Class: "person",
 *   Object_Area: [[100, 100], [200, 100], [200, 200], [100, 200]],
 *   Start_Time: "09:00",
 *   End_Time: "17:00",
 *   Days_Active: ["Monday", "Tuesday", "Wednesday"],
 *   Holiday_Status: false,
 *   Workday_Status: true,
 *   Alert_Status: "active",
 *   Display_Activation: true,
 *   Email_Activation: true,
 *   Camera_Name: ["Camera1", "Camera2"],
 *   Alert_Description: "Detect people in restricted area"
 * });
 * 
 * @example
 * // Find alerts by camera name
 * const alerts = await Alerts.find({ Camera_Name: { $in: ["Camera1"] } });
 */
const Alerts = mongoose.model<IAlert>("Alerts", alert);

export default Alerts;
