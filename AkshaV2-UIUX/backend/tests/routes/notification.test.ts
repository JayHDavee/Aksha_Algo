import request from "supertest";
import express from "express";
import router from "../../src/routes/notification"; // adjust path as needed
import notification from "../../src/models/resourceSchema";
import axios from "axios";

jest.mock("../../src/models/resourceSchema");
jest.mock("axios");

const app = express();
app.use(express.json());
app.use("/", router);

describe("Notification Routes", () => {

  // ------------------------------------------
  // TEST: PUT /email-notification-update
  // ------------------------------------------
  describe("PUT /email-notification-update", () => {
    const mockBody = {
      Username: "admin",
      New_Email: "admin@example.com",
      Notification_Email: ["a@a.com"],
      Alert_Report_Emails: ["b@b.com"],
      Bot_token: "telegram_bot",
      Chat_ids: ["123"],
      Gen_AI_features: true,
    };

    test("should return 400 if Notification_Email is empty", async () => {
      const res = await request(app)
        .put("/email-notification-update")
        .send({ ...mockBody, Notification_Email: [] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("please provide proper data!");
    });

    test("should update existing notification record", async () => {
      (notification.findOne as jest.Mock).mockResolvedValue({ _id: "1" });
      (notification.updateOne as jest.Mock).mockResolvedValue({});
      (axios.post as jest.Mock).mockResolvedValue({ data: { ok: true } });

      const res = await request(app)
        .put("/email-notification-update")
        .send(mockBody);

      expect(notification.findOne).toHaveBeenCalled();
      expect(notification.updateOne).toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("should create notification if none exists", async () => {
      (notification.findOne as jest.Mock).mockResolvedValue(null);
      (notification.create as jest.Mock).mockResolvedValue({});
      (axios.post as jest.Mock).mockResolvedValue({ data: { ok: true } });

      const res = await request(app)
        .put("/email-notification-update")
        .send(mockBody);

      expect(notification.create).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("should return 400 if DB error occurs", async () => {
      (notification.findOne as jest.Mock).mockRejectedValue(new Error("DB error"));

      const res = await request(app)
        .put("/email-notification-update")
        .send(mockBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeDefined();
    });
  });

  // ------------------------------------------
  // TEST: GET /email-notification
  // ------------------------------------------
  describe("GET /email-notification", () => {
    test("should return 404 when no config found", async () => {
      (notification.findOne as jest.Mock).mockResolvedValue(null);

      const res = await request(app).get("/email-notification");

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    test("should return existing configuration", async () => {
      const mockConfig = {
        notification_email: ["a@a.com"],
        alert_report_email: ["b@b.com"],
        bot_token: "token",
        chat_ids: ["123"],
        new_email: "admin@example.com",
        genai_features: true,
      };

      (notification.findOne as jest.Mock).mockResolvedValue(mockConfig);

      const res = await request(app).get("/email-notification");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notification_email).toEqual(mockConfig.notification_email);
      expect(res.body.genai_features).toBe(true);
    });

    test("should return 400 on DB error", async () => {
      (notification.findOne as jest.Mock).mockRejectedValue(new Error("DB fail"));

      const res = await request(app).get("/email-notification");

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
