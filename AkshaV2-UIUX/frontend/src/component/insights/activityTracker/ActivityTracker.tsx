import React, { useRef, useState, useEffect } from "react";
import moment from 'moment';
import dayjs from 'dayjs';
import axiosJWT from "../../../context/axiosAuthIntercept";
import { subDays } from "date-fns";
import { searchTabs } from "./searchStore";
import NotFound from "../../common/NotFound";
import TimePickerPopover from "../../common/TimePickerPopover";
import CameraPopover from "../../common/CameraPopover";
import DatePickerPopover from "../../common/DatePickerPopover";
import SearchIcon from "@mui/icons-material/Search";
import getTimeString from "../../../utils/getTimeString";
import useRemoveScroll from "../../../hooks/useRemoveScroll";
import './styles/activity_tracker.scss';
import getDateString from "../../../utils/getDateString";
import getTabsDateString from "../../../utils/getTabsDateString";
import NotFoundvideo from "../../common/NotFoundVideo";
import VideoGeneration from "../../common/VideoGeneration";
import Messagebox from "../../common/Messagebox";
import { useTranslation } from "react-i18next";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Component: ActivityTracker
 * Displays a search interface for selecting date, time, and camera.
 * On search, retrieves a video insight (if available) for the selected filters.
 * Shows either the resulting video, a loading animation, or a 'Not Found' message.
 */
