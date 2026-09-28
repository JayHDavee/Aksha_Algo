import config, { ICameraConfig } from "../../src/models/configSchema";

describe("configSchema model", () => {
  it("should create a new config document", () => {
    const configDoc: Partial<ICameraConfig> = {
      rtsp_id: 1,
      Rtsp_Link: "rtsp://example.com/stream1",
      Camera_Name: "Camera1",
      Feature: ["motion_detection"],
      FPS: 30,
      Active: true,
      Live: true,
      Surveillance_Status: "start",
      PausedTime: "null",
      Email_Auto_Alert: true,
      Display_Auto_Alert: true,
      Email_Alert: true,
      Display_Alert: true,
      Alerts: [],
    };
    const doc = new config(configDoc);
    expect(doc).toBeInstanceOf(config);
    expect(doc.Camera_Name).toBe("Camera1");
  });
});
