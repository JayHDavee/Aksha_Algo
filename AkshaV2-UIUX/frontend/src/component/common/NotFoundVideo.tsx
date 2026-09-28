import React from "react";
import NotFound from "../../assets/images/not_found_video.gif";

// Inline styles object
const styles = {
  centerFlex: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    margin: "10vh 15vh",
  } as React.CSSProperties,

  dataNotFound: {
    textAlign: "center" as const,
    position: "relative" as const,
    top: "40%",
    zIndex: -1,
  } as React.CSSProperties,

  h2: {
    fontWeight: 800,
    paddingLeft: "50px",
  } as React.CSSProperties,

  p: {
    color: "#6c7689",
  } as React.CSSProperties,

  img: {
    width: "60%",
    height: "130px", // adjust as needed
    objectFit: "contain",
  } as React.CSSProperties,
};


const NotFoundVideo: React.FC = () => {
  return (
    <div style={styles.centerFlex}>
      <div style={styles.dataNotFound}>
        <img alt="not found" src={NotFound} style={styles.img} />
        <h2 style={styles.h2}>No frames found</h2>
      </div>
    </div>
  );
};

export default NotFoundVideo;
