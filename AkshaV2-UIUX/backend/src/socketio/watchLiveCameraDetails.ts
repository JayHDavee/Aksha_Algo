import config from "../models/configSchema";
import { listLiveCamera } from "../functions/camera";
import { Socket } from "socket.io";

/**
 * Watches MongoDB config collection for changes and emits live camera details via socket.
 * @param socket Socket.IO socket instance
 */
const watchLiveCameraDetails = async (socket: Socket): Promise<void> => {
  // Mongo watch for any changes in camera config
  const changeStream = config.watch();


  // On camera config change, emit the live camera details

  changeStream.on("change", async () => {
    console.log("Mongo Camera Collection Changed");
    const cameraDetail = await listLiveCamera();
    
    socket.emit("liveAllCamera", {
      success: true,
      message: "Update in camera config collection",
      info: cameraDetail,
    });
  });
};

export default watchLiveCameraDetails;
