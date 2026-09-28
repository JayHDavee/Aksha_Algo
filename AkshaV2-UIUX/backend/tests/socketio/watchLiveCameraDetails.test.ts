import watchLiveCameraDetails from "../../src/socketio/watchLiveCameraDetails";
import config from "../../src/models/configSchema";
import * as cameraFunctions from "../../src/functions/camera";
import { Socket } from "socket.io";

jest.mock("../../src/models/configSchema");
jest.mock("../../src/functions/camera");

describe("watchLiveCameraDetails", () => {
  it("should emit liveAllCamera event on config change", async () => {
    const mockSocket: Partial<Socket> = {
      emit: jest.fn(),
    };

    const mockChangeStream = {
      on: jest.fn((event, callback) => {
        if (event === "change") {
          callback();
        }
      }),
    };

    (config.watch as jest.Mock).mockReturnValue(mockChangeStream);
    (cameraFunctions.listLiveCamera as jest.Mock).mockResolvedValue([
      { Camera_Name: "Camera1" },
    ]);

    await watchLiveCameraDetails(mockSocket as Socket);

    expect(config.watch).toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith("liveAllCamera", {
      success: true,
      message: "Update in camera config collection",
      info: [{ Camera_Name: "Camera1" }],
    });
  });
});
