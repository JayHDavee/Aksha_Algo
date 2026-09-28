import request from "supertest";
import express from "express";

// FIX: Set env BEFORE importing router
process.env.CAMERA_NAMES = "/api/camera-names";

jest.mock("../../src/models/configSchema", () => ({
  find: jest.fn().mockResolvedValue([
    {
      _id: "1",
      Camera_Name: "Cam1",
      Rtsp_Link: "rtsp://sample",
      Status: "Active"
    }
  ])
}));

const router = require("../../src/routes/investigation").default;

const app = express();
app.use("/", router);

describe("GET /api/camera-names", () => {
  it("should return 200 and list cameras", async () => {
    const res = await request(app).get("/api/camera-names");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.cameras)).toBe(true);
    expect(res.body.cameras.length).toBe(1);
  });
});
