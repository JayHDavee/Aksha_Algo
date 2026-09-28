import axios from "axios";
import Alerts from "../models/myAlertSchema";

const FPS_HIGH    = 5;
const FPS_DEFAULT = 3;
const FPS_MIN     = 1;

interface CameraDetails {
  rtsp_id: string | number;
  rtsp_link: string;
  camera_name: string;
  prev_camera_name: string;
  priority?: string;
  email_auto_alert?: boolean;
  display_auto_alert?: boolean;
  email_alert?: boolean;
  display_alert?: boolean;
  // Omitted (undefined) for "standard" cameras so the Python controller's own
  // default (deepstream_nvinfer/deepstream_batch) applies unchanged — only
  // set for "ppe" | "jewelry".
  deployment_mode?: string;
}

/**
 * Starts a camera service based on the provided camera details.
 *
 * @async
 * @function serviceStartCamera
 * @param {CameraDetails} cameraDetails - An object containing camera configuration details.
 * @param {boolean} [restart=false] - If true, the camera service will be restarted.
 * @returns {Promise<any>} Response from the camera service API
 * @throws {Error} If the camera service fails to start.
 */
export const serviceApiStartCamera = async (cameraDetails: CameraDetails, restart: boolean = false): Promise<any> => {
  const {
    rtsp_id,
    rtsp_link,
    camera_name,
    prev_camera_name,
    priority,
    email_auto_alert,
    display_auto_alert,
    email_alert,
    display_alert,
    deployment_mode,
  } = cameraDetails;

  // Get all existing Alerts for camera
  const alerts = (await Alerts.find({
    Camera_Name: { $in: [camera_name] }, // find alerts for the given camera
  })).map((alert) => alert.Alert_Name); //get only Alert_Name from alerts

  // Calculate FPS based on priority
  let FPS = FPS_DEFAULT;
  if (priority === 'Low') {
    FPS = FPS_MIN;
  } else if (priority === 'High') {
    FPS = FPS_HIGH;
  } else {
    FPS = FPS_DEFAULT;
  }

  let params = {
    //params sent to database, here camera_list is an array
    camera_list: [
      {
        camera_name: camera_name,
        update_camera_name: camera_name,
        rtsp_id: rtsp_id,
        rtsp_link: rtsp_link,
        alerts: alerts, //list of alerts for camera_name
        fps: FPS,
        email_auto_alert: email_auto_alert,
        display_auto_alert: display_auto_alert,
        email_alert: email_alert,
        display_alert: display_alert,
        ...(deployment_mode ? { deployment_mode } : {}),
      },
    ],
    type: restart ? "restart" : "start", //if already present camera in mongodb then 'restart' else  'start'
  };

  // If type restart then add prev_camera_name
  if (restart) {
    params.camera_list[0].update_camera_name = camera_name; //add _ to empty space in camera_name  state
    params.camera_list[0].camera_name = prev_camera_name;
  }

  const { data: serviceRes } = await axios.post(
    `http://API_SERVICE:4000/Surveillance`,
    params,
    {
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
      },
      timeout: 70000,
    }
  );
  console.log("serviceApi res", serviceRes); //response from service_api
  return serviceRes;
};
