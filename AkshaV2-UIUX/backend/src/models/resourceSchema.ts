import mongoose, { Document, Schema } from "mongoose";

/**
 * Interface representing a notification resource document
 * 
 * This interface defines the structure of notification and resource
 * configuration data, including email settings, Telegram bot configuration,
 * alert report preferences, and GenAI feature toggles.
 */
export interface INotificationResource extends Document {
  notification_email: string[];
  username: string;
  new_email: string;
  bot_token?: string;
  chat_ids: string[];
  send_alert_report: boolean;
  alert_report_email: string[];
  genai_features: boolean;
}

/**
 * Mongoose schema for notification and resource configuration
 * 
 * Defines the structure and validation rules for system-wide notification settings:
 * - Email notification configuration (general and alert reports)
 * - User account settings (username, email)
 * - Telegram bot integration (token and chat IDs)
 * - Feature toggles (alert reports, GenAI features)
 * - Resource management settings
 */
const notification: Schema = new Schema<INotificationResource>(
  {
    notification_email: [{ type: String }],
    username: {
      type: String,
      required: [true, "Username is required"],
      unique: true,
    },
    new_email: {
      type: String,
      required: [true, "New_Email is required"],
      unique: true,
    },
    bot_token: {
      type: String,
      required: false,
      unique: true,
      sparse: true, // Allow multiple null values for unique constraint
    },
    chat_ids: [{ type: String }],
    send_alert_report: {
      type: Boolean,
      default: false,
    },
    alert_report_email: [{ type: String }],
    genai_features: {
      type: Boolean,
      default: false,
    },
  },
  {
    collection: "Resource",
    // Add timestamps for tracking document changes
    timestamps: true,
  }
);

/**
 * Mongoose model for notification and resource configuration
 * 
 * This model provides an interface to the Resource collection in MongoDB,
 * enabling CRUD operations on system-wide notification and resource settings.
 * Typically, there should be only one document in this collection representing
 * the global system configuration.
 * 
 * @example
 * // Create or update notification settings
 * const config = await Resource.findOneAndUpdate(
 *   {},
 *   {
 *     notification_email: ["admin@example.com", "alerts@example.com"],
 *     username: "admin",
 *     new_email: "admin@example.com",
 *     bot_token: "telegram_bot_token",
 *     chat_ids: ["chat_id_1", "chat_id_2"],
 *     send_alert_report: true,
 *     alert_report_email: ["reports@example.com"],
 *     genai_features: true
 *   },
 *   { upsert: true, new: true }
 * );
 * 
 * @example
 * // Get current notification settings
 * const settings = await Resource.findOne();
 */
const Resource = mongoose.model<INotificationResource>("Resource", notification);

export default Resource;
