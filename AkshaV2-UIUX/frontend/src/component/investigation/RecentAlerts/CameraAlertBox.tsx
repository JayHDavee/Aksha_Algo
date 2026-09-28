import React, { useState, useEffect, useRef } from 'react';
import ImageModel from '../../common/ImageModel';
import ChatPopover from '../ChatPopover/ChatPopover';
import axiosJWT from "../../../context/axiosAuthIntercept";
import { useTranslation } from 'react-i18next';

const imagesLimit = 4; // Show 4 images per page initially

// Initial state for image pagination
const initialState = { itemsCount: imagesLimit };

interface CameraAlertBoxProps {
  data: any;
  indexed: number;
}

/**
 * CameraAlertBox component displays camera alert images with pagination.
 * It includes modal previews, GenAI conditional logic, and "Show More/Less" toggle.
 *
 * @param {CameraAlertBoxProps} props - Props containing alert image data and index.
 * @returns {JSX.Element | null} Rendered component or null if no images exist.
 */
const CameraAlertBox: React.FC<CameraAlertBoxProps> = ({ data, indexed }) => {
  const {t} = useTranslation();
  const [itemsToShow, setItemsToShow] = useState<{ itemsCount: number }>(initialState);
  const [aIFrames, setAIFrames] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [imgUrl, setImgUrl] = useState('');
  const [imageLoader, setImageLoader] = useState(false);
  const [base64Image, setBase64Image] = useState('');
  const modalRef = useRef<any | null>(null);

  /** Handles modal open */
  const onOpenModal = () => setOpen(true);

  /** Handles modal close */
  const onCloseModal = () => setOpen(false);

  /**
   * Handles Show More / Show Less toggle for images
   */
  const showMore = () => {
    const currentShown = aIFrames.slice(0, itemsToShow.itemsCount).length;
    if (currentShown === aIFrames.length) {
      setItemsToShow({ itemsCount: imagesLimit }); // Reset
    } else {
      setItemsToShow({ itemsCount: itemsToShow.itemsCount + imagesLimit }); // Load more
    }
  };

  /**
   * Converts image URL to base64 format using FileReader and XHR
   * @param url Image URL
   * @param callback Callback with base64 result
   */
  function toDataUrl(url: string, callback: (result: string) => void) {
    const xhr = new XMLHttpRequest();
    xhr.onload = function () {
      const reader = new FileReader();
      reader.onloadend = function () {
        if (reader.result) callback(reader.result as string);
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.send();
  }

  /**
   * Converts image to base64 and sets state
   * @param img Image URL
   */
  const convertBase64 = (img: string) => {
    toDataUrl(img, async (myBase64) => {
      setBase64Image(myBase64);
    });
  };

  /** Triggers image loading indicator */
  const openImageLoader = () => {
    setImageLoader(true);
  };

  /**
   * Checks GenAI status and handles modal or fallback display
   * @param image Image URL
   */
  const checkGenAIstatus = async (image: string) => {
    const url = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_GET_EMAIL_DETAILS}`;
    let gen_ai_features = false;

    try {
      const res = await axiosJWT.get(url);
      if (res.data.success === true) {
        gen_ai_features = res.data.genai_features;
      }
    } catch (error) {
      console.error('GenAI check failed:', error);
    }

    setImgUrl(image);

    if (gen_ai_features) {
      convertBase64(image);
      setImageLoader(false);
      modalRef.current?.showModal?.();
    } else {
      openImageLoader();
    }
  };

  // Watch data changes and update image list
  useEffect(() => {
    if (data.images && data.images.length > 0) {
      setAIFrames(data.images);
      setItemsToShow(initialState);
    } else {
      setAIFrames([]);
      setItemsToShow(initialState);
    }
  }, [data]);

  if (!data.images || data.images.length === 0) return null;

  return (
    <div className="row mx-0 cam-name-container">
      <ChatPopover
        modalRef={modalRef}
        imgUrl={imgUrl}
        base64Image={base64Image}
        setImgUrl={setImgUrl}
      />

      {/* Divider line for all but first index */}
      {indexed !== 0 && (
        <div className="mb-3">
          <hr className="hr-seperator" />
        </div>
      )}

      {/* Camera Name Heading */}
      <div>
        <h4>{data.cameraName}</h4>
      </div>

      {/* Image Grid */}
      <div className="container-fluid">
        <div className="row mt-2 mx-0 images-container">
          {aIFrames.slice(0, itemsToShow.itemsCount).map((imgg, index) => (
            <div
              className="col-lg-4 col-md-6 col-sm-12 col-xs-12 col-xl-3 col-xxl-3"
              key={index}
            >
              <div>
                <img
                  alt="camera img"
                  crossOrigin="anonymous"
                  src={imgg}
                  className="w-100 image-styling"
                  onClick={() => checkGenAIstatus(imgg)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Modal for image viewer (non-AI) */}
      {imgUrl && imageLoader && (
        <ImageModel open={imageLoader} setOpen={setImageLoader} imgUrl={imgUrl} />
      )}

      {/* Show More / Show Less */}
      {aIFrames.length > imagesLimit && (
        <div className="show-more-info">
          <a className="btn-color" onClick={showMore}>
            {itemsToShow.itemsCount < aIFrames.length ? (
              <span>
                {t("Show more")} ({itemsToShow.itemsCount}/{aIFrames.length})
              </span>
            ) : (
              <span>
                {t("Show less")} ({aIFrames.length}/{aIFrames.length})
              </span>
            )}
          </a>
        </div>
      )}
    </div>
  );
};

export default CameraAlertBox;
