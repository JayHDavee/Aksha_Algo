import request from "supertest";
import express from "express";

// Import the router (fix the path according to your project)
import activeCamera from "../../src/routes/activeCamera";

// Mock camera functions
import { listLiveCamera, listSpotlightCameras } from "../../src/functions/camera";

jest.mock("../../src/functions/camera");

const app = express();
app.use("/api/active", activeCamera);

describe("Active Camera Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ------------------------------
  // TEST: GET /getLiveCamera
  // ------------------------------
  it("GET /api/active/getLiveCamera → returns live camera details", async () => {
    (listLiveCamera as jest.Mock).mockResolvedValue([
      { Camera_Name: "Cam1", Status: "Online" },
    ]);

    const res = await request(app).get("/api/active/getLiveCamera");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.info)).toBe(true);
    expect(res.body.info.length).toBe(1);
  });

  it("GET /api/active/getLiveCamera → returns 500 on error", async () => {
    (listLiveCamera as jest.Mock).mockRejectedValue(new Error("DB error"));

    const res = await request(app).get("/api/active/getLiveCamera");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Failed to retrieve live camera details");
  });

  // ------------------------------
  // TEST: GET /getSpotlightCamera
  // ------------------------------
  it("GET /api/active/getSpotlightCamera → returns spotlight camera details", async () => {
    (listSpotlightCameras as jest.Mock).mockResolvedValue([
      { Camera_Name: "Cam1", Image: "img.jpg" },
    ]);

    const res = await request(app).get("/api/active/getSpotlightCamera");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.info)).toBe(true);
    expect(res.body.info.length).toBe(1);
  });

  it("GET /api/active/getSpotlightCamera → returns 500 on error", async () => {
    (listSpotlightCameras as jest.Mock).mockRejectedValue(
      new Error("Spotlight error")
    );

    const res = await request(app).get("/api/active/getSpotlightCamera");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Failed to retrieve spotlight camera details");
  });
});
