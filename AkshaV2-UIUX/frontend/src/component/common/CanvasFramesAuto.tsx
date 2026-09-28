import React, { useState } from "react";
import ReactDOMServer from "react-dom/server";

interface CanvasFramesAutoProps {
  data: {
    base_url: string;
    Results: string;
  };
  aIPolygen: string;
}

/**
 * CanvasFramesAuto Component
 * 
 * Renders an image with SVG overlays for results and AI polygon.
 * Encodes SVG to data URL for use as image source.
 */
const CanvasFramesAuto: React.FC<CanvasFramesAutoProps> = ({ data, aIPolygen }) => {
  const [list, setList] = useState<any[]>([]);

  // Encode SVG React element to data URL string
  const encodeSvg = (reactElement: React.ReactElement): string => {
    return (
      "data:image/svg+xml," +
      escape(ReactDOMServer.renderToStaticMarkup(reactElement))
    );
  };

  // Generate image element with SVG overlays
  const getImage = (data: CanvasFramesAutoProps["data"]) => {
    const image = (
      <svg height="100%" xmlns="http://www.w3.org/2000/svg" style={{ maxWidth: 640 }}>
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
        style={{ width: "100%", borderRadius: 3 }}
        alt="Canvas Frames Auto"
      />
    );
  };

  return <div>{getImage(data)}</div>;
};


// Export the CanvasFramesAuto component as the default export of this module
export default CanvasFramesAuto;