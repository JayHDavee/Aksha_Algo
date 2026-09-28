import React from "react";
import ErrorImg from "../../assets/images/error.png";
import { useTranslation } from "react-i18next";

// Inline styles equivalent to the removed SCSS
const styles = {
  centerFlex: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "60vh",
  } as React.CSSProperties,

  dataNotFound: {
    textAlign: "center" as const,
  } as React.CSSProperties,

  h2: {
    fontWeight: 800,
    paddingLeft: 0,
    marginTop: 16,
  } as React.CSSProperties,

  p: {
    color: "#6c7689",
  } as React.CSSProperties,

  img: {
    width: "50%",
    maxWidth: 260,
    height: "auto",
    objectFit: "contain",
    display: "block",
    margin: "0 auto",
  } as React.CSSProperties,
};



const NotFound: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div style={styles.centerFlex}>
      <div style={styles.dataNotFound}>
        <img alt="error img" src={ErrorImg} style={styles.img} />
        <h2 style={styles.h2}>{t("No alerts found")}</h2>
      </div>
    </div>
  );
};

export default NotFound;
