import mongoose, { Document, Schema } from "mongoose";

/**
 * Interface representing a camera configuration document
 * 
 * This interface defines the structure of camera configuration data
 * stored in MongoDB, including RTSP stream details, camera settings,
 * alert configurations, and operational status.
 */
export interface ICameraConfig extends Document {
  rtsp_id: number;
  Rtsp_Link: string;
  Camera_Name: string;
  Description?: string;
  Feature: string[];
  Priority?: string;
  Status?: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  Email_Alert: boolean;
  Display_Alert: boolean;
  FPS: number;
  Alerts: mongoose.Types.ObjectId[];
  Active: boolean;
  Live: boolean;
  Surveillance_Status: string;
  PausedTime: string;
  group_id: number;
  PPE_Detection: boolean;
  Detection_Type: string;
}

/**
 * Mongoose schema for camera configuration
 * 
 * Defines the structure and validation rules for camera configuration data:
 * - RTSP stream configuration (ID and URL)
 * - Camera identification and description
 * - Feature and priority settings
 * - Alert configuration options
 * - Operational status tracking
 * - Alert associations
 */
const cameraDetail: Schema = new Schema<ICameraConfig>(
  {
    rtsp_id: {
      type: Number,
      required: [true, "rtsp id is required"],
      unique: true,
    },
    Rtsp_Link: {
      type: String,
      required: [true, "Rtsp_Link is required"],
      unique: true,
    },
    Camera_Name: {
      type: String,
      required: [true, "camera name is required"],
      unique: true,
    },
    Description: String,
    Feature: [{ type: String }],
    Priority: String,
    Status: String,
    Email_Auto_Alert: Boolean,
    Display_Auto_Alert: Boolean,
    Email_Alert: Boolean,
    Display_Alert: Boolean,
    FPS: Number,
    // Reference to alert documents
    Alerts: [{ type: Schema.Types.ObjectId, ref: 'alert' }],
    Active: Boolean,
    Live: {
      type: Boolean,
      default: true,
    },
    Surveillance_Status: {
      type: String,
      default: "start",
    },
    PausedTime: {
      type: String,
      default: "null",
    },
    group_id: {
      type: Number,
      enum: [0, 1], // only allow 0 or 1
      default: 0,
    },
    PPE_Detection: {
      type: Boolean,
      default: false,
    },
    // Replaces the old PPE_Detection boolean going forward — a single field
    // for which detection pipeline this camera runs (maps to the Python
    // controller's deployment_mode). "standard" omits deployment_mode
    // entirely when calling the controller, preserving its own default
    // (deepstream_nvinfer/deepstream_batch) unchanged for existing cameras.
    Detection_Type: {
      type: String,
      enum: ["standard", "ppe", "jewelry"],
      default: "standard",
    },
  },
  { 
    collection: "config",
    // Add timestamps for tracking document changes
    timestamps: true 
  }
);

/**
 * Mongoose model for camera configuration
 * 
 * This model provides an interface to the camera configuration collection
 * in MongoDB, enabling CRUD operations on camera configuration documents.
 * 
 * @example
 * // Create a new camera configuration
 * const newConfig = await config.create({
 *   rtsp_id: 1,
 *   Rtsp_Link: "rtsp://example.com/stream1",
 *   Camera_Name: "Camera1",
 *   Feature: ["motion_detection"],
 *   FPS: 30,
 *   Active: true
 * });
 * 
 * @example
 * // Find camera by name
 * const camera = await config.findOne({ Camera_Name: "Camera1" });
 */
const config = mongoose.model<ICameraConfig>("config", cameraDetail);

export default config;
