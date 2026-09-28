import { existsSync, watch, FSWatcher } from "fs";
import * as path from 'path';

import config from "../models/configSchema";
import { listSpotlightCameras } from "../functions/camera";
import { Socket } from "socket.io";

/**
 * Watches spotlight folders for all cameras and emits updates via socket.
 * @param socket Socket.IO socket instance
 * @param watchList Array of FSWatcher instances to manage watchers
 */
const watchSpotlightFolder = async (socket: Socket, watchList: FSWatcher[]): Promise<void> => {
  // Get all cameras from config
  const cameraDetail = await config.find();

  // Clear all existing watchers
  watchList.forEach((watcher) => watcher.close());
  watchList.length = 0;

  // For each camera, watch the spotlight folder
  for (const { Camera_Name: cameraName } of cameraDetail) {
    // Construct spotlight folder path
    const spotlightFolder = path.join(`${process.env.AKSHA_PATH}/${cameraName}/spotlight`);


    // Wait until spotlight folder exists, retry every 5 seconds
    while (!existsSync(spotlightFolder)) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Watch spotlight folder for changes
    const fileWatcher = watch(
      spotlightFolder,
      { persistent: true },
      async (evt, name) => {
        const cameraDetail = await listSpotlightCameras();
      

        socket.emit("spotlightAllCamera", {
          success: true,
          message: "Update in spotlight",
          info: cameraDetail,
        });
      }
    );

  
    // Add watcher to watchList
    watchList.push(fileWatcher);
  }
};

/**
 * Watches spotlight camera details and MongoDB config changes to update watchers.
 * @param socket Socket.IO socket instance
 */
const watchSpotlightCameraDetails = async (socket: Socket): Promise<void> => {
  // List of active file watchers
  const watchList: FSWatcher[] = [];

  // Start initial file watchers
  await watchSpotlightFolder(socket, watchList);

  // Watch MongoDB config collection for changes
  const changeStream = config.watch();

  // On config change, restart watchers
  changeStream.on("change", async () => {
    await watchSpotlightFolder(socket, watchList);
  });
};

export default watchSpotlightCameraDetails;
