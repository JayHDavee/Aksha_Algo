import mongoose from "mongoose";
import moment from "moment";
import {
  getMetaCameras,
  getMetaCameraByName,
  getActiveCameraCount,
  isObserverInitialized,
  getCamerasWithRecentAnomalies,
} from "../../utils/observer";

describe("observer utils", () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2023-01-01T12:00:00Z"));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("should return empty array initially for getMetaCameras", () => {
    const cameras = getMetaCameras();
    expect(Array.isArray(cameras)).toBe(true);
    expect(cameras.length).toBe(0);
  });

  it("should return undefined for getMetaCameraByName if no cameras", () => {
    const camera = getMetaCameraByName("nonexistent");
    expect(camera).toBeUndefined();
  });

  it("should return 0 for getActiveCameraCount initially", () => {
    expect(getActiveCameraCount()).toBe(0);
  });

  it("should return false for isObserverInitialized initially", () => {
    expect(isObserverInitialized()).toBe(false);
  });

  it("should return empty array for getCamerasWithRecentAnomalies initially", () => {
    const cameras = getCamerasWithRecentAnomalies();
    expect(Array.isArray(cameras)).toBe(true);
    expect(cameras.length).toBe(0);
  });

});
