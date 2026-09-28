import request from "supertest";
import express from "express";
import router from "../../src/routes/insight";
import fs from "fs";
import axios from "axios";

// --- MOCKS ---
jest.mock("axios");
jest.mock("fs");

const app = express();
app.use(express.json());
app.use("/", router);

describe("POST /INSIGHT", () => {
  beforeEach(() => {
    process.env.INSIGHT = "/insight";
    process.env.AKSHA_PATH = "/fakePath";
    process.env.PROTOCOL = "http";
    process.env.HOST = "localhost";
    process.env.PORT = "8000";
  });

  // 1️⃣ Missing Fields
  it("should return 400 if required fields are missing", async () => {
    const res = await request(app).post("/insight").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("please provide all detail");
  });

  // 2️⃣ External API Failure
  it("should return 500 when external API fails", async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error("API Failed"));

    const res = await request(app).post("/insight").send({
      Start_Date: "2024-01-01",
      Start_Time: "10:00",
      End_Date: "2024-01-01",
      End_Time: "12:00",
      Camera_Name: "Camera1",
    });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Could not generate insight video");
  });

  // 3️⃣ File Not Found
  it("should return 400 when video file does not exist", async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });

    (fs.stat as jest.Mock).mockImplementation((p, cb) => {
      cb(new Error("File not found"), null);
    });

    const res = await request(app).post("/insight").send({
      Start_Date: "2024-01-01",
      Start_Time: "10:00",
      End_Date: "2024-01-01",
      End_Time: "12:00",
      Camera_Name: "Camera1",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Video not found.");
  });

  // 4️⃣ File Exists but Empty (video is still being generated)
  it("should return 'Video is still being formed' when file size is 0", async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });

    (fs.stat as jest.Mock).mockImplementation((p, cb) =>
      cb(null, { isFile: () => true, size: 0 })
    );

    const res = await request(app).post("/insight").send({
      Start_Date: "2024-01-01",
      Start_Time: "10:00",
      End_Date: "2024-01-01",
      End_Time: "12:00",
      Camera_Name: "Camera1",
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Video is still being formed. Please wait");
  });

  // 5️⃣ File Exists and Complete
  it("should return success and video URL when file exists", async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: {} });

    (fs.stat as jest.Mock).mockImplementation((p, cb) =>
      cb(null, { isFile: () => true, size: 500 })
    );

    const res = await request(app).post("/insight").send({
      Start_Date: "2024-01-01",
      Start_Time: "10:00",
      End_Date: "2024-01-01",
      End_Time: "12:00",
      Camera_Name: "Camera1",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.insight.image).toContain("heatmap_video_Camera1.mp4");
  });
});
