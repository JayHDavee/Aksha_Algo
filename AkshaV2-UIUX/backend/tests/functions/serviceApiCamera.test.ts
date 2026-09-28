import axios from "axios";
import Alerts from "../../src/models/myAlertSchema";
import { serviceApiStartCamera } from "../../src/functions/serviceApiCamera";

jest.mock("axios");
jest.mock("../../src/models/myAlertSchema");

describe("serviceApiCamera functions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should call API with correct params for start", async () => {
    (Alerts.find as jest.Mock).mockResolvedValue([
      { Alert_Name: "Alert1" },
      { Alert_Name: "Alert2" },
    ]);
    (axios.post as jest.Mock).mockResolvedValue({ data: "success" });

    const cameraDetails = {
      rtsp_id: 1,
      rtsp_link: "rtsp://link",
      camera_name: "Camera1",
      prev_camera_name: "OldCamera1",
      priority: "High",
      email_auto_alert: true,
      display_auto_alert: true,
      email_alert: true,
      display_alert: true,
    };

    const result = await serviceApiStartCamera(cameraDetails, false);

    expect(Alerts.find).toHaveBeenCalledWith({
      Camera_Name: { $in: [cameraDetails.camera_name] },
    });
    expect(axios.post).toHaveBeenCalledWith(
      "http://API_SERVICE:4000/Surveillance",
      expect.objectContaining({
        type: "start",
        camera_list: expect.any(Array),
      }),
      expect.any(Object)
    );
    expect(result).toBe("success");
  });

  it("should call API with correct params for restart", async () => {
    (Alerts.find as jest.Mock).mockResolvedValue([]);
    (axios.post as jest.Mock).mockResolvedValue({ data: "restarted" });

    const cameraDetails = {
      rtsp_id: 2,
      rtsp_link: "rtsp://link2",
      camera_name: "Camera2",
      prev_camera_name: "OldCamera2",
      priority: "Low",
      email_auto_alert: false,
      display_auto_alert: false,
      email_alert: false,
      display_alert: false,
    };

    const result = await serviceApiStartCamera(cameraDetails, true);

    expect(Alerts.find).toHaveBeenCalledWith({
      Camera_Name: { $in: [cameraDetails.camera_name] },
    });
    expect(axios.post).toHaveBeenCalledWith(
      "http://API_SERVICE:4000/Surveillance",
      expect.objectContaining({
        type: "restart",
        camera_list: expect.any(Array),
      }),
      expect.any(Object)
    );
    expect(result).toBe("restarted");
  });
});
