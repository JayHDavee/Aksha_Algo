import * as express from 'express';
const { Router } = express;
import notification from "../models/resourceSchema";
import axios from "axios";

/**
 * Notification Routes Module
 * 
 * This module handles notification configuration and management including:
 * - Email notification settings for alerts and reports
 * - Telegram bot configuration for instant messaging
 * - GenAI features configuration
 * - Integration with external API services for notification updates
 * 
 * The module provides functionality for:
 * - Updating notification preferences and contact information
 * - Retrieving current notification settings
 * - Managing multiple notification channels (email, Telegram)
 * - Triggering notification service updates via API calls
 */

const router = express.Router();

/**
 * PUT /EMAILNOTIFICATIONUPDATE (Environment variable endpoint)
 * 
 * Updates notification settings including email addresses, Telegram configuration,
 * and GenAI features. Also triggers an external API call to refresh notification services.
 * 
 * @route PUT /api/{EMAILNOTIFICATIONUPDATE}
 * @param {Object} req.body - Request body containing notification configuration
 * @param {string} req.body.Username - Username for notification system
 * @param {string} req.body.New_Email - New email address for notifications
 * @param {string[]} req.body.Notification_Email - Array of email addresses for general notifications
 * @param {string[]} req.body.Alert_Report_Emails - Array of email addresses for alert reports
 * @param {string} req.body.Bot_token - Telegram bot token for instant messaging
 * @param {string[]} req.body.Chat_ids - Array of Telegram chat IDs for notifications
 * @param {boolean} req.body.Gen_AI_features - Whether GenAI features are enabled
 * @returns {Object} Response confirming notification settings update
 * 
 * @example
 * PUT /api/email-notification-update
 * Body: {
 *   "Username": "admin",
 *   "New_Email": "admin@example.com",
 *   "Notification_Email": ["alert1@example.com", "alert2@example.com"],
 *   "Alert_Report_Emails": ["report@example.com"],
 *   "Bot_token": "telegram_bot_token",
 *   "Chat_ids": ["chat_id_1", "chat_id_2"],
 *   "Gen_AI_features": true
 * }
 */
router.put(process.env.EMAILNOTIFICATIONUPDATE || '/email-notification-update', async (req: any, res: any) => {
  const { 
    Username,
    New_Email,
    Notification_Email, 
    Alert_Report_Emails, 
    Bot_token, 
    Chat_ids, 
    Gen_AI_features 
  } = req.body;

  // Validate that notification email array is not empty
  if (Notification_Email.length === 0) {
    return res.status(400).json({
      success: false,
      message: "please provide proper data!",
    });
  }

  try {
    // Check if notification configuration already exists
    const data = await notification.findOne();
    
    if (data) {
      // Update existing notification configuration
      const { _id } = data;
      await notification.updateOne(
        { id: _id },
        {
          $set: {
            "notification_email": Notification_Email,
            "alert_report_email": Alert_Report_Emails,
            "username": Username,
            "new_email": New_Email,
            "bot_token": Bot_token,
            "chat_ids": Chat_ids,
            "genai_features": Gen_AI_features
          },
        }
      );
    } else {
      // Create new notification configuration if none exists
      await notification.create({
        "notification_email": Notification_Email,
        "alert_report_email": Alert_Report_Emails,
        "username": Username,
        "new_email": New_Email,
        "bot_token": Bot_token,
        "chat_ids": Chat_ids,
        "genai_features": Gen_AI_features
      });
    }

    try {
      // Trigger external API service to refresh notification settings
      const response = await axios.post(
        `http://API_SERVICE:4000/Notifications`
      );
      console.log('API Service response = ', response.data);
    } catch (error: any) {
      console.log("Could not restart notification service", error);
      // Note: We don't fail the main operation if API service call fails
    }

    res.status(200).json({
      success: true,
      message: "Email Updated Successfully",
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
 * GET /EMAILNOTIFICATION (Environment variable endpoint)
 * 
 * Retrieves current notification settings including email addresses,
 * Telegram configuration, and GenAI features status.
 * 
 * @route GET /api/{EMAILNOTIFICATION}
 * @returns {Object} Response containing current notification configuration
 * @returns {boolean} response.success - Indicates if the request was successful
 * @returns {string[]} response.notification_email - Array of general notification email addresses
 * @returns {string[]} response.alert_report_email - Array of alert report email addresses
 * @returns {string} response.bot_token - Telegram bot token
 * @returns {string[]} response.chat_ids - Array of Telegram chat IDs
 * @returns {string} response.new_email - New email address setting
 * @returns {boolean} response.genai_features - GenAI features enabled status
 * 
 * @example
 * GET /api/email-notification
 * Response: {
 *   "success": true,
 *   "notification_email": ["alert1@example.com"],
 *   "alert_report_email": ["report@example.com"],
 *   "bot_token": "telegram_token",
 *   "chat_ids": ["chat_id_1"],
 *   "new_email": "admin@example.com",
 *   "genai_features": true
 * }
 */
router.get(process.env.EMAILNOTIFICATION || '/email-notification', async (req: any, res: any) => {
  try {
    // Retrieve notification configuration from database
    const notificationData = await notification.findOne();
    
    if (!notificationData) {
      return res.status(404).json({
        success: false,
        message: "No notification configuration found",
      });
    }

    const { 
      notification_email, 
      alert_report_email, 
      bot_token, 
      chat_ids, 
      new_email, 
      genai_features 
    } = notificationData;

    res.status(200).json({
      success: true,
      notification_email,
      alert_report_email,
      bot_token,
      chat_ids,
      new_email,
      genai_features
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

export default router;
