import React from "react";

interface ModalProps {
  isOpen: boolean;
  imageSrc: string;
  onClose: () => void;
}

const ImageModal: React.FC<ModalProps> = ({ isOpen, imageSrc, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: "rgba(0,0,0,0.5)", // dim background, or use "transparent"
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          maxWidth: "80%",
          maxHeight: "80%",
        }}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "-20px",
            right: "-20px",
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            fontSize: "20px",
            fontWeight: "bold",
            backgroundColor: "white",
            color: "black",
            border: "1px solid #ccc",
            cursor: "pointer",
            zIndex: 10000,
          }}
        >
          ×
        </button>

        {/* Image */}
        <img
          src={imageSrc}
          alt="Zoomed"
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            borderRadius: "8px",
            display: "block",
          }}
        />
      </div>
    </div>
  );
};

export default ImageModal;
