import React, { useState } from "react";
import ReactDOMServer from "react-dom/server";

interface CanvasFramesProps {
  data: {
    base_url: string;
    Results: string;
  };
  aIPolygen: string;
}

/**
 * CanvasFrames Component
 * 
 * Renders an image with SVG overlays for results and AI polygon.
 * Encodes SVG to data URL for use as image source.
 */
const CanvasFrames: React.FC<CanvasFramesProps> = ({ data, aIPolygen }) => {
  const [list, setList] = useState<any[]>([]);

  // Encode SVG React element to data URL string
  const encodeSvg = (reactElement: React.ReactElement): string => {
    return (
      "data:image/svg+xml," +
      escape(ReactDOMServer.renderToStaticMarkup(reactElement))
    );
  };

  // Generate image element with SVG overlays
  const getImage = (data: CanvasFramesProps["data"]) => {
    const image = (
      <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
        <image href={data.base_url} width="100%" />
        <polygon
          points={data.Results}
          style={{ fill: "transparent", stroke: "blue", strokeWidth: 4 }}
        />
        <polygon
          points={aIPolygen}
          style={{ fill: "transparent", stroke: "yellow", strokeWidth: 4 }}
        />
      </svg>
    );

    return (
      <img
        src={encodeSvg(image)}
        style={{
          width: "100%",
          borderRadius: "12px",
        }}
        alt="Canvas Frame"
      />
    );
  };

  return <div>{getImage(data)}</div>;
};

export default CanvasFrames;
