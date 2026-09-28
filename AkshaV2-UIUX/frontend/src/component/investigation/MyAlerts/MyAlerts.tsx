
import React, { useState, useEffect, useRef, useCallback } from "react";
import { RangeKeyDict } from 'react-date-range';
import { useDispatch, useSelector } from "react-redux";
//import { message, Spin } from "antd";
import axiosJWT from "../../../context/axiosAuthIntercept";
import moment from 'moment';
import dayjs, { Dayjs } from 'dayjs'; //formats time like moment.js
import SearchIcon from "@mui/icons-material/Search";
import { subMonths, subDays } from "date-fns";

import { fetchAllCamerasName } from "../../../global_store/reducers/investigationReducer";

import DatePickerPopover from "../../common/DatePickerPopover";
import CameraPopover from "../../common/CameraPopover";
import TimePickerPopover from "../../common/TimePickerPopover";
import NotFound from "../../common/NotFound"; //show not found if no data present
import useRemoveScroll from "../../../hooks/useRemoveScroll"; //custom useffect that removes scroll
import getTimeString from "../../../utils/getTimeString"; //used to geTime in string format like '10:00', '07:09'
import './styles/auto_alert.scss'
import getDateString from "../../../utils/getDateString";
import getTabsDateString from "../../../utils/getTabsDateString";
import sortImagesByDesc from "../../../utils/sortImagesByDesc";
import Stack from '@mui/material/Stack';
import ImageModel from "../../common/ImageModel";
//import Button from '@mui/material/Button';
import Messagebox from "../../common/Messagebox";
import { CircularProgress } from '@mui/material';
import Box from '@mui/material/Box';
import ChatPopover from "../ChatPopover/ChatPopover";
import { RootState } from "global_store/store";
import { useTranslation } from "react-i18next";
// define base url
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;


interface Camera {
  Camera_Name: string;
  Active: boolean;
}

interface AlertResponse {
  image: string;
  images: string[];

}

