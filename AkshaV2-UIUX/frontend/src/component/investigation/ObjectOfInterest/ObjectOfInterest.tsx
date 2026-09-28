//component returns a search box and a series of alert images matching search filters below it if present else a not found image returned
//'investigationReducer' reducer actions   fetchAllCamerasName, fetchAllObjectOfInterestLabels, fetchAreaOfInterestImage, coordinatesSelected are used to pass state
//currently not working properly for object of interest labels selected



//to be noted
//area_of_interest is not mandatory
//session and local storage used ofr object ogf intrest labels
//if no alert images generated  and stored in Aksha folder then no alerts will be displayed on search
//needs meta_camName  table and  for each data obj in table result array must have OOI labels selected through ui



import React, { useState, useEffect, Suspense, useRef, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { message, Spin } from "antd";
import axiosJWT from "../../../context/axiosAuthIntercept";
import moment from 'moment';
import dayjs, { Dayjs } from 'dayjs';
import { subMonths, subDays } from "date-fns";
import SearchIcon from "@mui/icons-material/Search";
import {
  fetchAllCamerasName,
  fetchAllObjectOfInterestLabels,
  fetchAreaOfInterestImage,
  coordinatesSelected,
} from "../../../global_store/reducers/investigationReducer";

import TimePickerPopover from "../../common/TimePickerPopover";
import DatePickerPopover from "../../common/DatePickerPopover";
import Truck from "../../common/Truck";
import CameraPopover from "../../common/CameraPopover";
import AreaOfInterest from "./AreaOfInterest";
import NotFound from "../../common/NotFound"; //show not found if no data present
import getTimeString from "../../../utils/getTimeString"; //used to geTime in string format like '10:00', '07:09'
import useRemoveScroll from "../../../hooks/useRemoveScroll";
// import "./interestObject.scss";
import './styles/interestObject.scss';
import getDateString from "../../../utils/getDateString";

import getTabsDateString from "../../../utils/getTabsDateString";
import { CircularProgress } from '@mui/material';
import Box from '@mui/material/Box';
import Messagebox from "../../common/Messagebox";

import { RangeKeyDict } from 'react-date-range';
import { useTranslation } from "react-i18next";

const ImageBox = React.lazy(() => import("../../common/CanvasFramesObj"));  //lazy loading  component

// const getLabelsArr = (labelsArr : string[]): string[] => {
//   let arr : string[] = [];
//   for (let item of labelsArr) {
//     item = item.replace("\r", ""); //'r' not returned anymore
//     arr = [...arr, item];//spread prev elements plus new element
//   }
//   arr = arr.length > 1 ? [arr[0]] : arr; //length greater than 1 use first label
//   return arr;
// }

const getLabelsArr = (labelsArr: string[]): string[] => {
  return labelsArr
    .map(label => label.replace(/[\r\n]+/g, '').trim())
    .filter(Boolean)
    .slice(0, 1);
};

// define base url
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface Camera {
  Camera_Name: string;
  Active: boolean;
}

interface RootState {
  investigation: {
    isCoordinatesSelected: boolean | null;
    allCameraNames: Camera[];
    // Add other investigation reducer states if used
  }
}

type SingleCamera = {
  name: string;
  isCamera: boolean;
};

interface Tab {
  id: number;
  label: string;
  text: string | string[];
}

type StrictDateRange = {
  startDate: Date;
  endDate: Date;
  key: string;
};

interface TabItem {
  id: number;
  heading: string;
  text: string;
  active: boolean;
}


const ObjectOfInterest: React.FC = () => {

  const { t } = useTranslation();

  const searchTabs: TabItem[] = [
    { id: 1, heading: "Date*", text: t("Select Date"), active: false },
    { id: 2, heading: "Time*", text: t("Select Time"), active: false },
    { id: 3, heading: "Camera*", text: t("Select Camera"), active: false },
    { id: 4, heading: "Object of Interest*", text: "Truck", active: false },
    { id: 5, heading: "Area of Interest*", text: t("AOI"), active: false }
  ];


  const [tabStore, setTabStore] = useState<TabItem[]>(searchTabs); //tabs array to be shown in ui
  const [singleCameraName, setSingleCameraName] = useState<SingleCamera>({
    name: "",
    isCamera: false,
  });

  const [loader, setLoader] = useState<boolean>(false);
  //goes to timepicker, default state to be send to timepicker
  const [starTime, setStartTime] = useState(dayjs().set('hour', 7).set('minute', 0));
  const [endTime, setEndTime] = useState(dayjs().set('hour', 19).set('minute', 0));
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [oILable, setOILable] = useState<string[]>([]); //array of labels selected
  const [aIPolygen, setAIPolygen] = useState<string>("");//setAIPolygen sent to AreaOfInterest,  aIPolygen(i.e responseCoordinates ) used by  ImageBox
  const [responseCoordinates, setResponseCoordinates] = useState<string>(""); //takes  aIPolygen current state, responseCoordinates used by  ImageBox
  const [aIFrames, setAIFrames] = useState<any[]>([]); //alert data to be shown
  const [itemsToShow, setItemsToShow] = useState<{ expanded: boolean, itemsCount: number }>({ expanded: true, itemsCount: 12 });
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [ooiLabels, setooilabels] = useState<string[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);


  //goes to datepicker, default state to be send to datepicker
  const [dates, setDates] = useState<StrictDateRange[]>([
    {
      startDate: subDays(new Date(), 7),
      // startDate: subMonths(new Date(), 1), //subMonths returns `previous month  starting from todays date...` when 1 is subtracted 
      endDate: new Date(),
      key: "selection",
    },]
  );

  //isCoordinatesSelected : default value null, unless area of interest  selected, then its false or true 
  let isCoordinatesSelected = useSelector(
    (state: RootState) => state.investigation.isCoordinatesSelected
  );

  //use only cameras which are active i.e not deleted from ui
  let allActiveCameras = useSelector((state: RootState) => (state.investigation.allCameraNames as Camera[]).filter((cam: Camera) => cam.Active === true));

  let dispatch = useDispatch();

  // setting default values for dates on first render and refresh
  React.useEffect(() => {
    dispatch(coordinatesSelected(null)); //default value null on refresh
  }, []);


  useEffect(() => {
    //used to remove  class "hide-scrollbar" added on monitor/active & spotlight but does not work
    var element = document.getElementById("body-tag");
    if (element) {
      element.classList.remove("hide-scrollbar");
    }
  }, []);

  useRemoveScroll(aIFrames, 'remove-Y-Scroll'); //custom useffect that removes scroll if array empty, here only y scroll removed

  // Convert image from url to Base64 , needed to create svg in ImageBox
  function toDataUrl(url: string, callback: (dataUrl: string | ArrayBuffer | null) => void): void {
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
  }

  //reruns on singleCameraName state change ,  reference image to be used when  camera selected  on dropdown
  useEffect(() => {
    if (!singleCameraName?.isCamera) return;

    setLoader(true);

    const getReferenceImage = async () => {
      try {
        const response = await axiosJWT.get(
          `${VITE_base_url}${import.meta.env.VITE_AREA_OF_INTERESET}${singleCameraName.name}`
        );
        dispatch(fetchAreaOfInterestImage(response.data.image));
      } catch (error) {
        console.error("Failed to fetch reference image", error);
      } finally {
        setLoader(false);
      }
    };

    getReferenceImage();
  }, [singleCameraName, dispatch]);



  // runs on mount
  useEffect(() => {
    populateDropDownOnMount();
  }, []);

  const handleClose = () => {
    setOpen(false);
  };

  const populateDropDownOnMount = useCallback(async (): Promise<void> => {
    try {
      setLoader(true);

      const url = `${VITE_base_url}${import.meta.env.VITE_CAMERAS_LIST}`;
      console.log(url);
      const { data: allCameras } = await axiosJWT.get(url);

      const activeCameras = allCameras.cameras.filter((cam: Camera) => cam.Active === true);

      console.log(activeCameras);
      const firstCamera =
        activeCameras.length > 0 ? activeCameras[0].Camera_Name : t("camera1");


      dispatch(fetchAllCamerasName(allCameras.cameras)); // send arr to redux

      setSingleCameraName({
        name: firstCamera,
        isCamera: allCameras.cameras.length > 0,
      });

      const { data: objOfInterestLabels } = await axiosJWT.get<{
        labels: string[];
      }>(
        `${VITE_base_url}${import.meta.env.VITE_OBJECT_OF_INTEREST_LABELS}`
      );



      setooilabels(objOfInterestLabels.labels);
      dispatch(fetchAllObjectOfInterestLabels(objOfInterestLabels.labels));


      let labelsArr = ["Truck"];
      if (objOfInterestLabels.labels?.length > 0) {
        labelsArr = getLabelsArr(objOfInterestLabels.labels);
      }
      setOILable(labelsArr);
      const currStartDate = getTabsDateString(dates[0].startDate);
      const currEndDate = getTabsDateString(dates[0].endDate);
      console.log(currStartDate, currEndDate);
      const tabStoreCopy = tabStore.map((tab: any, index: number) =>
        index === 0
          ? { ...tab, text: `${currStartDate} - ${currEndDate}` }
          : index === 1
            ? { ...tab, text: `07:00 - 19:00` }
            : index === 2
              ? { ...tab, text: firstCamera }
              : index === 3
                ? { ...tab, text: labelsArr }
                : tab
      );

      setTabStore(tabStoreCopy);
    } catch (ex) {
      console.error("populateDropDownOnMount Error:", ex);
    } finally {
      setLoader(false);
    }
  }, [dates, tabStore]);



  // on submit alert function
  const submitAlert = () => {
    setLoader(true);
    setIsOpen(false);

    //dates[0] -- string date-fns format

    // const currStartDate = moment(dates[0].startDate).format('YYYY-MM-DD');  //the match .format('YYYY-MM-DD') used in mongoDb route
    // const currEndDate = moment(dates[0].endDate).format('YYYY-MM-DD'); //the match .format('YYYY-MM-DD') used in mongoDb route

    const currStartDate = getDateString(dates[0].startDate);
    const currEndDate = getDateString(dates[0].endDate);

    //get array of  object of interest labels state
    let arr: any[] = [];
    if (oILable.length > 0) {
      for (let item of oILable) {
        let text = item.includes('\r') ? item.replace('\r', "") : item;
        arr = [...arr, text];
      }
    }

    const clean_oILable = oILable.map(o =>
      o.replace(/[\r\n]+/g, '').trim().toLowerCase()
    );


    //parameters to be sent
    let params = {
      camera_name: singleCameraName.name,
      // start_date: startDate,
      // end_date: endDate,
      start_date: currStartDate,
      end_date: currEndDate,
      start_time: getTimeString(starTime),
      end_time: getTimeString(endTime),
      object_of_interest: oILable.length > 0 ? clean_oILable : ['person'],  //takes an array of values
      area_of_interest: aIPolygen,  //not mandatory, "area_of_interest": [[1, 22], ...3 more ]
    }

    //isCoordinatesSelected : default value null, unlesss area of interest  selected, then its false or true 

    //validation for isCoordinatesSelected
    if (isCoordinatesSelected === false) {
      //message.error('You have not selected correct coordinates');
      setMessage('You have not selected correct coordinates')
      setOpen(true);
      setTimeout(() => {
        setMessage('Something went wrong. Please try again.')
        setOpen(true);
      }, 2000);
      setLoader(false)
    }
    else if (oILable.length < 1) {
      setMessage('Select at least one object of interest');  // if the user doesnt select any ooi, this message will pop up
      setOpen(true);
      setLoader(false);
    }
    else {
      //get alert images acc to  object of interest array values
      axiosJWT
        .post(
          `${VITE_base_url}${import.meta.env.VITE_OBJECT_OF_INTEREST}`,
          params
        )
        .then(
          (response) => {
            response.data.alert.forEach((e: { image: string; base_url?: string }) => {
              toDataUrl(e.image, async function (myBase64) {
                //Convert image from url to Base64
                e.base_url = await myBase64 as string;
              });
            });
            setTimeout(async () => {
              let arr = response.data.alert.filter((data: { image: string }) => {
                return data.image != "";
              });
              if (response.data.alert.length === 0) {
                setMessage(t("No alerts found"));
                setOpen(true);
              }
              console.log("ooi arr = ", arr);
              setAIFrames(arr);
              setResponseCoordinates(aIPolygen);
              setLoader(false);
            }, 3000);
          },
          (error) => {
            setMessage(error.response.data.message);
            setOpen(true);
            setTimeout(() => {
              setMessage("Something went wrong. Please try again.");
              setOpen(true);
              setLoader(false);
            }, 2000);
          }
        );
    }
  };

  //show more functionality 
  const showMore = useCallback(async () => {
    if (aIFrames.slice(0, itemsToShow.itemsCount).length === aIFrames.length) { //if Show more(100/100) the resets state to initial  to show as 12
      await setItemsToShow({ ...itemsToShow, itemsCount: 12, expanded: false });
    } else {
      await setItemsToShow({ itemsCount: Number(itemsToShow?.itemsCount) + 12, expanded: true }); //increase max items can be shown by 12
    }
  }, [aIFrames, itemsToShow]);

  //modify states starTime and tabStore on change in time in timepicker
  const handleSetStartTime = useCallback((value: Dayjs, index: number) => {
    // value -- time value sent to daysjs
    // index --- index of tabStore array to be modified
    const newStartTime = getTimeString(value);
    const oldEndTime = getTimeString(endTime);
    setStartTime(value); //takes time value without dayjs formatting it

    setTabStore(prev => {
      const newStore = [...prev];
      newStore[index] = {
        ...newStore[index],
        text: `${newStartTime || "07:00"} - ${oldEndTime || "19:00"}`
      };
      return newStore;
    });


  }, [endTime]);

  //modify states endTime and tabStore on change in time in timepicker, same logic as handleSetStartTime
  const handleSetEndTime = useCallback((value: Dayjs, index: number) => {
    const newEndTime = getTimeString(value);
    const oldStarTime = getTimeString(starTime);
    setEndTime(value);

    setTabStore(prev => {
      const newStore = [...prev];
      newStore[index] = {
        ...newStore[index],
        text: `${oldStarTime || "07:00"} - ${newEndTime || "19:00"}`
      };
      return newStore;
    });

  }, [starTime]);

  //modify states  'dates' and 'tabStore' on change in date in datepicker
  const handleDateChange = useCallback((item: RangeKeyDict, index: number) => {
    //console.log('handleDateChange', item, index);
    const selection = item.selection;
    if (!selection.startDate || !selection.endDate) return; // exit if dates are undefined

    const newDateRange: StrictDateRange = {
      startDate: selection.startDate,
      endDate: selection.endDate,
      key: selection.key || "selection",
    };
    setDates([newDateRange]); //change date state

    const currStartDate = getTabsDateString(selection.startDate)
    const currEndDate = getTabsDateString(selection.endDate);

    setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${currStartDate} - ${currEndDate}`; // Update the date string in the tab
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });
    //console.log('handleDateChange ---  tabStoreCopy', tabStoreCopy);
  }, []);
  //handle active css 
  const handleChangeActiveCss = useCallback((index: number) => {
    setTabStore(prev => prev.map((tab, i) => ({
      ...tab,
      active: i === index
    })));

    //console.log('handleChangeActiveCss ---  tabStoreCopy', tabStoreCopy);
  }, []);

  //modify state  'singleCameraName' and 'tabStore' on change in date in camera dopdown 
  const handleCameraChange = useCallback((camera: string, atIndex: number) => {
    //atIndex ---> will be 2 always cause that the index in tabstore
    setSingleCameraName({
      name: camera,
      isCamera: true,
    });

    setTabStore(prev => prev.map((tab, i) =>
      i === atIndex ? { ...tab, text: camera } : tab
    ));

  }, [tabStore]);

  console.log('aIFrames = = ', aIFrames)
  // html rendered
  return (
    <>
      <div className="objectOfInterest autoalert-search-bar">
        <Messagebox open={open} handleClose={handleClose} message={message} />

        {/* Desktop Search */}
        <div className="search-bar desktop">
          <div className="main-content">
            {tabStore.map((tab: any, index: number) => {
              switch (tab.heading) {
                case "Date*":
                  return (
                    <DatePickerPopover
                      key={`desktop-date-${index}`}
                      heading={t("Date*")}
                      text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                      active={tab.active}
                      index={index}
                      dates={dates}
                      onDateChange={handleDateChange}
                      onChangeActiveCss={handleChangeActiveCss}
                      mobile={false}
                    />
                  );
                case "Time*":
                  return (
                    <TimePickerPopover
                      key={`desktop-time-${index}`}
                      heading={t("Time*")}
                      text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                      active={tab.active}
                      index={index}
                      onChangeActiveCss={handleChangeActiveCss}
                      starTime={starTime}
                      endTime={endTime}
                      setStartTime={handleSetStartTime}
                      setEndTime={handleSetEndTime}
                      mobile={false}
                    />
                  );
                case "Camera*":
                  return (
                    <CameraPopover
                      key={`desktop-camera-${index}`}
                      heading={t("Camera*")}
                      text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                      active={tab.active}
                      index={index}
                      selectedCamera={singleCameraName.name}
                      onChangeActiveCss={handleChangeActiveCss}
                      onCameraChange={handleCameraChange}
                      allActiveCameras={allActiveCameras}
                      mobile={false}
                    />
                  );
                case "Object of Interest*":
                  return (
                    <Truck
                      key={`desktop-truck-${index}`}
                      heading={t("Object of Interest*")}
                      text={tab.text}
                      active={tab.active}
                      index={index}
                      setTabStore={setTabStore}
                      tabStore={tabStore}
                      setOILable={setOILable}
                      mobile={false}
                      ooiLabels={ooiLabels.map(label => t(label))}
                      isOpen={isOpen}
                      setIsOpen={setIsOpen}
                      menuRef={menuRef}
                    />
                  );
                case "Area of Interest*":
                  return (
                    <AreaOfInterest
                      key={`desktop-area-${index}`}
                      heading={t("Area of Interest*")}
                      text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                      active={tab.active}
                      index={index}
                      onChangeActiveCss={handleChangeActiveCss}
                      setAIPolygen={setAIPolygen}
                      mobile={false}
                    />
                  );
                default:
                  return null;
              }
            })}
          </div>
          <SearchIcon className="searchIcon" onClick={submitAlert} />
        </div>

        {/* Mobile Search
      <div className="mobile-search">
        {tabStore.map((tab: any, index: number) => {
          const commonProps = {
            key: `mobile-${index}`,
            heading: tab.heading,
            text: tab.text,
            active: tab.active,
            index,
            mobile: true,
          };

          switch (tab.heading) {
            case "Date*":
              return (
                <div className="single_item" key={`mobile-date-${index}`}>
                  <label>Date <span>*</span></label>
                  <DatePickerPopover
                    {...commonProps}
                    text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                    dates={dates}
                    onDateChange={handleDateChange}
                    onChangeActiveCss={handleChangeActiveCss}
                  />
                </div>
              );
            case "Time*":
              return (
                <div className="single_item" key={`mobile-time-${index}`}>
                  <label>Time <span>*</span></label>
                  <TimePickerPopover
                    {...commonProps}
                    text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                    onChangeActiveCss={handleChangeActiveCss}
                    starTime={starTime}
                    endTime={endTime}
                    setStartTime={handleSetStartTime}
                    setEndTime={handleSetEndTime}
                  />
                </div>
              );
            case "Camera*":
              return (
                <div className="single_item" key={`mobile-camera-${index}`}>
                  <label>Select Camera <span>*</span></label>
                  <CameraPopover
                    {...commonProps}
                    text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                    selectedCamera={singleCameraName.name}
                    onChangeActiveCss={handleChangeActiveCss}
                    onCameraChange={handleCameraChange}
                    allActiveCameras={allActiveCameras}
                  />
                </div>
              );
            case "Object of Interest*":
              return (
                <div className="single_item" key={`mobile-ooi-${index}`}>
                  <label>Select <span>*</span></label>
                  <Truck
                    {...commonProps}
                    setTabStore={setTabStore}
                    tabStore={tabStore}
                    setOILable={setOILable}
                    ooiLabels={ooiLabels}
                    isOpen={isOpen}
                    setIsOpen={setIsOpen}
                    menuRef={menuRef}
                  />
                </div>
              );
            case "Area of Interest":
              return (
                <div className="single_item" key={`mobile-area-${index}`}>
                  <label>Select Area Of Interest</label>
                  <AreaOfInterest
                    {...commonProps}
                    text={Array.isArray(tab.text) ? tab.text.join(", ") : tab.text}
                    onChangeActiveCss={handleChangeActiveCss}
                    setAIPolygen={setAIPolygen}
                  />
                </div>
              );
            default:
              return null;
          }
        })}
        <button className="search-button" onClick={submitAlert}>
          <i className="bx bx-search"></i> Search
        </button>
      </div> */}

        {/* Results */}
        <div className="container-fluid">
          <div className="row mt-5">
            <div className="my_alert_not_found">
              {aIFrames.length === 0 && <NotFound />}
            </div>

            {loader ? (
              <Box sx={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)" }} >
                <CircularProgress />
              </Box>
            ) : (
              aIFrames.slice(0, itemsToShow.itemsCount).map((data, i) =>
                data.image ? (
                  <div
                    key={i}
                    className="col-lg-4 col-xl-4 col-md-6 col-sm-12 col-xs-12 mb-3 px-2 image-container"
                  >
                    <Suspense fallback={<div>Loading</div>}>
                      <ImageBox data={data} aIPolygen={responseCoordinates} />
                    </Suspense>
                  </div>
                ) : null
              )
            )}
          </div>
        </div>

        {/* Show More / Less */}
        {aIFrames.length > 0 && (
          <div className="show-more-info">
            <a className="btn-color" onClick={showMore}>
              {aIFrames.slice(0, itemsToShow.itemsCount).length < aIFrames.length ? (
                <span>
                  {t("Show more")} ({aIFrames.slice(0, itemsToShow.itemsCount).length}/{aIFrames.length})
                </span>
              ) : (
                <span>
                  {t("Show less")}({aIFrames.slice(0, itemsToShow.itemsCount).length}/{aIFrames.length})
                </span>
              )}
            </a>
          </div>
        )}
      </div>
    </>
  );

};

export default ObjectOfInterest;
