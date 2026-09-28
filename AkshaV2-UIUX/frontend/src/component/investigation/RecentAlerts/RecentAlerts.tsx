import React, { useEffect, useState, useCallback } from "react";
import { useSelector } from "react-redux";
import axiosJWT from "../../../context/axiosAuthIntercept"; // Assuming axiosJWT is properly typed
import useRemoveScroll from "../../../hooks/useRemoveScroll"; // Assuming this hook is typed
import './styles/recentAlert.scss';
import CameraAlertBox from "./CameraAlertBox"; // Assuming this component is typed
import NotFound from "../../common/NotFound"; // Assuming this component is typed
import { CircularProgress, Box } from '@mui/material';

// --- Interfaces for Type Safety ---

/**
 * Interface for a single alert image/data item received from the API.
 * This represents an individual alert instance, not grouped by camera.
 * @interface AlertItem
 */
interface AlertItem {
  cameraName: string; // The name of the camera associated with this alert
  images: string; // The URL string for the alert image
  _id: string; // Unique ID for the alert (if available)
  // Optional properties as found in the original code's `e` object within `response.data.alert.forEach`
  image?: string; // Appears to be redundant with `images` based on API structure, but kept if used differently.
  base_url?: string; // Base64 string of the image
  Results?: any; // The `Results` property could be complex (e.g., polygon coordinates)
  Object_Anomaly?: boolean;
  Frame_Anomaly?: boolean;
  UserFeedback?: boolean; // If feedback is managed at this level
}

/**
 * Interface for the structure of the Redux state portion accessed by `useSelector`.
 * Adjust `any` to more specific types if your Redux store is fully typed.
 * @interface RootState
 */
interface RootState {
  investigation: {
    durationTime: string | null; // `durationTime` can be a string (from select value) or null initially
  };
  // Add other slices of your Redux state if needed
}

// --- Component Definition ---

/**
 * `RecentAlerts` component displays alert images (both "myalert" and "autoalert")
 * for a duration selected in a different part of the application (via Redux state).
 * It fetches and organizes alerts by camera, showing a loader during data retrieval
 * and a "Not Found" message if no data is present.
 *
 * @component
 * @returns {JSX.Element} The rendered RecentAlerts component.
 */
