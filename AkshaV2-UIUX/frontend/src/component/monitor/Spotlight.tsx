/**
 * Spotlight Component
 * 
 * This component displays a grid of camera images that are marked with anomalies (e.g., frame or object anomalies).
 * The grid layout adapts responsively based on the number of images shown.
 * It listens to the `spotlightAllCamera` socket event to dynamically update the list of spotlight cameras.
 * 
 * Features:
 * - Fetches spotlight cameras from backend
 * - Displays each camera’s snapshot with name and anomaly indicator
 * - Responsive layout adjustment
 * - Clickable images that open in a modal
 */

import { useEffect, useState } from "react";
import ImageModel from "../common/ImageModel";
import { socket } from "../../router/socket";
import { useApi } from "../../hooks/useApi";
import "./styles/active.scss";

interface SpotlightProps {
  selectedGroup: string;
  cameraGroups: {
    group_name: string;
    description: string;
    priority_type: string;
    cameras: { camera_id: string; camera_name: string }[];
  }[];
}

const Spotlight = ({ selectedGroup, cameraGroups }: SpotlightProps) => {
  const { callApi } = useApi();

  const [spotLightCameras, setSpotLightCameras] = useState<any[]>([]);
  const [imageLoader, setImageLoader] = useState(false);
  const [imgUrl, setImgUrl] = useState("");

  const [largeClass, setLargeClass] = useState("col-lg-4");
  const [extraLargeClass, setExtraLargeClass] = useState("col-xl-4");
  const [mediumClass, setMediumClass] = useState("col-lg-6");

  const fetchSpotLightCameras = async () => {
    try {
      const res = await callApi(
        `${import.meta.env.VITE_BASE_URL}/api/active/getSpotlightCamera`,
        { method: "GET" }
      );
      res.data?.info && setSpotLightCameras(res.data.info);
    } catch (err) {
      console.error("Failed to fetch spotlight cameras", err);
    }
  };

  useEffect(() => {
    fetchSpotLightCameras();

    socket.on("spotlightAllCamera", (data) => {
      data.info && setSpotLightCameras(data.info);
    });

    return () => {
      socket.off("spotlightAllCamera");
    };
  }, []);

  // ⭐ FILTER based on selected group (same as Active)
const filteredSpotlight = spotLightCameras.filter((cam) => {
  if (selectedGroup === "default") return true;

  const group = cameraGroups?.find(
    (g) => g.group_name === selectedGroup
  );

  if (!group) return false;

  // Match by camera_name instead of id
  return group.cameras.some((c) => c.camera_name === cam.camera_name);
});




  // Update grid layout
  useEffect(() => {
    const count = filteredSpotlight.length;

    if (count === 1) {
      setLargeClass("col-lg-8");
      setExtraLargeClass("col-xl-8");
      setMediumClass("col-md-8");
    } else if (count === 2 || count === 3) {
      setLargeClass("col-lg-6");
      setExtraLargeClass("col-xl-6");
      setMediumClass("col-md-12");
    } else if (count <= 6) {
      setLargeClass("col-lg-4");
      setExtraLargeClass("col-xl-4");
      setMediumClass("col-md-6");
    } else {
      setLargeClass("col-lg-3");
      setExtraLargeClass("col-xl-3");
      setMediumClass("col-md-3");
    }
  }, [filteredSpotlight]);

  const openImageLoader = () => setImageLoader(true);

  return (
    <div>
      <div className="container-fluid">
        <div className="row">
          {filteredSpotlight.map((info, index) => (
            <div
              className={`${largeClass} ${extraLargeClass} ${mediumClass} col-sm-12 col-xs-12 videoContainer2 mb-3 px-2`}
              key={index}
            >
              <img
                crossOrigin="anonymous"
                src={`${info.image}?${Date.now()}`}
                className="w-100 camera-image"
                alt="camera"
                onClick={() => {
                  setImgUrl(`${info.image}?${Date.now()}`);
                  openImageLoader();
                }}
              />

              {(info.Frame_Anomaly || info.Object_Anomaly) && (
                <div className="auto-alert">Auto Alert</div>
              )}

              <div className="bottom-content" style={{ opacity: 1 }}>
                <div className="bottomTextContainer">
                  <p className="mb-0 parentText px-2" style={{ background: "#fff" }}>
                    {info.camera_name}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {imgUrl && (
        <ImageModel open={imageLoader} setOpen={setImageLoader} imgUrl={imgUrl} />
      )}
    </div>
  );
};

export default Spotlight;
