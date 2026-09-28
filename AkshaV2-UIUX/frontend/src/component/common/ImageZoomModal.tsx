import React from "react";
import ReactDOM from "react-dom";

interface ImageZoomModalProps {
  isOpen: boolean;
  imageSrc: string | null;
  onClose: () => void;
}

const ImageZoomModal: React.FC<ImageZoomModalProps> = ({
  isOpen,
  imageSrc,
  onClose,
}) => {
  if (!isOpen || !imageSrc) return null;

  return ReactDOM.createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "10px",
        zIndex: 999999999,
      }}
    >
      <div
        onClick={(e: React.MouseEvent<HTMLDivElement>) =>
          e.stopPropagation()
        }
        style={{
          position: "relative",
          width: "90%",
          maxWidth: "900px",
          height: "85vh",
          maxHeight: "85vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          borderRadius: "12px",
          overflow: "hidden",
          opacity: 1,
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            fontSize: "22px",
            fontWeight: "bold",
            backgroundColor: "white",
            color: "black",
            border: "none",
            cursor: "pointer",
            zIndex: 10,
          }}
          aria-label="Close image"
        >
          ×
        </button>

        {/* IMAGE */}
        <img
          src={imageSrc}
          alt="Zoomed"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            borderRadius: "12px",
          }}
        />
      </div>
    </div>,
    document.body
  );
};

export default ImageZoomModal;
