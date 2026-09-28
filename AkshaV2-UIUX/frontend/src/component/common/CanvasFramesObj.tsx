import React, { useState, useRef } from "react";
import ReactDOMServer from "react-dom/server";
import ImageModel from "./ImageModel";
import ChatPopover from "../investigation/ChatPopover/ChatPopover";
import axiosJWT from "../../context/axiosAuthIntercept";

interface ResultsItem {
  x: [number, number];
  y: [number, number];
  w: [number, number];
  h: [number, number];
  label: string;
}

interface DataProps {
  base_url: string;
  Results: ResultsItem[];
}

interface CanvasFramesObjProps {
  data: any;
  aIPolygen: string;
}

/**
 * CanvasFramesObj Component
 * 
 * Creates an image with polygons of area of interest (yellow) and polygons of object of interest (blue).
 * Supports showing image modal and AI features check.
 */
const ImageBox: React.FC<CanvasFramesObjProps> = ({ data, aIPolygen }) => {
  const [open, setOpen] = useState(false);
  const onOpenModal = () => setOpen(true);
  const onCloseModal = () => setOpen(false);
  const [imgUrl, setImgUrl] = useState("");
  const [imageLoader, setImageLoader] = useState(false);
  const [base64url, setBase64Url] = useState("");
  const modalRef = useRef<HTMLDialogElement>(null);

  // Encode SVG React element to data URL string
  const encodeSvg = (reactElement: React.ReactElement): string => {
    return (
      "data:image/svg+xml," +
      escape(ReactDOMServer.renderToStaticMarkup(reactElement))
    );
  };

  // Convert image URL to Base64 and set state
  const toDataUrl = (url: string, callback: (result: string | ArrayBuffer | null) => void) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = function () {
      const reader = new FileReader();
      reader.onloadend = function () {
        callback(reader.result);
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.send();
  };

  // Encode SVG to Base64 and set state
  const encodeSvgToBase64 = (svgString: string) => {
    toDataUrl(svgString, async (myBase64) => {
      setBase64Url(myBase64 as string);
    });
  };

  // Open image loader modal
  const openImageLoader = () => {
    setImageLoader(true);
  };

  // Check AI feature status and handle image modal display
  const checkGenAIstatus = async (image: React.ReactElement) => {
    const url = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_GET_EMAIL_DETAILS}`;
    let gen_ai_features = false;
    await axiosJWT.get(url).then((res) => {
      if (res.data.success === true) {
        gen_ai_features = res.data.genai_features;
      }
    });
    openImageLoader();
    if (gen_ai_features) {
      setImgUrl(encodeSvg(image));
      encodeSvgToBase64(encodeSvg(image));
      if (modalRef.current) {
        modalRef.current.showModal();
      }
    } else {
      setImgUrl(encodeSvg(image));
    }
  };

  // Generate image element with polygons and image modal
  const getImage = (data: DataProps) => {
    const image = (
      <svg xmlns="http://www.w3.org/2000/svg" width={640} height={360}>
        <image href={data.base_url} width="100%" />
        {data.Results.map((result, index) => (
          <React.Fragment key={index}>
            <polygon
              points={`${result.x[0]} ${result.x[1]},${result.y[0]} ${result.y[1]},${result.w[0]} ${result.w[1]},${result.h[0]} ${result.h[1]}`}
              style={{ fill: "transparent", stroke: "blue", strokeWidth: 2.5 }}
            />
            <text
              textAnchor="middle"
              fontSize={15}
              x={Number(result.x[0] + 25)}
              y={Number(result.x[1] - 5)}
              fill="blue"
              style={{ textTransform: "capitalize" }}
            >
              {result.label}
            </text>
          </React.Fragment>
        ))}
        <polygon
          points={aIPolygen}
          style={{ fill: "transparent", stroke: "yellow", strokeWidth: 4 }}
        />
      </svg>
    );

    return (
      <div>
        <ChatPopover
          modalRef={modalRef}
          imgUrl={encodeSvg(image)}
          base64Image={base64url}
          setImgUrl={setImgUrl}
        />
        <img
          src={encodeSvg(image)}
          style={{ width: "100%",height:"100%", borderRadius: 3 }}
          onClick={() => {
            checkGenAIstatus(image);
          }}
          alt="Canvas Frames Object"
        />
        {imgUrl && (
          <ImageModel open={imageLoader} setOpen={setImageLoader} imgUrl={encodeSvg(image)} />
        )}
      </div>
    );
  };

  return <div>{getImage(data)}</div>;
};

export default ImageBox;
