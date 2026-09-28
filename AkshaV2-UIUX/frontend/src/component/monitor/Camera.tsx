import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import "./styles/active.scss";

interface CameraProps {
  camera: string;
  surveillance_status: string;
  liveStatus: boolean;
  socket: Socket;
  defaultImage: string;
}

const Camera: React.FC<CameraProps> = ({
  camera,
  surveillance_status,
  liveStatus,
  socket,
  defaultImage,
}) => {
  const [imageUrl, setImageUrl] = useState<string>(defaultImage);
  const [loading, setLoading] = useState(true);
  const previousUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!liveStatus) return;

    const handleFrame = (data: { image: ArrayBuffer; type: string }) => {
      if (!data?.image) return;

      const blob = new Blob([data.image], { type: data.type });
      const newUrl = URL.createObjectURL(blob);

      if (previousUrlRef.current) {
        URL.revokeObjectURL(previousUrlRef.current);
      }

      previousUrlRef.current = newUrl;
      setImageUrl(newUrl);

      if (loading) setLoading(false);
    };

    socket.on(camera, handleFrame);

    return () => {
      socket.off(camera, handleFrame);
      if (previousUrlRef.current) {
        URL.revokeObjectURL(previousUrlRef.current);
      }
    };
  }, [camera, socket, liveStatus]);

  return (
    <div
      className={
        surveillance_status === "stop"
          ? "camera-wrapper black-cam-image"
          : "camera-wrapper camera-image"
      }
    >
      {/* Real camera image */}
      <img
        src={
          surveillance_status === "stop"
            ? "/assets/img/blackBackImg.jpg"
            : imageUrl
        }
        alt="camera img"
      />

      {/* Loader overlay */}
      {loading && surveillance_status !== "stop" && (
        <div className="camera-loader" />
      )}
    </div>
  );
};

export default Camera;