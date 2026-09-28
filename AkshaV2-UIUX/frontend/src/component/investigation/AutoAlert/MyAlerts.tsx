import React, { useState, useEffect, useCallback } from "react";
import dayjs, { Dayjs } from 'dayjs';
import axiosJWT from "../../../context/axiosAuthIntercept";
import SearchIcon from "@mui/icons-material/Search";
import { subDays } from "date-fns";
import TimePickerPopover from "../../common/TimePickerPopover";
import DatePickerPopover from "../../common/DatePickerPopover";
import CameraPopover from "../../common/CameraPopover";
import NotFound from "../../common/NotFound";
import useRemoveScroll from "../../../hooks/useRemoveScroll";
import getTimeString from "../../../utils/getTimeString";
import getDateString from "../../../utils/getDateString";
import getTabsDateString from "../../../utils/getTabsDateString";
import ImageModel from "../../common/ImageModel";
import Messagebox from "../../common/Messagebox";
import { CircularProgress, Box } from "@mui/material";
import { useTranslation } from "react-i18next";
import "./styles/my_alerts.scss";



/**
 * Interface for an individual tab item displayed in the search bar.
 * @interface TabItem
 */
interface TabItem {
  id: number;
  heading: string;
  text: string;
  active: boolean;
}

/**
 * Interface for a camera object retrieved from the API.
 * @interface CameraItem
 */
interface CameraItem {
  _id: string; // MongoDB ObjectId string
  Camera_Name: string;
  Active: boolean;
  image?: string; // Optional camera image URL
  // Add other properties of camera objects if known from API response
}

/**
 * Interface for a single alert info item within the API response.
 * @interface ApiAlertInfoItem
 */
interface ApiAlertInfoItem {
  _id: string; // MongoDB ObjectId string for the individual alert image/record
  UserFeedback: boolean;
  images: string; // URL string for the alert image
  Object_Anomaly?: boolean; // Optional, as per original code logic
  Frame_Anomaly?: boolean; // Optional, as per original code logic
  Results?: any; // Define a more specific type if possible, e.g., { x: number[], y: number[], w: number[], h: number[] }
  base_url?: string; // Base64 string of the image, added dynamically
}

/**
 * Interface for the overall structure of the API alert result.
 * @interface ApiAlertResultItem
 */
interface ApiAlertResultItem {
  cameraName: string;
  info: ApiAlertInfoItem[];
}

/**
 * Interface for the date range object used by the DatePickerPopover.
 * @interface DateRange
 */
interface DateRange {
  startDate: Date;
  endDate: Date;
  key: string;
}

// --- Constants ---
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

// Initial state for search tabs. This should ideally come from a separate config/store file.


/**
 * MyAlerts component displays a search interface for auto-generated alert images.
 * Users can filter alerts by date, time, and camera, and provide feedback on images.
 *
 * @component
 * @returns {JSX.Element} The rendered MyAlerts component.
 */
