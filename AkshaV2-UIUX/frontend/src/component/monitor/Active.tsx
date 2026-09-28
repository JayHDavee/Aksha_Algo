import { useEffect, useState } from "react";
import { Button } from "@mui/material";
import Camera from "./Camera";
import Menu from "../video_menu/MenuOverlay";
import { socket } from "../../router/socket";
import onPauseIcon from "../../assets/images/icons/pause.png";
import onPlayIcon from "../../assets/images/icons/play.png";
import "./styles/active.scss";
import Messagebox from "../common/Messagebox";
import { useApi } from "../../hooks/useApi";
import { useTranslation } from "react-i18next";

// Camera data type definition
interface CameraDetailType {
  _id: string;
  Rtsp_Link: string;
  Camera_Name: string;
  Description: string;
  Feature: string[];
  Priority: string;
  Status: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  Active: boolean;
  FPS: number;
  Live: boolean;
  Surveillance_Status: string;
  PausedImage: any;
  image: string;
}

// Props from ColorTabs
interface ActiveProps {
  selectedGroup: string;
  cameraGroups: {
    group_name: string;
    description: string;
    priority_type: string;
    cameras: { camera_id: string; camera_name: string }[];
  }[];
}

const Active = ({ selectedGroup, cameraGroups }: ActiveProps) => {
  const [cameraDetails, setCameraDetails] = useState<CameraDetailType[]>([]);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState(true);
  const [showFunctionDropdown, setShowFunctionDropdown] = useState(false);
  const { callApi } = useApi();
  const { t } = useTranslation();

  // Fetch initial camera data
  const fetchLiveCamera = async () => {
    try {
      const res = await callApi(
        `${import.meta.env.VITE_BASE_URL}/api/active/getLiveCamera`,
        { method: "GET" }
      );
      if (res.data.info) setCameraDetails(res.data.info);
    } catch (error) {
      console.error("Error fetching live camera data:", error);
    }
  };

  useEffect(() => {
    fetchLiveCamera();

    const handleLiveAllCamera = (data: { info: CameraDetailType[] }) => {
      if (data.info) setCameraDetails(data.info);
    };

    socket.on("liveAllCamera", handleLiveAllCamera);

    return () => {
      socket.off("liveAllCamera", handleLiveAllCamera);
    };
  }, []);

  // Filter cameras based on selected group
  const filteredCameras = cameraDetails.filter((cam) => {
    if (selectedGroup === "default") return true;

    const group = cameraGroups?.find((g) => g.group_name === selectedGroup);
    if (!group || !group.cameras) return false;

    return group.cameras.some((c) => c.camera_id.toString() === cam._id.toString());
  });

  const allActiveCameras = filteredCameras.filter((cam) => cam.Active);
  const stoppedCameras = filteredCameras
    .filter((cam) => !cam.Live)
    .map((cam) => cam.Camera_Name);

  const handleClose = () => setOpen(false);

  const toggleLive = async (param: boolean, Camera_Name: string) => {
    const url = `${import.meta.env.VITE_BASE_URL}/api/enableCamera?Live=${param}&Camera_Name=${Camera_Name}`;
    try {
      await callApi(url, { method: "GET" });
      const toggle_message = param ? t("Resumed") : t("Paused");
      setMessage(`${t("Camera")} '${Camera_Name}' ${toggle_message} ${t("successfully")}.`);
      setWarning(false);
      setOpen(true);

      const updated = cameraDetails.map((cam) =>
        cam.Camera_Name === Camera_Name ? { ...cam, Live: param } : cam
      );
      setCameraDetails(updated);
    } catch (err) {
      console.error("Toggle live failed:", err);
    }
  };

  const getContainerStopCamName = (info: CameraDetailType): string => {
    const isStopped = stoppedCameras.includes(info.Camera_Name);
    return info.Surveillance_Status === "stop" || isStopped
      ? "bottom-content2"
      : "bottom-content";
  };

  const checkmouseout = () => setShowFunctionDropdown(false);

  return (
    <div>
      <Messagebox
        open={open}
        handleClose={handleClose}
        message={message}
        warning={warning}
      />
      <div className="container-fluid">
        <div
          className={`camera-grid ${allActiveCameras.length === 1 ? "single-camera" : ""
            }`}
        >
          {allActiveCameras.map((info) => (
            <div
              id={info.Camera_Name}
              className="videoContainer2 mb-3 px-2"
              key={info._id}
              onMouseLeave={checkmouseout}
            >
              <Camera
                key={info._id}
                camera={info.Camera_Name}
                surveillance_status={info.Surveillance_Status}
                liveStatus={info.Live}
                socket={socket}
                defaultImage={info.image}
              />
              <div className="flex-end">
                <Menu
                  info={info}
                  setMessage={setMessage}
                  setOpen={setOpen}
                  setShowFunctionDropdown={setShowFunctionDropdown}
                  showFunctionDropdown={showFunctionDropdown}
                />
              </div>
              <div className={getContainerStopCamName(info)}>
                <div className="bottomTextContainer">
                  <p className="mb-0 parentText">
                    {info.Camera_Name}
                  </p>
                </div>
              </div>
              <div className={stoppedCameras.includes(info.Camera_Name) ? "middle2" : "middle1"}>
                {info.Live ? (
                  <Button onClick={() => toggleLive(false, info.Camera_Name)}>
                    <img src={onPlayIcon} alt="pause video" />
                  </Button>
                ) : (
                  <Button onClick={() => toggleLive(true, info.Camera_Name)}>
                    <img src={onPauseIcon} alt="play video" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Active;
