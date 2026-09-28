import fs from "fs";
import path from "path";
import moment from "moment";
import * as cameraFunctions from "../../src/functions/camera";
import config from "../../src/models/configSchema";

jest.mock("fs");
jest.mock("../../src/models/configSchema");

describe("camera functions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("listLiveCamera", () => {
    it("should return enriched camera data", async () => {
      const mockCameraData = [
        {
          _id: "1",
          rtsp_id: 1,
          Rtsp_Link: "rtsp://link",
          Camera_Name: "Camera1",
          Description: "desc",
          Feature: ["feature1"],
          Priority: "High",
          Status: "Active",
          Email_Auto_Alert: true,
          Display_Auto_Alert: true,
          Active: true,
          FPS: 30,
          Live: true,
          Surveillance_Status: "start",
          PausedTime: null,
        },
      ];
      (config.find as jest.Mock).mockResolvedValue(mockCameraData);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ workday: "true" }));
      (fs.existsSync as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes("workday.jpg")) return true;
        if (filePath.includes("stop.jpg")) return true;
        return false;
      });

      const result = await cameraFunctions.listLiveCamera();
      expect(result).toHaveLength(1);
      expect(result[0].image).toContain("workday.jpg");
    });
  });

  describe("listSpotlightCameras", () => {
    it("should return spotlight cameras with images", async () => {
      const mockCameraData = [
        { Camera_Name: "Camera1" },
        { Camera_Name: "Camera2" },
      ];
      (config.find as jest.Mock).mockResolvedValue(mockCameraData);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ workday: "true" }));
      (fs.existsSync as jest.Mock).mockImplementation((filePath) => {
        if (filePath.includes("workday.jpg")) return true;
        return false;
      });

      const result = await cameraFunctions.listSpotlightCameras();
      expect(result).toHaveLength(2);
      expect(result[0].image).toContain("workday.jpg");
    });
  });
});