type DateRange = {
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


// main component
const MyAlerts: React.FC = () => {

  const {t} = useTranslation();

  const searchTabs: TabItem[] = [
  { id: 1, heading: "Date*", text: t("Select Date"), active: false },
  { id: 2, heading: "Time*", text: t("Select Time"), active: false },
  { id: 3, heading: "Camera*", text: t("Select Camera"), active: false },
];

  let dispatch = useDispatch();
  const modalRef = useRef<HTMLDialogElement>(null);

  //use only cameras which are active i.e not deleted from ui, gets the updated cameras list from redux reducer 'investigationReducer' state 'investigation.allCameraNames '
  const allActiveCameras = useSelector((state : RootState) => state.investigation.allCameraNames.filter(cam => cam.Active === true));

  const [singleCameraName, setSingleCameraName] = useState<string>("");  //current camera name selected
  const [tabStore, setTabStore] = useState<TabItem[]>(searchTabs); //tabs array to be shown in ui
  //goes to timepicker, default state to be send to timepicker
  const [starTime, setStartTime] = useState<Dayjs>(dayjs().set('hour', 7).set('minute', 0));
  const [endTime, setEndTime] = useState<Dayjs>(dayjs().set('hour', 19).set('minute', 0));
  const [loader, setLoader] = useState<boolean>(false);
  const [aIFrames, setAIFrames] = useState<any[]>([]);  //data to be displayed
  const [itemsToShow, setItemsToShow] = useState<{expanded:boolean,itemsCount:number}>({ expanded: true, itemsCount: 12 });
  const [arrImages, setArrImages] = useState([]);
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const onOpenModal = () => setOpen(true);
  const onCloseModal = () => setOpen(false);
  const [imgUrl, setImgUrl] = useState<string>("");
  const [imageLoader, setImageLoader] = useState<boolean>(false);
  const [base64Image, setBase64Image] = useState<String>('');
  const [cameraList, setCameraList] = useState<CameraItem[]>([]);

  
  const handleClose = () => {
    setOpen(false);
  };

  //goes to datepicker, default state to be send to datepicker
  const [dates, setDates] = useState<DateRange[]>([
    {
      startDate: subDays(new Date(), 7),
      endDate: new Date(),
      key: "selection",
    },]
  );

  function toDataUrl(url:string, callback :  (result: string | null) => void): void  {
    var xhr = new XMLHttpRequest();
    xhr.onload = function () {
      var reader = new FileReader();
      reader.onloadend = function () {
        callback(reader.result as string);
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.send();
  }

  // creating AOI (Area of Interest) image, found unused
  // function toDataUrl(url, callback) {
  //   var xhr = new XMLHttpRequest();
  //   xhr.onload = function () {
  //     var reader = new FileReader();
  //     reader.onloadend = function () {
  //       callback(reader.result);
  //     };
  //     reader.readAsDataURL(xhr.response);
  //   };
  //   xhr.open("GET", url);
  //   xhr.responseType = "blob";
  //   xhr.send();
  // }


  // get the current list of alerts on search click in ui
  const getAlertList = ():void => {
    setLoader(true);

    // const currStartDate = moment(dates[0].startDate).format('YYYY-MM-DD');  //the match .format('YYYY-MM-DD') used in mongoDb route
    // const currEndDate = moment(dates[0].endDate).format('YYYY-MM-DD'); //the match .format('YYYY-MM-DD') used in mongoDb route
 const currStartDate = getTabsDateString(dates[0].startDate);
      const currEndDate = getTabsDateString(dates[0].endDate);
    axiosJWT
      .post(`${VITE_base_url}${import.meta.env.VITE_MYALERTS}`, {
        Camera_Name: singleCameraName,
        // Start_Date: startDate,
        // End_Date: endDate,
        Start_Date: currStartDate,
        End_Date: currEndDate,
        Start_Time: getTimeString(starTime),
        End_Time: getTimeString(endTime),
      })
      .then(
        (response) => {
          console.log(response.data);
          if (response.data.alert.length === 0) {
            //message.warn('No alerts found.');
            setMessage(t("No alerts found"));
            setOpen(true);
          }
          //used for creating area of interest image , found unused, removed cause giving error
          // response.data.alert.forEach((e) => {
          //   if (e.image != null || e.image !== '') {
          //     toDataUrl(e.image, async function (myBase64) {
          //       e.base_url = await myBase64; // found unused
          //       e.Results = e.Object_Area.flat(1);  //found unused
          //     });
          //   }
          // });
          let arr = response.data.alert.filter((data: AlertResponse) => {
            return data.image != "";
          });
          const imagesArray = arr.map((item : AlertResponse) => item.images);
          setTimeout(() => {
            setAIFrames(arr); //populate state with alert data
            const arrayImages = aIFrames.map((item) => item.images); //to get images data
            setArrImages(arrayImages[0]);
            setLoader(false);
          }, 1000);
        },
        (error) => {
          setMessage(error.response.data.message);
          setOpen(true);
          setLoader(false);
        }
      );
  };

  //modify states starTime and tabStore on change in time in timepicker
  const handleSetStartTime = useCallback((value: Dayjs, index: number) : void => {
    // value -- time value sent to daysjs
    // index --- index of tabStore array to be modified
    const newStartTime = getTimeString(value);
    const oldEndTime = getTimeString(endTime);
    setStartTime(value);   //takes time value without dayjs formatting it

   setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${newStartTime || "07:00"} - ${oldEndTime || "19:00"}`;
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });

  }, [endTime]);

  const convertBase64 = (img: string) => {
  toDataUrl(img, (myBase64: string | null) => {
    if (myBase64) {
      setBase64Image(myBase64);
    } else {
      console.error("Base64 conversion failed, received null.");
    }
  });
};


  //modify states endTime and tabStore on change in time in timepicker, same logic as handleSetStartTime
  const handleSetEndTime = useCallback((value:Dayjs, index: number) : void => {
     if (!value) return;
    const newEndTime = getTimeString(value);
    const oldStartTime = getTimeString(starTime);
    setEndTime(value);

   setTabStore((prevTabStore) => {
      const tabStoreCopy = [...prevTabStore];
      const obj = { ...tabStoreCopy[index] };
      obj.text = `${oldStartTime || "07:00"} - ${newEndTime || "19:00"}`;
      tabStoreCopy[index] = obj;
      return tabStoreCopy;
    });
   

  },[starTime]);

  //modify states  'dates' and 'tabStore' on change in date in datepicker
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
  const handleChangeActiveCss = useCallback((index: number): void => {
    setTabStore((prevTabStore) =>
      prevTabStore.map((tab, i) => ({
        ...tab,
        active: i === index, // Set active true only for the clicked tab
      }))
    );
  }, []);

  //modify state  'singleCameraName' and 'tabStore' on change in date in camera dopdown 
  const handleCameraChange = useCallback((camera: string, atIndex:number) => {
    //atIndex ---> will be 2 always cause that the index in tabstore
    console.log(camera);
    setSingleCameraName(camera);

    setTabStore((prevTabStore) =>
      prevTabStore.map((tab, index) =>
        index === atIndex ? { ...tab, text: camera } : tab
      )
    );
    console.log("handleCameraChange", atIndex, tabStore);
  }, [tabStore]);

  const showMore = useCallback(async () :Promise<void>=> {
    const arrayImages = aIFrames.map((item)=>item.images)
    const arrImages = arrayImages[0]
    if (arrImages.slice(0, itemsToShow.itemsCount).length === arrImages.length) { //if Show more(100/100) the resets state to initial  to show as 12
      await setItemsToShow({ ...itemsToShow, itemsCount: 12, expanded: false });
    } else {
      await setItemsToShow({ itemsCount: Number(itemsToShow?.itemsCount) + 12, expanded: true }); //increase max items can be shown by 12
    }
  },[arrImages,itemsToShow]);


  //set default values
const populateDropDownOnMount = useCallback(async (): Promise<void> => {
    try {
      setLoader(true);
      const url = `${VITE_base_url}${import.meta.env.VITE_CAMERAS_LIST}`;
      const { data: camData } = await axiosJWT.get<{ cameras: Camera[] }>(url);

      // Filter for active cameras
      const activeCameras = camData.cameras.filter((cam) => cam.Active === true);
      const firstCamera = activeCameras.length > 0 ? activeCameras[0].Camera_Name : t("camera1");

      setCameraList(activeCameras);
      setSingleCameraName(firstCamera); // Set the default selected camera

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
      setLoader(false);
    }
  }, [dates, tabStore]); // Added dependencies: dates and tabStore

  const openImageLoader = () => {
    setImageLoader(true);
  };

  const checkGenAIstatus = async (image : string) => {
    let url = `${VITE_base_url}${import.meta.env.VITE_GET_EMAIL_DETAILS}`;
    let gen_ai_features = false;
    await axiosJWT.get(url).then((res) => {
      if (res.data.success == true) {
        gen_ai_features = res.data.genai_features;
        //setGenAIfeatures(gen_ai_features);
      }})
      setImgUrl(image);
      
      if(gen_ai_features){
      convertBase64(image);
      setImageLoader(false);
      if (modalRef.current) {
        modalRef.current.showModal();
      }
    }
    else{
      setImgUrl(image);
      openImageLoader();
    }
  }

  // runs on first render
  useEffect(() => {
    //used to remove  class "hide-scrollbar" added on monitor/active & spotlight but does not work
    var element = document.getElementById("body-tag");
    if (element) {
  element.classList.remove("hide-scrollbar");
}

    populateDropDownOnMount(); //get default values
  }, []);
  useRemoveScroll(aIFrames);
  // jsx rendered
  return (
    <div className="auto-alert autoalert-search-bar">
      <Messagebox
        open={open}
        handleClose={handleClose}
        message={message}
      />
      <div className=" search-bar desktop">
        <div className="main-content">
          {tabStore.map((tab, index) => { //tab design for desktop, custom code and css used 
            if (tab.heading === "Date*") {
              return (
                <DatePickerPopover
                key={tab.id} 
                  heading={t("Date*")}
                  text={tab.text}
                  active={tab.active}
                  index={index} //index of tabs array to be modified
                  dates={dates}
                  onDateChange={handleDateChange}
                  onChangeActiveCss={handleChangeActiveCss}
                  mobile={false} //change  tabs text or heading shown based on this value
                />
              );
            } else if (tab.heading === "Time*") {
              return (
                <TimePickerPopover
                key={tab.id}
                  heading={t("Time*")}
                  text={tab.text}
                  active={tab.active}
                  index={index}
                  starTime={starTime}
                  endTime={endTime}
                  setStartTime={handleSetStartTime}
                  setEndTime={handleSetEndTime}
                  onChangeActiveCss={handleChangeActiveCss}
                  mobile={false}
                />
              );
            } else if (tab.heading === "Camera*") {
              return (
                <CameraPopover
                key={tab.id}
                  heading={t("Camera*")}
                  text={tab.text}
                  active={tab.active}
                  index={index}
                  selectedCamera={singleCameraName}
                  onChangeActiveCss={handleChangeActiveCss}
                  onCameraChange={handleCameraChange}
                  allActiveCameras={cameraList} //list of camera to be shown in dropdown
                  mobile={false}
                />

              );
            }
          })}
        </div>

        <SearchIcon
          className="searchIcon"
          onClick={getAlertList}
        />
      </div>

      {/* <div className='mobile-search'>
        {tabStore.map((tab, index) => {
          if (tab.heading === "Date*") {
            return (
              //tabs design for mobile
              <div className="single_item">
                <label>Date <span >*</span></label>
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
              <div className="single_item">
                <label>Time <span >*</span></label>
                <TimePickerPopover
                  heading={tab.heading}
                  text={tab.text}
                  active={tab.active}
                  index={index}
                  starTime={starTime}
                  endTime={endTime}
                  setStartTime={handleSetStartTime}
                  setEndTime={handleSetEndTime}
                  onChangeActiveCss={handleChangeActiveCss}
                  mobile={true}
                />
              </div>
            );
          } else if (tab.heading === "Camera*") {
            return (
              <div className="single_item">
                <label>Select Camera <span >*</span></label>
                <CameraPopover
                  heading={tab.heading}
                  text={tab.text}
                  active={tab.active}
                  index={index}
                  selectedCamera={singleCameraName}
                  onChangeActiveCss={handleChangeActiveCss}
                  onCameraChange={handleCameraChange}
                  allActiveCameras={allActiveCameras} //list of camera to be shown in dropdown
                  mobile={true}
                />
              </div>
            );
          }
        })}
        <button
          className="search-button"
          onClick={getAlertList}  //get list of alert images to be shown in ui
        >
          <i className='bx bx-search'></i>
          Search
        </button>
      </div> */}

      <ChatPopover modalRef={modalRef} imgUrl={imgUrl} base64Image={base64Image} setImgUrl={setImgUrl} />

      <div className="mb-3 px-2 " >
        <div className="container-fluid">
          <div className="row mt-5">

            <div className="my_alert_not_found">

              {aIFrames.length === 0 && <NotFound />}

            </div>
            <div>
            {loader ? (
              <Box
              sx={{
                position: "absolute",
                  top: "50%" ,
                  left: "50%" ,
                  transform: "translate(-50%, -50%)" }}   
              >
             <CircularProgress />
              </Box>
              ) : (
                <>
                {aIFrames.map((data, i) => {
                  return (
                    <div className="row mt-2 mx-0 rowCls" //row used to allow css styling
                      key={i}
                    >
                      <div className="container-fluid">
                        <div className="gridCls row" //display alert images array
                        >
                          {data.images?.length > 0 &&
                            sortImagesByDesc(data.images).slice(0, itemsToShow.itemsCount) //sort images by desc order
                              .map((image, index) =>
                                <div className='col-lg-4 col-md-6 col-sm-12 col-xs-12 col-xl-4' key={index} >
                                  <div>
                                  <img
                                    alt="camera img"
                                    crossOrigin="anonymous"  // attribute specifies that the img element supports CORS
                                    src={image}
                                    className="myAlertCss w-100"
                                    onClick={() => {
                                      //sets the state for the "ImageModel" to use
                                      checkGenAIstatus(image);
                                    }}
                                  />
                                </div>
                                </div>
                              )}
                        </div>
                      </div>
                      {(imgUrl && imageLoader) && (
                      <ImageModel        //only if "imgUrl" is truthy show ImageModel dialog component
                        open={imageLoader}
                        setOpen={setImageLoader}
                        imgUrl={imgUrl}
                      />
                    )}
                      {/* <Stack spacing={2} direction="row" className="show-more-info">
      
                        <Button className="btn-color" variant="outlined" onClick={showMore}>Show More ({data.images.length})</Button>
                      </Stack> */}
                      {data.images &&
          data.images.length > 0 && <a className="show-more-info" onClick={showMore}>
            {data.images.slice(0, itemsToShow.itemsCount).length < data.images.length ? (  //shows increasing each time by 12
              <button className="btn-color">{t("Show more")} ({data.images.slice(0, itemsToShow.itemsCount).length}/{data.images.length})</button>
            ) : (
              //resets to show only 12
              <button className="btn-color">{t("Show less")} ({data.images.slice(0, itemsToShow.itemsCount).length}/{data.images.length})</button>
            )}
          </a>}
                    </div>
                  )
                })}
              </>
      )}
            </div>
          </div>
        </div>
        
      </div>

    </div>
  );
  
  
};

export default MyAlerts;
