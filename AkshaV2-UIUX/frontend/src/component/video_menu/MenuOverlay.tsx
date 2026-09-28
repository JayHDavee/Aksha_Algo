import React, { useEffect, useState } from "react";
import Tooltip from "@mui/material/Tooltip";
import axios from "axios";

import Alerts from "../common/customAlertModal/Alerts";

import "./video_menu.scss";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

// =======================
// Component Props Typing
// =======================
interface CameraInfo {
  Camera_Name: string;
  Rtsp_Link: string;
  Surveillance_Status: string;
  FPS: number;
  Priority?: string;
}

interface MenuOverlayProps {
  info: CameraInfo;
  showFunctionDropdown: boolean;
  setShowFunctionDropdown: (val: boolean) => void;
  setMessage: (msg: string) => void;
  setOpen: (val: boolean) => void;
}

// ===================
// Main Component
// ===================
export default function MenuOverlay({
  info,
  showFunctionDropdown,
  setShowFunctionDropdown,
  setMessage,
  setOpen,
}: MenuOverlayProps) {
  const [cameraAlerts, setCameraAlerts] = useState<{ Alert_Name: string }[]>([]);

  // Fetch this camera's configured alerts for the info tooltip.
  useEffect(() => {
    if (!info.Camera_Name) return;
    const url = `${VITE_base_url}${import.meta.env.VITE_ALERT}${info.Camera_Name}`;
    axios
      .get(url)
      .then((res) => {
        if (res.data?.success && Array.isArray(res.data.alerts)) {
          setCameraAlerts(res.data.alerts);
        }
      })
      .catch(() => setCameraAlerts([]));
  }, [info.Camera_Name]);

  // Stop camera request
  const stop = () => {
    setShowFunctionDropdown(false);
    const url = `${import.meta.env.VITE_BASE_URL}/api/SurveillanceStatus?Surveillance_Status=stop&Camera_Name=${info.Camera_Name}`;
    axios.get(url)
      .then(() => {
        setMessage(`Camera "${info.Camera_Name}" is stopped successfully.`);
        setOpen(true);
      })
      .catch(console.error);
  };

  // Start camera request
  const start = () => {
    setShowFunctionDropdown(false);
    const url = `${import.meta.env.VITE_BASE_URL}/api/SurveillanceStatus?Surveillance_Status=start&Camera_Name=${info.Camera_Name}`;
    axios.get(url)
      .then(() => {
        setMessage(`Camera "${info.Camera_Name}" is started successfully.`);
        setOpen(true);
      })
      .catch(console.error);
  };

  // ===================
  // Render UI
  // ===================
  const alertNames = cameraAlerts.map((a) => a.Alert_Name);

  return (
    <div className="video_menu">
      <div className="camera-tile-actions">
        {localStorage.getItem("isLoggedIn") === "true" && (
          <Alerts
            calledInsideMenu={true}
            camera_name={info.Camera_Name}
            camera_link={info.Rtsp_Link}
            fps={info.FPS}
            setMessage={setMessage}
            setOpen={setOpen}
          />
        )}

        <Tooltip
          title={
            <>
              <div>Priority: {info.Priority || "Not set"}</div>
              <div>
                Alerts set:{" "}
                {alertNames.length > 0 ? alertNames.join(", ") : "None"}
              </div>
            </>
          }
          arrow
        >
          <button type="button" className="camera-info-btn">
            <i className="bx bx-info-circle"></i>
          </button>
        </Tooltip>

        {localStorage.getItem("isLoggedIn") === "true" && (
          info.Surveillance_Status === "start" ? (
            <Tooltip title="Stop surveillance">
              <button type="button" className="camera-stop-btn" onClick={stop}>
                <i className="bx bx-stop-circle"></i>
              </button>
            </Tooltip>
          ) : (
            <Tooltip title="Start surveillance">
              <button type="button" className="camera-start-btn" onClick={start}>
                <i className="bx bx-play-circle"></i>
              </button>
            </Tooltip>
          )
        )}

      </div>
    </div>
  );
}
