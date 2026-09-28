/**
 * @file index.test.ts
 */

import { jest } from "@jest/globals";

describe("Server index.ts", () => {
  let oldEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Backup process.env
    oldEnv = { ...process.env };
    jest.resetModules(); // Clear module cache
  });

  afterEach(() => {
    process.env = oldEnv;
  });

  it("should initialize server and setup socket connection", async () => {
    process.env.PORT = "3000";

    const mockSocket = {
      id: "socket123",
      on: jest.fn(),
    } as any;

    const watchLiveCameraDetails = jest.fn();
    const watchSpotlightCameraDetails = jest.fn();

    // Mock socket watcher modules
    jest.doMock("../../src/socketio/watchLiveCameraDetails", () => ({
      __esModule: true,
      default: watchLiveCameraDetails,
    }));
    jest.doMock("../../src/socketio/watchSpotlightCamera", () => ({
      __esModule: true,
      default: watchSpotlightCameraDetails,
    }));

    // Import after mocks
    const indexModule = await import("../../src/index");

    // Access the socket handler
    const handleSocketConnection = indexModule.handleSocketConnection;

    // Call socket handler
    await handleSocketConnection(mockSocket);

    // Watchers should be called
    expect(watchLiveCameraDetails).toHaveBeenCalledWith(mockSocket);
    expect(watchSpotlightCameraDetails).toHaveBeenCalledWith(mockSocket);

    // Disconnect listener registered
    expect(mockSocket.on).toHaveBeenCalledWith("disconnect", expect.any(Function));
  });

  it("should exit if PORT is not defined", () => {
    delete process.env.PORT;

    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as any);

    expect(() => {
      jest.isolateModules(() => {
        require("../../src/index"); // import after spy
      });
    }).toThrow("process.exit: 1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
