import mongoose, { Document, Schema } from "mongoose";

/**
 * Interface representing a Camera Group document
 * 
 * Defines the structure of a camera group in MongoDB,
 * including group details, associated cameras, and timestamps.
 */
export interface ICameraGroup extends Document {
  group_name: string;
  description?: string;
  priority_type: string;
  cameras: {
    camera_id: mongoose.Types.ObjectId;
    camera_name: string;
    custom_order: number;
  }[];
  created_at: Date;
  updated_at: Date;
}

/**
 * Mongoose schema for Camera Group
 * 
 * This schema includes:
 * - Group metadata (name, description, priority)
 * - Array of cameras with reference IDs and order
 * - Timestamps for creation and last update
 */
const cameraGroupSchema: Schema = new Schema<ICameraGroup>(
  {
    group_name: {
      type: String,
      required: [true, "Group name is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    priority_type: {
      type: String,
      enum: ["High", "Medium", "Low", "Custom"],
      default: "Custom",
    },
    cameras: [
      {
        camera_id: {
          type: Schema.Types.ObjectId,
          ref: "config", // Reference to camera configuration model
          required: true,
        },
        camera_name: {
          type: String,
          required: [true, "Camera name is required"],
        },
        custom_order: {
          type: Number,
          default: 0,
        },
      },
    ],
  },
  {
    collection: "camera_groups",
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

/**
 * Camera Group Model
 * 
 * Enables CRUD operations on the "camera_groups" collection.
 * 
 * @example
 * const newGroup = await CameraGroup.create({
 *   group_name: "Plant Area High Priority",
 *   description: "Cameras covering high-risk zones of the plant area",
 *   priority_type: "Custom",
 *   cameras: [
 *     { camera_id: new ObjectId(), camera_name: "cam1", custom_order: 1 },
 *     { camera_id: new ObjectId(), camera_name: "cam2", custom_order: 2 },
 *   ],
 * });
 */
const CameraGroup = mongoose.model<ICameraGroup>("CameraGroup", cameraGroupSchema);

export default CameraGroup;
