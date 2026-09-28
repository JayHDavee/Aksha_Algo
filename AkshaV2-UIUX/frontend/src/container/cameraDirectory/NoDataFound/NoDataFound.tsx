import React from "react";
import noDataFound from "../../../assets/images/noDataFound.png";
import "./nodatafound.scss";

// Props interface
interface NoDataFoundProps {
  pageType?: string;
}

/**
 * NoDataFound Component
 * Displays an empty state message with optional variation based on pageType
 */
const NoDataFound: React.FC<NoDataFoundProps> = ({ pageType }) => {
  return (
    <div className="no-data-found">
      <img
        src={noDataFound}
        alt="No data found"
        className="no-data-img"
      />

      <div className="textAlign">
        {!pageType ? (
          <>
            <h3>Oops! No alerts added</h3>
            <span>Alerts created for cameras will appear here</span>
          </>
        ) : (
          <h3>You can add alerts after saving the camera</h3>
        )}
      </div>
    </div>
  );
};

export default NoDataFound;
