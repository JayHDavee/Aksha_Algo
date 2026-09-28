import { FSWatcher } from "fs";
import watchSpotlightCameraDetails from "../../src/socketio/watchSpotlightCamera";
import config from "../../src/models/configSchema";
import { listSpotlightCameras } from "../../src/functions/camera";
import * as fs from "fs";

// Mock socket
const mockSocket = {
  emit: jest.fn(),
} as any;

// Mock fs functions
jest.mock("fs", () => ({
  watch: jest.fn(() => ({
    close: jest.fn(),
  })) as any,
  existsSync: jest.fn(),
}));

// Mock config model
jest.mock("../../src/models/configSchema", () => ({
  find: jest.fn(),
  watch: jest.fn(),
}));

// Mock listSpotlightCameras function
jest.mock("../../src/functions/camera", () => ({
  listSpotlightCameras: jest.fn(),
}));

describe("watchSpotlightCameraDetails", () => {
  let watchList: FSWatcher[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    watchList = [];
  });

  it("should set up watchers for cameras when spotlight folders exist", async () => {
    (config.find as jest.Mock).mockResolvedValue([
      { Camera_Name: "Camera1" },
      { Camera_Name: "Camera2" },
    ]);

    (fs.existsSync as jest.Mock).mockReturnValue(true);

    (listSpotlightCameras as jest.Mock).mockResolvedValue([
      { camera: "Camera1", image: "img1.jpg" },
    ]);

    const mockChangeStream = { on: jest.fn() };
    (config.watch as jest.Mock).mockReturnValue(mockChangeStream);

    await watchSpotlightCameraDetails(mockSocket);

    expect(fs.watch).toHaveBeenCalledTimes(2);
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(mockChangeStream.on).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("should retry until folder exists", async () => {
    jest.useFakeTimers();
    (config.find as jest.Mock).mockResolvedValue([{ Camera_Name: "CameraRetry" }]);

    // first two calls: folder doesn't exist, third call exists
    let callCount = 0;
    (fs.existsSync as jest.Mock).mockImplementation(() => {
      callCount++;
      return callCount >= 3;
    });

    const watchSpy = jest.spyOn(fs, "watch").mockImplementation(() => ({
      close: jest.fn(),
    } as any));

    const promise = watchSpotlightCameraDetails(mockSocket);

    // simulate 3 retries of 5s each
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    await promise;

    expect(watchSpy).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
