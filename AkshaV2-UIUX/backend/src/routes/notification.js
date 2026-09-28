import express from "express";
import notification from "../models/resourceSchema";
const router = express.Router();
import axios from "axios";

router.put(process.env.EMAILNOTIFICATIONUPDATE, async (req, res) => {
  const { Username,
    New_Email,
    Notification_Email, Alert_Report_Emails, Bot_token, Chat_ids, Gen_AI_features } = req.body;

  if (Notification_Email.length === 0) {
    return res.status(400).json({
      success: false,
      message: "please provide proper data!",
    });
  }
  try {
    const data = await notification.findOne();
    if (data) {
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
      notification.create({
        "notification_email": Notification_Email,
        "alert_report_email": Alert_Report_Emails,
        "username": Username,
        "new_email": New_Email,
        "bot_token": Bot_token,
        "chat_ids": Chat_ids,
        "genai_features": Gen_AI_features
      })
    }

    try {
     
      const response = await axios.post(
        `http://API_SERVICE:4000/Notifications`
      );
      console.log('response = ',response)
    } catch (error) {
      console.log("Could not restart cameras", error);
    }

    res.status(200).json({
      success: true,
      message: "Email Updated Successfully ",
    });
  } catch (error) {
    console.log(error)
    res.status(400).json({
      success: false,
      message: error,
    });
  }
});

router.get(process.env.EMAILNOTIFICATION, async (req, res) => {
  try {

    const { notification_email, alert_report_email, bot_token, chat_ids, new_email, genai_features } = await notification.findOne();
    res.status(200).json({
      success: true,
      notification_email,
      alert_report_email,
      bot_token,
      chat_ids,
      new_email,
      genai_features
    });
  } catch (error) {
    res.status(400).json({
      
      success: false,
      message: error.msg,
    });
  }
});

export default router;
