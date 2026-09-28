import mongoose, { Document, Schema } from "mongoose";

/**
 * Camera Notification Manager Interface
 */
export interface ICameraNotificationManager extends Document {
  camera_group_id: mongoose.Types.ObjectId;

  email: {
    enabled: boolean;
    email_list: string; // comma-separated
  };

  mobile: {
    enabled: boolean;
    mobile_numbers: string; // comma-separated
  };

 mobile_app: {
    enabled: boolean;
    mobile_ids: string;        // comma-separated mobile_ids e.g. "ar_123,xyz_uuid"
  };

  telegram: {
    enabled: boolean;
    bot_token: string;
    chat_id: string;
  };

  alerts_enabled: boolean; // master switch per group

  created_at: Date;
  updated_at: Date;

  alerts_call_notification: {
    alert_call_enabled_notification: boolean;
    start_time: string;
    end_time: string;
  }
}

/**
 * Schema
 */
const cameraNotificationManagerSchema =
  new Schema<ICameraNotificationManager>(
    {
      camera_group_id: {
        type: Schema.Types.ObjectId,
        ref: "CameraGroup",
        required: true,
        unique: true, // one per group
      },

      email: {
        enabled: { type: Boolean, default: true },
        email_list: { type: String, default: "", trim: true },
      },

      mobile: {
        enabled: { type: Boolean, default: true },
        mobile_numbers: { type: String, default: "", trim: true },
      },

      mobile_app: {
        enabled:    { type: Boolean, default: true },
        mobile_ids: { type: String,  default: "", trim: true },  // stores mobile_ids
      },


      telegram: {
        enabled: { type: Boolean, default: false },
        bot_token: { type: String, default: "", trim: true },
        chat_id: { type: String, default: "", trim: true },
      },

      alerts_enabled: {
        type: Boolean,
        default: true, // GROUP LEVEL MASTER SWITCH
      },
      alerts_call_notification: {
        alert_call_enabled_notification: {
          type: Boolean,
          default: false,
        },
        start_time: {
          type: String,
          default: "07:00",
        },
        end_time: {
          type: String,
          default: "19:00",
        },
      }
    },
    {
      collection: "camera_notification_managers",
      timestamps: {
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    }
  );

const CameraNotificationManager =
  mongoose.model<ICameraNotificationManager>(
    "CameraNotificationManager",
    cameraNotificationManagerSchema
  );

export default CameraNotificationManager;