const RecentAlerts: React.FC = () => {
  // Redux state: Retrieves the `durationTime` from the `investigation` slice.
  // This value determines the time window for fetching recent alerts.
  const durationTime = useSelector((state: RootState) => state.investigation.durationTime);

  // State to hold the list of all recent alerts fetched from the API.
  // This array contains `AlertItem` objects, which are individual alert instances.
  const [allRecentAlertsList, setAllRecentAlertsList] = useState<AlertItem[]>([]);
  // State to control the visibility of the loading spinner.
  const [loader, setLoader] = useState<boolean>(false);

  /**
   * Converts an image URL to a base64 data URL.
   * This function is intended to convert images to base64 for display purposes,
   * though the original comment notes `e.image` might be absent in the Node.js API response,
   * implying `e.images` (plural) might be the correct field if images are directly returned.
   *
   * @function toDataUrl
   * @param {string} url - The URL of the image to convert.
   * @param {(base64: string) => void} callback - A callback function that receives the base64 string.
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
    xhr.responseType = "blob";
    xhr.send();
  }, []);

  /**
   * Fetches all recent alert images (both "myalert" and "autoalert")
   * for the specified `durationTime`.
   * Displays a loading spinner during the fetch operation.
   * Updates `allRecentAlertsList` with the fetched data.
   *
   * @function getAllAlert
   */
  const getAllAlert = useCallback((): void => {
    setLoader(true); // Activate the loading spinner

    // Determine the duration time for the API request.
    // Defaults to 1 hour if `durationTime` from Redux is null or undefined.
    const durationTimeParam: number = durationTime ? Number(durationTime) : 1;

    // Construct the base URL for the API request.
    const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

    // Make the API call to fetch recent alerts.
    const finalUrl = `${VITE_base_url}${import.meta.env.VITE_RECENT_ALERTS}${durationTimeParam}`;
console.log("Final URL:", finalUrl);
    axiosJWT
      .get(
        `${VITE_base_url}${import.meta.env.VITE_RECENT_ALERTS}${durationTimeParam}`
      )
      .then((response) => {
        console.log("res",response);
        // --- Image processing (as per original logic, even if `e.image` is noted as absent) ---
        // The original code iterates through `response.data.alert` and attempts to convert `e.image` to base64.
        // If `e.image` is truly absent, this block might not execute or would require `e.images` to be used instead.
        // Assuming `e.image` is a typo and `e.images` (the image URL field) is intended here for base64 conversion.
        response.data.alert.forEach((e: AlertItem) => {
          // Check if the image URL exists before attempting conversion.
          if (e.images !== null && e.images !== "") { // Using `e.images` as per API structure comment
            toDataUrl(e.images, async function (myBase64: string) {
              e.base_url = myBase64; // Assign the base64 string to `base_url`

              // Original code's logic for `e.Results`. This part manipulates `e.Results`
              // directly on the object within the array. It was noted as "unused anywhere"
              // in the original component comments, so its actual effect might be minimal
              // unless `Results` is later consumed by `CameraAlertBox`.
              e.Results = Array.isArray(e.Results)
                ? e.Results.flat(1) // Flatten a nested array (e.g., `[[0,1], [2,3]]` to `[0,1,2,3]`)
                : `${e.Results[0].x[0]} ${e.Results[0].x[1]},${e.Results[0].y[0]} ${e.Results[0].y[1]} ,${e.Results[0].w[0]} ${e.Results[0].w[1]},${e.Results[0].h[0]} ${e.Results[0].h[1]}`;
            });
          }
        });

        // Update the component's state with the fetched and potentially processed alert list.
        setAllRecentAlertsList(response.data.alert);

        // --- Unused Data Mapping in Original Code ---
        // The following section `mapData` and `arrayUniqueByKey` was present in the original JS code
        // but was commented as "found unused". I'm keeping it commented out here as well
        // to reflect the original intent and avoid adding dead code to the TSX version.
        /*
        let mapData = [];
        for (let i = 0; i < response.data.alert.length; i++) {
          if (
            response.data.alert[i].images !== null && // Changed from e.image to e.images
            response.data.alert[i].images !== "" // Changed from e.image to e.images
          ) {
            let filteredData = response.data.alert.filter((data) => {
              return response.data.alert[i].cameraName === data.cameraName;
            });
            mapData.push({
              cameraName: response.data.alert[i].cameraName,
              cameraDetail: filteredData,
            });
          }
        }
        let arrayUniqueByKey = [
          ...new Map(
            mapData.map((item) => [item["cameraName"], item])
          ).values(),
        ];
        // Further modification of `arrayUniqueByKey` was also unused
        setTimeout(() => {
          arrayUniqueByKey = arrayUniqueByKey.map((data) => {
            data.isShowFlag = false;
            data.cameraDetail.map((detail) =>
              detail?.Results?.length > 0
                ? (data.isShowFlag = true)
                : (data.isShowFlag = false)
            );
            return data;
          });
          // setAIFrames(arrayUniqueByKey); // This was setting a state not declared/used elsewhere
          setLoader(false);
        }, 1000);
        */

        setLoader(false); // Deactivate loader after successful data fetch and initial processing
      })
      .catch((error) => {
        console.error("Error fetching recent alerts:", error);
        setLoader(false); // Deactivate loader on error
      });
  }, [durationTime, toDataUrl]); // `durationTime` and `toDataUrl` are dependencies for `getAllAlert`

  /**
   * Effect hook: Calls `getAllAlert` once on the initial render of the component.
   * This mimics `componentDidMount` behavior.
   */
  useEffect(() => {
    getAllAlert();
  }, [getAllAlert]); // Dependency array ensures it runs only when `getAllAlert` reference changes (i.e., on mount)

  /**
   * Effect hook: Removes the "hide-scrollbar" class from the `body-tag` element.
   * This is likely a global styling side effect from another part of the application,
   * ensuring that a scrollbar hidden elsewhere is re-enabled if needed on this page.
   */
  useEffect(() => {
    const element = document.getElementById("body-tag");
    if (element) {
      element.classList.remove("hide-scrollbar");
    }
  }, []); // Empty dependency array means this runs once on mount and cleans up on unmount

  /**
   * Effect hook: Re-fetches all alerts whenever the `durationTime` (from Redux) changes.
   * This ensures the alert list updates when the user selects a new duration in `Tabs.jsx`.
   */
  useEffect(() => {
    getAllAlert();
  }, [durationTime, getAllAlert]); // `getAllAlert` is a dependency as it's called here

  // Custom hook `useRemoveScroll` to remove page scroll if `allRecentAlertsList` is empty.
  // This helps maintain a clean UI when there's no content to scroll through.
  useRemoveScroll(allRecentAlertsList);

  return (
    <>
      {loader ? (
        // Display a full-screen loading spinner when `loader` is true.
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
        // Render content once data is loaded or if there's no data.
        <>
          <div className="recentAlert">
            <div className="mt-5 mx-0">
              {/* Conditional rendering based on `loader` and `allRecentAlertsList` content. */}
              {/* If not loading and there are alerts, map and render `CameraAlertBox` for each alert. */}
              {allRecentAlertsList?.length > 0 ? (
                allRecentAlertsList.map((data, i) => (
                  <CameraAlertBox data={data} key={data._id || i} indexed={i} /> // Using `_id` as key if available for better stability
                ))
              ) : (
                // If no alerts found and not loading, display the `NotFound` component.
                <div className="my_alert_not_found my-5">
                  <NotFound />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default RecentAlerts;
