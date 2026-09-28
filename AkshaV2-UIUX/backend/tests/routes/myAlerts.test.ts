import request from "supertest";
import express from "express";

// FIXED IMPORT PATHS
import router from "../../src/routes/myAlerts";
import Alert from "../../src/models/myAlertSchema";
import config from "../../src/models/configSchema";

jest.mock("../../src/models/myAlertSchema");
jest.mock("../../src/models/configSchema");

const app = express();
app.use(express.json());
app.use("/api", router);

describe("MyAlerts Routes", () => {
  it("POST /create-alert → should return 200 when alert is created", async () => {
    (Alert as any).mockImplementation(() => ({
      save: jest.fn().mockResolvedValue(true),
      id: "mockAlertId",
    }));

    (config.updateMany as any) = jest.fn().mockResolvedValue(true);

    const payload = {
      Alert_Name: "Alert1",
      Object_Class: ["person"],
      Object_Area: [[10, 10], [20, 20]],
      Start_Time: "08:00",
      End_Time: "18:00",
      Days_Active: ["Mon"],
      Holiday_Status: false,
      Workday_Status: true,
      Alert_Status: "active",
      Display_Activation: true,
      Email_Activation: false,
      Camera_Name: ["Cam1"],
      No_Object_Status: false,
    };

    const res = await request(app)
      .post("/api/create-alert")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
