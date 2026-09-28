import request from "supertest";
import express from "express";
import multer from "multer";

// MUST set before import
process.env.AKSHA_PATH = "/dummy";

jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue(JSON.stringify({ workday: "true" }))
}));

const router = require("../../src/routes/monitor").default;

const app = express();

// Mock io object

app.use((req, res, next) => {
  req.io = { emit: jest.fn() };
  next();
});

// Use router
app.use("/", router);

describe("POST /monitor", () => {
  it("should return 200 and publish image", async () => {
    const res = await request(app)
      .post("/monitor")
      .field("camera_name", "TestCamera")
      .field("camera_img_url", "http://example.com/img.jpg")
      .field("image_type", "workday")
      .field("timestamp", "2025-01-01T10:00:00Z")
      .attach("image", Buffer.from("test-image"), "image.jpg");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("TestCamera");
  });
});