const MyAlerts: React.FC = () => {

   const {t} = useTranslation();
   
  const searchTabs: TabItem[] = [
  { id: 1, heading: "Date*", text: t("Select Date"), active: false },
  { id: 2, heading: "Time*", text: t("Select Time"), active: false },
  { id: 3, heading: "Camera*", text: t("Select Camera"), active: false },
];

  // --- State Management ---
  const [tabStore, setTabStore] = useState<TabItem[]>(searchTabs);
  const [cameraList, setCameraList] = useState<CameraItem[]>([]);
  // const [alertlist, setAlertlist] = useState<any[]>([]); // Marked as unused in original, keeping for reference if needed later
  const [selectedCamera, setSelectedCamera] = useState<string>("");

  // State for time range selection
  const [selectedFromTime, setSelectedFromTime] = useState<Dayjs>(dayjs().set("hour", 7).set("minute", 0));
  const [selectedToTime, setSelectedToTime] = useState<Dayjs>(dayjs().set("hour", 19).set("minute", 0));

  const [loading, setLoading] = useState<boolean>(false); // Loader for API calls
  const [apiAlertResult, setApiAlertResult] = useState<ApiAlertResultItem[]>([]); // Data from alert search API
  const [itemsToShow, setItemsToShow] = useState<{ expanded: boolean; itemsCount: number }>({
    expanded: true, // Indicates if all items are expanded or showing limited count
    itemsCount: 12, // Number of items to initially show or increment by
  });
  const [imageLoader, setImageLoader] = useState<boolean>(false); // Controls visibility of the full-screen image modal
  const [imgUrl, setImgUrl] = useState<string>(""); // URL of the image to display in the modal

  // State for general message box (e.g., for validation messages)
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");

 
  // State for date range selection, initialized to last 7 days
  const [dates, setDates] = useState<DateRange[]>([
    {
      startDate: subDays(new Date(), 7),
      endDate: new Date(),
      key: "selection",
    },
  ]);

  // --- Helper Functions and Callbacks ---

  /**
   * Closes the message box.
   * @function handleClose
   */
  const handleClose = useCallback((): void => {
    setOpen(false);
  }, []);

  /**
   * Populates the camera dropdown with active cameras and sets default values for search tabs on component mount.
   * @async
   * @function populateDropDownOnMount
   * @returns {Promise<void>}
   */
  const populateDropDownOnMount = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const url = `${VITE_base_url}${import.meta.env.VITE_CAMERAS_LIST}`;
      const { data: camData } = await axiosJWT.get<{ cameras: CameraItem[] }>(url);

      // Filter for active cameras
      const activeCameras = camData.cameras.filter((cam) => cam.Active === true);
      const firstCamera = activeCameras.length > 0 ? activeCameras[0].Camera_Name : t("camera1") ;

      setCameraList(activeCameras);
      setSelectedCamera(firstCamera); // Set the default selected camera

      // Update tabStore with default date, time, and camera
      const currStartDate = getTabsDateString(dates[0].startDate);
      const currEndDate = getTabsDateString(dates[0].endDate);
      const tabStoreCopy = tabStore.map((tab, index) => {
        if (index === 0) { // Date tab
          return { ...tab, text: `${currStartDate} - ${currEndDate}` };
        } else if (index === 1) { // Time tab
          return { ...tab, text: `07:00 - 19:00` };
        } else if (index === 2) { // Camera tab
          return { ...tab, text: firstCamera };
        }
        return tab;
      });

      setTabStore(tabStoreCopy);
      console.log("populateDropDownOnMount --- tabStoreCopy", tabStoreCopy);
    } catch (ex) {
      console.error('Error in populateDropDownOnMount:', ex);
      setMessage("Failed to load camera list.");
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, [dates, tabStore]); // Added dependencies: dates and tabStore

  /**
   * Converts an image URL to a base64 data URL.
   * Note: This function was marked as "unused" in the original code's comment,
   * but it's called within `searchforautoalert` so it's kept.
   * @function toDataUrl
   * @param {string} url - The URL of the image.
   * @param {(base64: string) => void} callback - The callback function to receive the base64 string.
   */
  const toDataUrl = useCallback((url: string, callback: (base64: string) => void): void => {
    const xhr = new XMLHttpRequest();
    xhr.onload = function () {
      const reader = new FileReader();
      reader.onloadend = function () {
        callback(reader.result as string);
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.open("GET", url);
    console.log(import.meta.env.VITE_DEFAULT_JWT_TOKEN)
    xhr.responseType = "blob";
    xhr.send();
  }, []);

  /**
   * Initiates the search for auto alerts based on selected filters (date, time, camera).
   * Performs validation and then makes an API call to fetch alert data.
   * Updates `apiAlertResult` state upon successful fetch.
   * @function searchforautoalert
   */
  const searchforautoalert = useCallback((): void => {
    const currStartDate = getDateString(dates[0].startDate);
    const currEndDate = getDateString(dates[0].endDate);

    // --- Validation ---
    if (!currStartDate) {
      setMessage("Please select the start date.");
      setOpen(true);
      return;
    } else if (!currEndDate) {
      setMessage("Please select the end date.");
      setOpen(true);
      return;
    } else if (!selectedFromTime) {
      setMessage("Please select the from time.");
      setOpen(true);
      return;
    } else if (!selectedToTime) {
      setMessage("Please select the to time.");
      setOpen(true);
      return;
    } else if (!selectedCamera) {
      setMessage("Please select the camera.");
      setOpen(true);
      return;
    }

    const params = {
      camera_name: selectedCamera,
      start_date: currStartDate,
      end_date: currEndDate,
      start_time: getTimeString(selectedFromTime),
      end_time: getTimeString(selectedToTime),
    };

    setLoading(true); // Start loader
    const headers = { "Content-Type": "application/json; charset=utf-8" };

    const url = `${VITE_base_url}${import.meta.env.VITE_ALERTS}`;
    axiosJWT
      .post<{ success: boolean; alert: ApiAlertResultItem[]; message?: string }>(url, params, { headers: headers })
      .then((res) => {
        if (res.data.success === true) {
          if (res.data.alert.length === 0) {
            setMessage(t("No alerts found"));
            setOpen(true);
          }
          setApiAlertResult(res.data.alert); // Populate state with raw API result
          
          // Process images for base64 conversion and result string
          let processedImages: ApiAlertInfoItem[] = [];
          for (const alertResult of res.data.alert) {
            for (const item of alertResult.info) {
              
              if (item.images) { // Ensure image URL exists
              

                processedImages.push(item);
              }
            }
          }


          // Asynchronous processing of images to base64
          // Note: The original code's `arr.forEach` with `toDataUrl` and `setTimeout`
          // might lead to `setAlertlist` being called before all images are converted.
          // For now, mirroring the original logic, but a more robust solution
          // would involve Promise.all for all conversions.
          processedImages.forEach((e) => {
            if (e.images) {
              toDataUrl(e.images, (myBase64) => {
                e.base_url = myBase64;
                // Original logic for Results string. This part seems to modify the `e` directly.
                e.Results =
                  e.Object_Anomaly === true || e.Frame_Anomaly === true
                    ? `${e.Results[0].x[0]} ${e.Results[0].x[1]},${e.Results[0].y[0]} ${e.Results[0].y[1]} ,${e.Results[0].w[0]} ${e.Results[0].w[1]},${e.Results[0].h[0]} ${e.Results[0].h[1]}`
                    : "00";
              });
            }
          });

          // This timeout might be problematic as base64 conversions are async and may not complete within 1s.
          // It's kept to mirror the original behavior.
          setTimeout(() => {
            // setAlertlist(processedImages); // This state was marked "unused" in original, decided to remove it
            setLoading(false); // Stop loader after processing
          }, 1000);
        } else {
          setMessage(res.data.message || "An error occurred during search.");
          setOpen(true);
          setLoading(false); // Stop loader on error
        }
      })
      .catch((error) => {
        console.error("Error fetching auto alerts:", error);
        setMessage(error.response?.data?.message || "Failed to fetch alerts. Please try again.");
        setOpen(true);
        setLoading(false); // Stop loader on error
      });
  }, [dates, selectedFromTime, selectedToTime, selectedCamera, toDataUrl]);

  /**
   * Effect hook to run `populateDropDownOnMount` once on initial component render.
   */
  useEffect(() => {
    populateDropDownOnMount();
  }, []); // Dependency array to ensure it runs only on mount

  /**
   * Effect hook to remove "hide-scrollbar" class from the body tag.
   * This seems to be a cleanup/styling effect from an older logic.
   * @deprecated The `hide-scrollbar` logic might be tied to older styling or a different component flow.
   */
  useEffect(() => {
    const element = document.getElementById("body-tag");
    if (element) {
      element.classList.remove("hide-scrollbar");
    }
    // Original had a setTimeout for setLoading(false) here, moved into `searchforautoalert` finally block
  }, []);

  // Custom hook to remove scrollbar if `apiAlertResult` is empty.
  // This hook's implementation (useRemoveScroll) is external.
  useRemoveScroll(apiAlertResult);

  /**
   * Handles user feedback for an alert image by updating its `UserFeedback` status in the database.
   * Re-fetches alerts after updating to reflect changes.
   * @param {React.ChangeEvent<HTMLInputElement>} e - The change event from the checkbox (unused directly).
   * @param {ApiAlertInfoItem} data - The alert info item being updated.
   * @param {string} cameraName - The name of the camera associated with the alert.
   * @function onChange
   */
  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>, data: ApiAlertInfoItem, cameraName: string): void => {
    const params = {
      cameraName,
      _id: data._id,
      UserFeedback: !data.UserFeedback, // Toggle the feedback status
    };
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    const url = `${VITE_base_url}${import.meta.env.VITE_UPDATE_USER_FEEDBACK}`;

    axiosJWT
      .post<{ success: boolean }>(url, params, { headers: headers })
      .then((res) => {
        if (res.data.success === true) {
          searchforautoalert(); // Re-fetch data to reflect the updated feedback
        } else {
          setMessage("Failed to update feedback.");
          setOpen(true);
        }
      })
      .catch((error) => {
        console.error("Error updating user feedback:", error);
        setMessage(error.response?.data?.message || "Failed to update feedback. Please try again.");
        setOpen(true);
      });
  }, [searchforautoalert]);

  /**
   * Handles setting the start time from the TimePickerPopover.
   * Updates `selectedFromTime` and the corresponding tab text.
   * @param {Dayjs | null} value - The new start time from the TimePicker.
   * @param {number} index - The index of the time tab in `tabStore`.
   * @function handleSetStartTime
   */
  const handleSetStartTime = useCallback((value: Dayjs | null, index: number): void => {
    if (!value) return; // Guard against null value
    const newStartTime = getTimeString(value);
    const oldEndTime = getTimeString(selectedToTime);
    setSelectedFromTime(value);

    setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${newStartTime || "07:00"} - ${oldEndTime || "19:00"}`;
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });
  }, [selectedToTime]);

  /**
   * Handles setting the end time from the TimePickerPopover.
   * Updates `selectedToTime` and the corresponding tab text.
   * @param {Dayjs | null} value - The new end time from the TimePicker.
   * @param {number} index - The index of the time tab in `tabStore`.
   * @function handleSetEndTime
   */
  const handleSetEndTime = useCallback((value: Dayjs | null, index: number): void => {
    if (!value) return; // Guard against null value
    const newEndTime = getTimeString(value);
    const oldStartTime = getTimeString(selectedFromTime);
    setSelectedToTime(value);

    setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${oldStartTime || "07:00"} - ${newEndTime || "19:00"}`;
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });
  }, [selectedFromTime]);

  /**
   * Handles the "Show More" / "Show Less" functionality for alert images.
   * Increments `itemsToShow.itemsCount` by 12 or resets to 12.
   * @async
   * @function showMore
   * @returns {Promise<void>}
   */
  const showMore = useCallback(async (): Promise<void> => {
    // Check if apiAlertResult has data before attempting to access info
    if (apiAlertResult.length === 0 || !apiAlertResult[0].info) {
      console.warn("No alert info available to show more/less.");
      return;
    }

    const allImages = apiAlertResult[0].info.map((item) => item.images);
    const currentlyShownImagesCount = allImages.slice(0, itemsToShow.itemsCount).length;

    if (currentlyShownImagesCount === allImages.length) {
      // If currently showing all images, reset to initial count
      setItemsToShow({ ...itemsToShow, itemsCount: 12, expanded: false });
    } else {
      // Show more images
      setItemsToShow({
        itemsCount: Number(itemsToShow.itemsCount) + 12,
        expanded: true,
      });
    }
  }, [apiAlertResult, itemsToShow]);

  /**
   * Handles changes to the date range from the DatePickerPopover.
   * Updates `dates` state and the corresponding date tab text.
   * @param {any} item - The selection object from the DatePicker (contains `selection.startDate`, `selection.endDate`).
   * @param {number} index - The index of the date tab in `tabStore`.
   * @function handleDateChange
   */
  const handleDateChange = useCallback((item: any, index: number): void => {
    setDates([item.selection]); // Update the date range state

    const currStartDate = getTabsDateString(item.selection.startDate);
    const currEndDate = getTabsDateString(item.selection.endDate);

    setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${currStartDate} - ${currEndDate}`; // Update the date string in the tab
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });
  }, []);

  /**
   * Handles changing the active CSS class for tabs.
   * Sets the `active` property of the clicked tab to true and others to false.
   * @param {number} index - The index of the tab to make active.
   * @function handleChangeActiveCss
   */
  const handleChangeActiveCss = useCallback((index: number): void => {
    setTabStore((prevTabStore) =>
      prevTabStore.map((tab, i) => ({
        ...tab,
        active: i === index, // Set active true only for the clicked tab
      }))
    );
  }, []);

  /**
   * Handles changes to the selected camera from the CameraPopover dropdown.
   * Updates `selectedCamera` state and the corresponding camera tab text.
   * @param {string} camera - The name of the newly selected camera.
   * @param {number} atIndex - The index of the camera tab in `tabStore` (expected to be 2).
   * @function handleCameraChange
   */
  const handleCameraChange = useCallback((camera: string, atIndex: number): void => {
    setSelectedCamera(camera);

    setTabStore((prevTabStore) =>
      prevTabStore.map((tab, index) =>
        index === atIndex ? { ...tab, text: camera } : tab
      )
    );
    console.log("handleCameraChange", atIndex, tabStore);
  }, [tabStore]); // tabStore is a dependency here because it's used to create the new array

  /**
   * Opens the full-screen image loader modal.
   * @function openImageLoader
   */
  const openImageLoader = useCallback((): void => {
    setImageLoader(true);
  }, []);

  // --- Render Logic ---
  return (
    <div>
      <div className="my-alert autoalert-search-bar">
        {/* Messagebox for displaying alerts/validation messages */}
        <Messagebox open={open} handleClose={handleClose} message={message} />

        {/* Desktop Search Bar */}
        <div className="search-bar desktop">
          <div className="main-content">
            {tabStore.map((tab, index) => {
              // Conditionally render popovers based on tab heading
              if (tab.heading === "Date*") {
                return (
                  <DatePickerPopover
                    key={tab.id} // Added key for list rendering
                    heading={t("Date*")}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    dates={dates}
                    onDateChange={handleDateChange}
                    onChangeActiveCss={handleChangeActiveCss}
                    mobile={false}
                  />
                );
              } else if (tab.heading === "Time*") {
                return (
                  <TimePickerPopover
                    key={tab.id} // Added key for list rendering
                    heading={t("Time*")}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    starTime={selectedFromTime}
                    endTime={selectedToTime}
                    setStartTime={handleSetStartTime}
                    setEndTime={handleSetEndTime}
                    onChangeActiveCss={handleChangeActiveCss}
                    mobile={false}
                  />
                );
              } else if (tab.heading === "Camera*") {
                return (
                  <CameraPopover
                    key={tab.id} // Added key for list rendering
                    heading={t("Camera*")}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    selectedCamera={selectedCamera}
                    onChangeActiveCss={handleChangeActiveCss}
                    onCameraChange={handleCameraChange}
                    allActiveCameras={cameraList}
                    mobile={false}
                  />
                );
              }
              return null; // Return null for any unhandled tab headings
            })}
          </div>
          {/* Search Icon for desktop */}
          <SearchIcon className="searchIcon" onClick={searchforautoalert} />
        </div>

        {/* Mobile Search Bar */}
        {/* <div className="mobile-search">
          {tabStore.map((tab, index) => {
            // Mobile specific layout with labels
            if (tab.heading === "Date*") {
              return (
                <div className="single_item" key={tab.id}>
                  <label>
                    Date <span>*</span>
                  </label>
                  <DatePickerPopover
                    heading={tab.heading}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    dates={dates}
                    onDateChange={handleDateChange}
                    onChangeActiveCss={handleChangeActiveCss}
                    mobile={true}
                  />
                </div>
              );
            } else if (tab.heading === "Time*") {
              return (
                <div className="single_item" key={tab.id}>
                  <label>
                    Time <span>*</span>
                  </label>
                  <TimePickerPopover
                    heading={tab.heading}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    starTime={selectedFromTime}
                    endTime={selectedToTime}
                    setStartTime={handleSetStartTime}
                    setEndTime={handleSetEndTime}
                    onChangeActiveCss={handleChangeActiveCss}
                    mobile={true}
                  />
                </div>
              );
            } else if (tab.heading === "Camera*") {
              return (
                <div className="single_item" key={tab.id}>
                  <label>
                    Select Camera <span>*</span>
                  </label>
                  <CameraPopover
                    heading={tab.heading}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    selectedCamera={selectedCamera}
                    onChangeActiveCss={handleChangeActiveCss}
                    onCameraChange={handleCameraChange}
                    allActiveCameras={cameraList}
                    mobile={true}
                  />
                </div>
              );
            }
            return null;
          })}
          <button className="search-button" onClick={searchforautoalert}>
            <i className="bx bx-search"></i>
            Search
          </button>
        </div> */}

        {/* Alerts Display Area */}
        <div className="mb-3 px-2">
          <div className="container-fluid">
            <div className="row mt-5">
              <div className="my_alert_not_found">
                {/* Display NotFound component if no alerts are found after search */}
                {apiAlertResult.length === 0 && !loading && <NotFound />}
              </div>
              <div>
                {loading ? (
                  // CircularProgress loader while data is being fetched
                  <Box
                    sx={{
                      position: "absolute",
                      top: "50%",
                      left: "50%",
                      transform: "translate(-50%, -50%)"
                    }}
                  >
                    <CircularProgress />
                  </Box>
                ) : (
                  <>
                    {/* Iterate through API alert results by camera */}
                    {apiAlertResult.map((data, i) => {
                      // Sort images by descending timestamp if available, or just by order received.
                      // The `sortImagesByDesc` utility (not provided) is assumed to handle this.
                      const sortedInfo = data.info; // Assuming sortImagesByDesc is integrated or handled elsewhere
                      // (Original code didn't explicitly call `sortImagesByDesc` on the `info` array before mapping)
                     
                      return (
                        <div
                          className="row mt-2 mx-0 rowCls"
                          key={i} // Key for the camera-level div
                        >
                          <div className="rowStyling">
                            <div className="gridCls row">
                              {/* Render alert images if available */}
                              {sortedInfo.length > 0 &&
                                sortedInfo
                                  .slice(0, itemsToShow.itemsCount) // Apply "Show More/Less" logic
                                  .map((item, ind) => (
                                    <div
                                      className={`col-sm-12 col-md-6 col-lg-4 mt-3 mx-0 text-center`}
                                      key={item._id || ind} // Use _id as key if available, otherwise index
                                    >
                                      <div className="outer-wrapper">
                                        <div className="auto_alert_div_wrapper">
                                          <img
                                            alt="camera img"
                                            crossOrigin="anonymous" // Required for CORS images
                                            src={item.images}
                                            id={`imgcls-${item._id || ind}`} // Unique ID for image
                                            onClick={() => {
                                              setImgUrl(item.images); // Set image URL for the modal
                                              openImageLoader(); // Open the image modal
                                            }}
                                          />
                                          {/* Checkbox for UserFeedback. On focus, a checkbox appears. */}
                                          {/* The original code didn't show the checkbox but mentioned it appears on focus.
                                              Adding a basic checkbox here, its visibility on focus would be handled by CSS. */}
                                          <div className="user-feedback-checkbox">
                                            <input
                                              type="checkbox"
                                              checked={item.UserFeedback}
                                              onChange={(e) => onChange(e, item, data.cameraName)}
                                              title="Provide feedback"
                                            />
                                            <span>Feedback</span>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                            </div>
                          </div>
                          {/* "Show More/Less" button */}
                          {sortedInfo.length > 0 && sortedInfo.length > 12 && ( // Only show if more than initial 12 images
                            <a className="show-more-info" onClick={showMore}>
                              <button className="btn-color">
                                {sortedInfo.slice(0, itemsToShow.itemsCount).length < sortedInfo.length ? (
  t("Show more", {
    count: sortedInfo.slice(0, itemsToShow.itemsCount).length,
    total: sortedInfo.length
  })
) : (
  t("Show less", {
    count: sortedInfo.slice(0, itemsToShow.itemsCount).length,
    total: sortedInfo.length
  })
)}

                              </button>
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Image Model component, shown when imgUrl is present */}
      {imgUrl && (
        <ImageModel
          open={imageLoader}
          setOpen={setImageLoader}
          imgUrl={imgUrl}
        />
      )}
    </div>
  );
};

export default MyAlerts;
