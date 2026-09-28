import request from "supertest";
import express from "express";

// UPDATE the import path according to your project structure
import router from "../../src/routes/cameras";

// Mock DB model (config)
jest.mock("../../src/models/configSchema", () => ({
  find: jest.fn().mockResolvedValue([
    {
      _id: "1",
      Rtsp_Link: "rtsp://dummy",
      Camera_Name: "Cam1",
      Description: "",
      Feature: "",
      Priority: "High",
      Status: "Active",
      Email_Auto_Alert: true,
      Display_Auto_Alert: true,
      Email_Alert: true,
      Display_Alert: true,
      Alerts: [],
      Active: true
    }
  ])
}));

// Mock fs
jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue("APP_ID = 123")
}));

// Required ENV variables
process.env.CAMERA_LIST = "/camera-list";
process.env.AKSHA_PATH = "/dummy";
process.env.PROTOCOL = "http";
process.env.HOST = "localhost";
process.env.PORT = "3000";

const app = express();

// IMPORTANT FIX: mount router at /api
app.use("/api", router);

describe("GET /api/camera-list", () => {
  it("should respond with status 200", async () => {
    const res = await request(app).get("/api/camera-list");

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.cameras)).toBe(true);
  });
});