const ActivityTracker: React.FC = () => {
  const [dates, setDates] = useState([{ startDate: subDays(new Date(), 7), endDate: new Date(), key: "selection" }]);
  const [tabStore, setTabStore] = useState(searchTabs);
  const [cameraList, setCameraList] = useState<any[]>([]);
  const [listInsightCameras, setInsighgtListOfCameras] = useState<{ image: string, camera_Name: string }>({ image: '', camera_Name: '' });
  const [loader, setLoader] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [showGif, setShowGif] = useState(false);
  const [selectedFromTime, setSelectedFromTime] = useState(dayjs().set('hour', 7).set('minute', 0));
  const [selectedToTime, setSelectedToTime] = useState(dayjs().set('hour', 19).set('minute', 0));
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");

  const handleClose = () => setOpen(false);
  const {t} = useTranslation();

  // Node's /Insight call blocks until Python finishes generating the video, so by the
  // time it resolves the file is already done or has already failed. The only real race
  // left is the file existing but not yet fully flushed ("still being formed", size 0) —
  // a handful of short retries covers that without re-running the expensive generation
  // pipeline many times over for a reproducible failure (e.g. "no frames found").
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_ATTEMPTS = 3;
  const pollAttemptsRef = useRef(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    populateDropDownOnMount();
    const element = document.getElementById("body-tag");
    element?.classList.add("hide-scrollbar");

    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const dependencyArray = listInsightCameras?.image ? new Array(1) : [];
  useRemoveScroll(dependencyArray);

  const search = () => {
    const currStartDate = getDateString(dates[0].startDate);
    const currEndDate = getDateString(dates[0].endDate);
    setShowGif(true);
    setInsighgtListOfCameras({ image: "", camera_Name: "" });

    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    pollAttemptsRef.current = 0;

    if (!currStartDate) return showError(t("Please select the start date."));
    if (!currEndDate) return showError(t("Please select the end date."));
    if (!selectedFromTime) return showError(t("Please select the from time."));
    if (!selectedToTime) return showError(t("Please select the to time."));
    if (!selectedCamera) return showError(t("Please select the camera."));

    setLoader(true);
    searchResult();
  };

  const showError = (msg: string) => {
    setMessage(msg);
    setOpen(true);
  };

  const searchResult = () => {
    setLoader(true);
    const currStartDate = getDateString(dates[0].startDate);
    const currEndDate = getDateString(dates[0].endDate);

    if (!currStartDate || !currEndDate || !selectedFromTime || !selectedToTime || !selectedCamera) return;

    const reqBody = {
      Camera_Name: selectedCamera,
      Start_Date: currStartDate,
      End_Date: currEndDate,
      Start_Time: getTimeString(selectedFromTime, true),
      End_Time: getTimeString(selectedToTime, true)
    };

    const config = { headers: { "Content-Type": "application/json" } };

    axiosJWT
      .post(`${VITE_base_url}${import.meta.env.VITE_ACTIVATE_CAMERA_INSIGHTS}`, reqBody, config)
      .then((response) => {
        if (response?.data?.insight?.image) {
          setInsighgtListOfCameras(response.data.insight);
          setLoader(false);
          return;
        }
        // Success response but video isn't written yet ("still being formed") — keep polling
        schedulePoll();
      })
      .catch((error) => {
        // Real failure (e.g. "No frames found", generation error) — retrying would just
        // re-run the same expensive pipeline for the same reproducible result.
        console.error("Insight generation failed", error?.response?.data?.message || error?.message);
        setLoader(false);
      });
  };

  const schedulePoll = () => {
    pollAttemptsRef.current += 1;
    if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
      setLoader(false);
      return;
    }
    pollTimeoutRef.current = setTimeout(searchResult, POLL_INTERVAL_MS);
  };

  const populateDropDownOnMount = async () => {
    try {
      setLoader(true);
      const url = `${VITE_base_url}${import.meta.env.VITE_CAMERAS_LIST}`;
      const { data: camData } = await axiosJWT.get(url);
      const activeCameras = camData.cameras.filter((cam: any) => cam.Active);
      const firstCamera = activeCameras.length > 0 ? activeCameras[0].Camera_Name : t("camera1");

      setCameraList(activeCameras);
      setSelectedCamera(firstCamera);

      const currStartDate = getTabsDateString(dates[0].startDate);
      const currEndDate = getTabsDateString(dates[0].endDate);
      const updatedTabs = tabStore.map((tab, index) =>
        index === 0 ? { ...tab, text: `${currStartDate} - ${currEndDate}` } :
        index === 1 ? { ...tab, text: `07:00 - 19:00` } :
        { ...tab, text: firstCamera }
      );

      setTabStore(updatedTabs);
    } catch (ex) {
      console.error("populateDropDownOnMount error", ex);
    } finally {
      setLoader(false);
    }
  };

  const vidRef = useRef<HTMLVideoElement>(null);
  const handlePlayVideo = () => vidRef.current?.play();

  const handleSetStartTime = (value: any, index: number) => {
    const newStartTime = getTimeString(value);
    const oldEndTime = getTimeString(selectedToTime);
    setSelectedFromTime(value);

    const updatedTabs = [...tabStore];
    updatedTabs[index].text = `${newStartTime || "07:00"} - ${oldEndTime || "19:00"}`;
    setTabStore(updatedTabs);
  };

  const handleSetEndTime = (value: any, index: number) => {
    const newEndTime = getTimeString(value);
    const oldStartTime = getTimeString(selectedFromTime);
    setSelectedToTime(value);

    const updatedTabs = [...tabStore];
    updatedTabs[index].text = `${oldStartTime || "07:00"} - ${newEndTime || "19:00"}`;
    setTabStore(updatedTabs);
  };

  const handleDateChange = (item: any, index: number) => {
    setDates([item.selection]);
    const currStartDate = getTabsDateString(item.selection.startDate);
    const currEndDate = getTabsDateString(item.selection.endDate);

    const updatedTabs = [...tabStore];
    updatedTabs[index].text = `${currStartDate} - ${currEndDate}`;
    setTabStore(updatedTabs);
  };

  const handleChangeActiveCss = (index: number) => {
    const updatedTabs = tabStore.map((tab, idx) => ({ ...tab, active: idx === index }));
    setTabStore(updatedTabs);
  };

  const handleCameraChange = (camera: string, index: number) => {
    setSelectedCamera(camera);
    const updatedTabs = [...tabStore];
    updatedTabs[index].text = camera;
    setTabStore(updatedTabs);
  };

  return (
    <div className="activity-tracker autoalert-search-bar">
      <Messagebox open={open} handleClose={handleClose} message={message} />
      {/* Desktop search bar */}
      <div className="search-bar desktop">
        <div className="main-content">
          {tabStore.map((tab, index) => {
            if (tab.heading === "Date*") {
              return (
                <DatePickerPopover
                  key={index}
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
                  key={index}
                  heading={t("Time*")}
                  text={tab.text}
                  active={tab.active}
                  index={index}
                  onChangeActiveCss={handleChangeActiveCss}
                  starTime={selectedFromTime}
                  endTime={selectedToTime}
                  setStartTime={handleSetStartTime}
                  setEndTime={handleSetEndTime}
                  mobile={false}
                />
              );
            } else if (tab.heading === "Camera*") {
              return (
                <CameraPopover
                  key={index}
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
            return null;
          })}
        </div>
        <SearchIcon className="searchIcon" onClick={search} />
      </div>

      

      {/* Results / Loader / Not Found */}
      {!loader ? (
        <div className="grayBack">
          {listInsightCameras?.image && (
            <div className="row mt-3 mx-0 imgDiv">
              <video
                src={listInsightCameras.image}
                ref={vidRef}
                controls
                className="insight-camera-img"
              />
            </div>
          )}
        </div>
      ) : showGif ? (
        <VideoGeneration />
      ) : null}

      {!listInsightCameras?.image && showGif && !loader && (
        <div className="my_alert_not_found my-5">
          <NotFoundvideo />
        </div>
      )}
    </div>
  );
};

export default ActivityTracker;
