import React, { useState, useEffect, useCallback } from "react";
import axiosJWT from "../../../context/axiosAuthIntercept";
import dayjs, { Dayjs } from "dayjs";
import { useSelector } from "react-redux";
import "simplebar/src/simplebar.css";
import AlertConfigurationModal from './AlertConfigurationModal'; // Ensure this path is correct and it's also a TSX component
import { Select, Tooltip } from "@mui/material";
import "./Alerts.css";
import AlertListComponent from "./AlertListComponent"; // Ensure this path is correct and it's also a TSX component
import ViewAlertDialog from './ViewAlertDialog'; // Ensure this path is correct and it's also a TSX component
import { t } from "i18next";
import alertIcon from "../../../assets/images/Rectangle 170@2x.png";




/**
 * Interface for the structure of a week day object.
 * @interface Week
 */
interface Week {
  id: number;
  name: string;
  value: string;
  selected: boolean;
}

/**
 * Interface for the structure of a camera object.
 * @interface Camera
 */
interface Camera {
  _id: string;
  Camera_Name: string;
  Active: boolean;
  image?: string; // Optional, as not all cameras might have an image property immediately
  rtsp_id?: number;
  rtsp_link?: string;
  fps?: number;
  // "standard" | "ppe" | "jewelry" — selects which labels_{type}.txt the
  // Object of Interest dropdown reads from (see getoobjectofinterestlabels).
  Detection_Type?: string;
  // Add other properties of camera objects if known
}

/**
 * Interface for the structure of an alert object.
 * @interface Alert
 */
interface Alert {
  _id?: string | any;
  Alert_Name: string;
  Camera_Name: string;
  [key: string]: any; // Can be a complex type, defining as 'any' for now.
  // Add other properties of alert objects if known
}

/**
 * Props for the Alerts component.
 * @interface AlertsProps
 */
interface AlertsProps {
  calledInsideMenu?: boolean;
  camera_name?: string;
  camera_link?: string;
  fps?: number;
  setMessage?: any;
  setOpen?: any;
  setWarning?: any;
  setdata?: any; // Optional callback for data refresh
  pageType?: string; // Prop for AlertListComponent
}

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Alerts functional component for managing and displaying alerts.
 * It provides functionality for adding, editing, viewing, and managing alert statuses.
 * @param {AlertsProps} props - The properties passed to the component.
 * @returns {JSX.Element} The rendered Alerts component.
 */
const Alerts: React.FC<AlertsProps> = (props) => {
  console.log("props.pagetype", props.pageType);
  const { calledInsideMenu, camera_name, camera_link, fps, setMessage, setOpen, setWarning, setdata } = props;

  // State variables for the component
  const [isClose, setIsClose] = useState<boolean>(false);
  const [alertlist, setAlertlist] = useState<Alert[]>([]);
  const [viewCameraImg, setViewCameraImg] = useState<any[]>([]); // Not explicitly used but kept for consistency
  const [tableloader, setTableloader] = useState<boolean>(true);
  const [formloader, setFormloader] = useState<boolean>(false); // Not explicitly used but kept for consistency
  const [modalopened, setModalopened] = useState<string>("");
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(false);
  const [isOpen, setIsOpen] = useState<boolean>(false); // Used for general message box
  const [messageState, setMessageState] = useState<string>(""); // Internal message state, distinct from props.setMessage
  const [weeks, setWeeks] = useState<Week[]>([
    { id: 1, name: "Mon", value: "Monday", selected: true },
    { id: 2, name: "Tue", value: "Tuesday", selected: true },
    { id: 3, name: "Wed", value: "Wednesday", selected: true },
    { id: 4, name: "Thu", value: "Thursday", selected: true },
    { id: 5, name: "Fri", value: "Friday", selected: true },
    { id: 6, name: "Sat", value: "Saturday", selected: true },
    { id: 7, name: "Sun", value: "Sunday", selected: true },
  ]);
  const [activeStep, setActiveStep] = useState<number>(0);
  const [selectedCamera, setSelectedCamera] = useState<any>([]);
  const [selectedObjectofInter, setSelectedObjectofInter] = useState<string>("person");
  const [No_Object_Status, setNo_Object_Status] = useState<boolean>(true);
  const [selectedfrequency, setSelectedfrequency] = useState<string>("Daily");
  const [selecteButttonDay, setSelecteButttonDay] = useState<string>("Working Day");
  const [cameralist, setCameralist] = useState<Camera[]>([]);
  const [alert_name, setAlert_name] = useState<string>("");
  const [alert_description, setAlert_description] = useState<string>("");
  const [props_camera, setProps_camera] = useState<string>("");
  const [start_time, setStart_time] = useState<Dayjs>(dayjs().set("hour", 7).set("minute", 0));
  const [end_time, setEnd_time] = useState<Dayjs>(dayjs().set("hour", 19).set("minute", 0));
  const [viewmodalstatus, setViewmodalstatus] = useState<boolean>(false);
  const [viewdata, setViewdata] = useState<any>({});
  const [alert_status, setAlert_status] = useState<string>("");
  const [display_activation, setDisplay_activation] = useState<boolean | string>(""); // Can be boolean or string based on usage
  const [email_activation, setEmail_activation] = useState<boolean | string>(""); // Can be boolean or string based on usage
  const [edit_alert_id, setEdit_alert_id] = useState<string>("");
  const [camera_img, setCamera_img] = useState<string>("");
  const [add_camera_img, setAdd_camera_img] = useState<string[]>([]);
  const [aipollygon, setAipollygon] = useState<any>([]); // Define a more specific type if possible
  const [listofobjectlabels, setListofobjectlabels] = useState<string[]>([]);
  const [viewimagedata, setViewimagedata] = useState<any | {}>({}); // Define a more specific type if possible
  const [noAvailableStatus, setNoAvailableStatus] = useState<boolean>(false);
  const [listOfCamera, setListOfCamera] = useState<Camera[]>([]);
  const [working_day, setWorking_day] = useState<boolean>(true);
  const [holiday, setHoliday] = useState<boolean>(false);
  const [actionButton, setActionButton] = useState<string>("form-button-group alert-modal-action-button-main-div-0");
  const [cameraName, setCameraName] = useState<string>(""); // Not explicitly used but kept for consistency
  const [editImageAOI, setEditImageAOI] = useState<boolean>(false);
  const [modalStatus, setModalStatus] = useState<boolean>(false);
  const [submittype, setSubmittype] = useState<string>("");
  const [isCheckboxHidden, setIsCheckboxHidden] = useState<number>(0);
  const [screenType, setScreenType] = useState<string>("Desktop");

  // Redux state
  const is_mobile = useSelector((state: any) => state.isMobileDevice.is_mobile); // Type `state` according to your Redux store shape

  /**
   * Initializes component state based on `calledInsideMenu` and `camera_name` props.
   * Also sets the screen type based on Redux `is_mobile` state.
   */
  useEffect(() => {
    if (calledInsideMenu === true) {
      setProps_camera(camera_name || ""); // Ensure it's a string
    } else {
      setModalStatus(false);
    }
    if (is_mobile) {
      setScreenType("Mobile");
    }
  }, [calledInsideMenu, camera_name, is_mobile]);

  /**
   * Converts an image URL to a base64 data URL.
   * @param {string} url - The URL of the image.
   * @param {(base64: string) => void} callback - The callback function to receive the base64 string.
   */


  const toDataUrl = useCallback((url: string, callback: any) => {
    var xhr = new XMLHttpRequest();
    xhr.onload = function () {
      var reader = new FileReader();
      reader.onloadend = function () {
        callback(reader.result);
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.send();
  }, []);

  /**
   * Fetches the list of alerts for the currently selected camera.
   * Sets `tableloader` to true during fetch and false afterwards.
   * Updates `alertlist` and `noAvailableStatus`.
   */
  const getalertlist = useCallback(() => {
    if (!props_camera) return;
    const url = `${VITE_base_url}${import.meta.env.VITE_ALERT}${props_camera}`;
    setTableloader(true);
    axiosJWT
      .get(url)
      .then((response) => {
        if (response.data.success === true) {
          setAlertlist(response.data.alerts.reverse());
          setNoAvailableStatus(true);
        } else {
          setNoAvailableStatus(true);
        }
      })
      .catch((error) => {
        console.error("Error fetching alert list:", error);
      })
      .finally(() => {
        setTableloader(false);
      });
  }, [props_camera]);

  /**
   * Fetches the list of active cameras.
   * Optionally restarts surveillance for a selected camera.
   * @param {string} [selectedCam=""] - The name of the selected camera.
   * @param {boolean} [rerun_servilence=false] - Whether to rerun surveillance.
   */
  const getcameralist = useCallback(async (selectedCam: string = "", rerun_servilence: boolean = false) => {
    try {
      setTableloader(true);
      const { data } = await axiosJWT.get<{ cameras: Camera[] }>(`${VITE_base_url}${import.meta.env.VITE_CAMERA}`);
      const activeCams = data.cameras.filter((cam) => cam.Active === true);
      setCameralist(activeCams.reverse());
      if (selectedCam.length > 0 && rerun_servilence === true) {
        // start_servilence(_selectedCamera, activeCams.reverse()); // commented in original
      }
    } catch (ex) {
      console.error("Error fetching camera list:", ex);
    } finally {
      setTableloader(false);
    }
  }, []);

  /**
   * Fetches the image for the specified camera(s).
   * @param {string[] | null} type - An array of camera names, or null to use `props_camera`.
   */
  const getimagebycameraname = useCallback(async (type: string[] | null) => {
    setTableloader(true);
    const camera_names = type ? type : [props_camera];
    //  console.log("Props camera:", camera_names);
    let arr: string[] = [];
    for (let i = 0; i < camera_names.length; i++) {

      const url = `${VITE_base_url}${import.meta.env.VITE_AREA_OF_INTERESET}${camera_names[i]}`;
      try {
        // console.log(url);
        const response = await axiosJWT.get<{ success: boolean; image: string }>(url);
        if (response.data.success === true) {
          // console.log(response.data.image);
          arr.push(response.data.image);
          setCamera_img(response.data.image);
          setAdd_camera_img(arr);
        }
      } catch (error) {
        console.error("Error fetching camera image:", error);
      } finally {
        setTableloader(false);
      }
    }
  }, [props_camera]);

  /**
   * Fetches the list of object of interest labels from the backend.
   */
  const getoobjectofinterestlabels = useCallback((useCase?: string) => {
    const base = `${VITE_base_url}${import.meta.env.VITE_OBJECT_OF_INTEREST_LABELS}`;
    const url = useCase ? `${base}?use_case=${encodeURIComponent(useCase)}` : base;
    axiosJWT.get<{ success: boolean; labels: string[] }>(url).then((res) => {
      if (res.data.success === true) {
        const arr = res.data.labels.map((item) => item.replace("\r", ""));
        setListofobjectlabels(arr);
      }
    });
  }, []);

  /**
   * Mimics `componentDidMount` to fetch initial data.
   * Fetches camera list, object of interest labels, alert list, and camera image.
   */
  useEffect(() => {
    getcameralist();
    getoobjectofinterestlabels();
    if (camera_name) {
      setProps_camera(camera_name);
      getalertlist();
      getimagebycameraname([camera_name]); // ✅ pass directly instead of null
    }

  }, [camera_name, getcameralist, getalertlist, getimagebycameraname, getoobjectofinterestlabels]);

  /**
   * Re-fetches the Object of Interest list whenever the selected camera
   * changes, using that camera's Detection_Type ("standard" | "ppe" |
   * "jewelry") to pick labels_{type}.txt instead of the generic labels.txt.
   */
  useEffect(() => {
    if (selectedCamera.length === 0 || cameralist.length === 0) return;
    const cam = cameralist.find((c) => c.Camera_Name === selectedCamera[0]);
    const detectionType = cam?.Detection_Type;
    getoobjectofinterestlabels(detectionType && detectionType !== "standard" ? detectionType : undefined);
  }, [selectedCamera, cameralist, getoobjectofinterestlabels]);

  /**
   * Displays the add alert modal and resets its state to default values for a new alert.
   */
  const handleShow = useCallback(() => {
    setModalStatus(true);
    setSubmittype("add");
    setActiveStep(0);
    setSelectedCamera([props_camera]);
    setModalopened("");
    setAlert_name("");
    setAlert_description("");
    setSelectedObjectofInter("person");
    setNo_Object_Status(true);
    setSelecteButttonDay("Holiday");
    setStart_time(dayjs().set("hour", 7).set("minute", 0));
    setEnd_time(dayjs().set("hour", 19).set("minute", 0));
    setAlert_status("");
    setDisplay_activation("");
    setEmail_activation("");
    setWeeks((prevWeeks) => prevWeeks.map((week) => ({ ...week, selected: true })));
    setIsClose(false);
    setIsCheckboxHidden(0);
    setActionButton("form-button-group alert-modal-action-button-main-div-0");
    if (calledInsideMenu === false) {
      getimagebycameraname([props_camera]);
    }
  }, [calledInsideMenu, props_camera, getimagebycameraname]);

  /**
   * Sets the `isClose` state to true, indicating the modal is about to close.
   */
  const beforeHandleClose = useCallback(() => {
    setIsClose(true);
  }, []);

  /**
   * Closes the alert configuration modal and resets related states.
   */
  const handleClose = useCallback(() => {
    beforeHandleClose();
    setModalStatus(false);
    setSubmittype("");
    setEditImageAOI(false);
  }, [beforeHandleClose]);

  /**
   * Closes the message box. (Note: `isOpen` and `messageState` are internal states,
   * while `setMessage` and `setOpen` from props are for global alerts).
   */
  const handleCloseMessageBox = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Toggles the selected status of a specific day of the week.
   * @param {number} id - The ID of the week day to toggle.
   */
  const handleChangeWeek = useCallback((id: number) => {
    setWeeks((prevWeeks) =>
      prevWeeks.map((item) => (item.id === id ? { ...item, selected: !item.selected } : item))
    );
  }, []);

  /**
   * Handles the selection/deselection of all cameras in the dropdown.
   * If checked, all camera names are selected and their images are fetched.
   * @param {React.ChangeEvent<HTMLInputElement>} e - The change event from the checkbox.
   */
  const handleSelectAllCameras = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      const allCameraNames = cameralist.map((item) => item.Camera_Name);
      setSelectedCamera(allCameraNames);
      getimagebycameraname(allCameraNames);
    } else {
      setSelectedCamera([]);
      setAdd_camera_img([]);
    }
  }, [cameralist, getimagebycameraname]);

  /**
   * Sets the active step of the alert configuration modal to 0.
   */
  const showstep0 = useCallback(() => {
    setActiveStep(0);
  }, []);

  /**
   * Validates the inputs for step 1 of the alert configuration and proceeds to step 2 if valid.
   * Displays error messages using `props.setMessage` and `props.setOpen` if validation fails.
   */
  const showstep1 = useCallback(() => {
    if (!alert_name) {
      setMessage("Alert name is required.");
      setOpen(true);
      return;
    } else if (alert_name.indexOf(" ") >= 0) {
      setMessage("Alert name cannot include space.");
      setOpen(true);
      return;
    } else if (!alert_description) {
      setMessage("Alert description is required.");
      setOpen(true);
      return;
    } else if (selectedCamera.length === 0) {
      setMessage("Please select the camera first");
      setOpen(true);
      return;
    } else if (selectedCamera.length > 1 && No_Object_Status === false) {
      setMessage("Please select only one camera");
      setOpen(true);
      return;
    } else if (activeStep === 0 && selectedCamera.length === 1 && submittype === "add" && No_Object_Status === false) {
      if (aipollygon.length === 0) {
        setMessage("Please draw object on given image");
        setOpen(true);
        return;
      }
    }
    setActiveStep(1);
  }, [alert_name, alert_description, selectedCamera, No_Object_Status, activeStep, submittype, aipollygon, setMessage, setOpen]);

  /**
   * Sets the active step of the alert configuration modal to 2.
   */
  const showstep2 = useCallback(() => {
    setActiveStep(2);
  }, []);

  /**
   * Handles the change of the selected camera in the dropdown.
   * Fetches the image for the newly selected camera.
   * @param {React.ChangeEvent<HTMLSelectElement>} event - The change event from the select element.
   */
  const handleChangeCamera = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedCamera(event.target.value as any); // Cast to string[] as MUI Select can return an array
    getimagebycameraname(event.target.value as any);
  }, [getimagebycameraname]);

  /**
   * Handles the change of the selected object of interest.
   * Adjusts `No_Object_Status` and `actionButton` based on the selected object.
   * @param {React.ChangeEvent<HTMLSelectElement>} event - The change event from the select element.
   */
  const handleChangeObjectofInter = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedObjectofInter(event.target.value);
    if (event.target.value && event.target.value !== "person") {
      setNo_Object_Status(true);
      setIsCheckboxHidden(1);
      setActionButton("form-button-group alert-modal-action-button-main-div-1");
    } else if (event.target.value && event.target.value === "person") {
      setIsCheckboxHidden(0);
      setActionButton("form-button-group alert-modal-action-button-main-div-0");
    }
  }, []);

  /**
   * Toggles the `No_Object_Status` if the selected object of interest is "person".
   */
  const handleObjectCheckChange = useCallback(() => {
    if (selectedObjectofInter && selectedObjectofInter === "person") {
      setNo_Object_Status((prevStatus) => !prevStatus);
    }
  }, [selectedObjectofInter]);

  /**
   * Handles the change of alert frequency (Daily/Weekly).
   * Updates the `weeks` state to reflect the selected frequency.
   * @param {React.ChangeEvent<HTMLSelectElement>} event - The change event from the select element.
   */
  const handleChangeFrequency = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedfrequency(event.target.value);
    if (event.target.value === "Daily") {
      setWeeks((prevWeeks) => prevWeeks.map((item) => ({ ...item, selected: true })));
    } else {
      setWeeks((prevWeeks) => prevWeeks.map((item) => ({ ...item, selected: false })));
    }
  }, []);

  /**
   * Updates an existing alert's email or display activation status in the database.
   * @param {string} id - The ID of the alert to update.
   * @param {boolean | string} email_active - The new email activation status.
   * @param {boolean | string} display_active - The new display activation status.
   * @param {Alert} item - The alert object being updated.
   * @param {'email' | 'display'} type - The type of activation being changed ('email' or 'display').
   */
  const updatealert = useCallback(async (id: string, email_active: boolean | string, display_active: boolean | string, item: Alert, type: 'email' | 'display') => {
    let weekarr: string[] = [];
    for (const wk of weeks) {
      if (wk.selected === true) {
        weekarr = [...weekarr, wk.value];
      }
    }

    let message2 = "";
    if (type === "email") {
      message2 = email_active ? "Email notification will be sent." : "Email notification will not be sent.";
    } else {
      message2 = display_active ? "Alert will be displayed." : "Your alert will not be displayed.";
    }

    const formattedStartTime = dayjs(item.Start_Time, "HH:mm");
    const from_time = dayjs().set("hour", formattedStartTime.hour()).set("minute", formattedStartTime.minute());
    const formattedEndTime = dayjs(item.End_Time, "HH:mm");
    const to_time = dayjs().set("hour", formattedEndTime.hour()).set("minute", formattedEndTime.minute());

    const params = {
      Alert_Name: item.Alert_Name,
      Alert_Description: item.Alert_Description,
      Camera_Name: item.Camera_Name,
      Object_Class: item.Object_Class,
      No_Object_Status: item?.No_Object_Status,
      Holiday_Status: item.Holiday_Status,
      Workday_Status: item.Workday_Status,
      Alert_Status: item.Alert_Status,
      Days_Active: weekarr,
      Display_Activation: display_active,
      Email_Activation: email_active,
      Start_Time: dayjs(from_time).format("HH:mm"),
      End_Time: dayjs(to_time).format("HH:mm"),
      Object_Area: editImageAOI ? aipollygon : item.Object_Area,
    };
    const url = `${VITE_base_url}${import.meta.env.VITE_ALERT_UPDATE}` + id;

    const headers = { "Content-Type": "application/json; charset=utf-8" };

    try {
      const res = await axiosJWT.put<{ success: boolean; message: string }>(url, params, { headers: headers });
      if (res.data.success === true) {
        setMessage(message2);
        setOpen(true);
        setActiveStep(0);
        setAlert_name("");
        setAlert_description("");
        setSelectedCamera([]);
        setSelectedObjectofInter("");
        setNo_Object_Status(true);
        setSelecteButttonDay("");
        setStart_time(dayjs().set("hour", 7).set("minute", 0));
        setEnd_time(dayjs().set("hour", 19).set("minute", 0));
        setModalStatus(false);
        setSubmittype("");
        setEdit_alert_id("");
        setAlert_status("");
        setDisplay_activation(false);
        setEmail_activation(false);
        getalertlist();
        setTimeout(() => {
          handleClose();
        }, 4000);
      } else {
        setMessage(res.data.message);
        setOpen(true);
      }
    } catch (error) {
      console.error("Error updating alert:", error);
      setMessage("Error updating alert.");
      setOpen(true);
    }
  }, [aipollygon, editImageAOI, weeks, setMessage, setOpen, getalertlist, handleClose]);

  /**
   * Toggles the email activation status of a single alert in the list and updates it in the database.
   * @param {Alert} item - The alert object to update.
   */
  const onChangeSingleEmailAlerts = useCallback((item: Alert) => {
    setAlertlist((prevAlerts) => {
      const updatedAlerts = prevAlerts.map((alert) => {
        if (alert._id === item._id) {
          return { ...alert, Email_Activation: !alert.Email_Activation };
        }
        return alert;
      });
      const updatedItem = updatedAlerts.find(alert => alert._id === item._id);
      if (updatedItem) {
        updatealert(updatedItem._id, updatedItem.Email_Activation, updatedItem.Display_Activation, updatedItem, "email");
      }
      return updatedAlerts;
    });
  }, [updatealert]);

  /**
   * Toggles the display activation status of a single alert in the list and updates it in the database.
   * @param {Alert} item - The alert object to update.
   */
  const onChangeSingleDisplayAlerts = useCallback((item: Alert) => {
    setAlertlist((prevAlerts) => {
      const updatedAlerts = prevAlerts.map((alert) => {
        if (alert._id === item._id) {
          return { ...alert, Display_Activation: !alert.Display_Activation };
        }
        return alert;
      });
      const updatedItem = updatedAlerts.find(alert => alert._id === item._id);
      if (updatedItem) {
        updatealert(updatedItem._id, updatedItem.Email_Activation, updatedItem.Display_Activation, updatedItem, "display");
      }
      return updatedAlerts;
    });
  }, [updatealert]);

  /**
   * Shows the view alert modal with the details of a selected alert.
   * @param {Alert} item - The alert object to view.
   */
  const showviewmodal = useCallback((item: Alert) => {
    setViewdata(item);
    setViewmodalstatus(true);
    setViewimagedata(item);
  }, []);

  /**
   * Shows the edit alert modal, pre-populating it with the selected alert's data.
   * Converts image URL to base64 for display in the image box.
   * @param {Alert} item - The alert object to edit.
   */
  const showeditmodal = useCallback((item: Alert) => {
    const weekarr: Week[] = weeks.map((week) => ({
      ...week,
      selected: item.Days_Active.includes(week.value),
    }));
    setWeeks(weekarr);

    let obj: any = {};
    if (camera_img) {
      toDataUrl(camera_img, async function (myBase64: string) {
        obj.base_url = myBase64;
        obj.Results = Array.isArray(item.Object_Area)
          ? item.Object_Area.flat(1)
          : `${item.Object_Area[0].x[0]} ${item.Object_Area[0].x[1]},${item.Object_Area[0].y[0]} ${item.Object_Area[0].y[1]} ,${item.Object_Area[0].w[0]} ${item.Object_Area[0].w[1]},${item.Object_Area[0].h[0]} ${item.Object_Area[0].h[1]}`;
        setViewimagedata(obj);
      });
    }

    const formattedStartTime = dayjs(item.Start_Time, "HH:mm");
    const from_time = dayjs().set("hour", formattedStartTime.hour()).set("minute", formattedStartTime.minute());
    const formattedtoTime = dayjs(item.End_Time, "HH:mm");
    const to_time = dayjs().set("hour", formattedtoTime.hour()).set("minute", formattedtoTime.minute());

    setViewdata(item);
    setModalStatus(true);
    setAlert_name(item.Alert_Name);
    setAlert_description(item.Alert_Description);
    setSelectedCamera(item.Camera_Name);
    setSelectedObjectofInter(item.Object_Class);
    setNo_Object_Status(item?.No_Object_Status);
    setHoliday(item.Holiday_Status);
    setWorking_day(item.Workday_Status);
    setStart_time(from_time);
    setEnd_time(to_time);
    setAlert_status(item.Alert_Status);
    setDisplay_activation(item.Display_Activation);
    setEmail_activation(item.Email_Activation);
    setEdit_alert_id(item._id);
    setSubmittype("edit");
    setModalopened("edit");
    setActiveStep(3);

    let camArr: Camera[] = [];
    if (item.Camera_Name.length > 1) {
      for (const singleCamName of item.Camera_Name) {
        for (const innerCam of cameralist) {
          if (innerCam.Camera_Name === singleCamName && innerCam.image !== "") {
            camArr.push({ name: innerCam.Camera_Name, image: innerCam.image } as any); // Cast to Camera for consistency
          }
        }
      }
    }
    setListOfCamera(camArr);
    setAdd_camera_img(camArr.map(cam => cam.image || '')); // Ensure this is an array of strings
  }, [weeks, camera_img, toDataUrl, cameralist]);

  /**
   * Shows the alert details modal in a read-only view mode, pre-populating it with the selected alert's data.
   * Converts image URL to base64 for display.
   * @param {Alert} item - The alert object to view details for.
   */
  const showviewdetailsmodal = useCallback((item: Alert) => {
    const weekarr: Week[] = weeks.map((week) => ({
      ...week,
      selected: item.Days_Active.includes(week.value),
    }));
    setWeeks(weekarr);

    let obj: any = {};
    if (camera_img) {
      toDataUrl(camera_img, async function (myBase64: string) {
        obj.base_url = myBase64;
        obj.Results = Array.isArray(item.Object_Area)
          ? item.Object_Area.flat(1)
          : `${item.Object_Area[0].x[0]} ${item.Object_Area[0].x[1]},${item.Object_Area[0].y[0]} ${item.Object_Area[0].y[1]} ,${item.Object_Area[0].w[0]} ${item.Object_Area[0].w[1]},${item.Object_Area[0].h[0]} ${item.Object_Area[0].h[1]} `;
        setViewimagedata(obj);
      });
    }

    const formattedStartTime = dayjs(item.Start_Time, "HH:mm");
    const from_time = dayjs().set("hour", formattedStartTime.hour()).set("minute", formattedStartTime.minute());
    const formattedtoTime = dayjs(item.End_Time, "HH:mm");
    const to_time = dayjs().set("hour", formattedtoTime.hour()).set("minute", formattedtoTime.minute());

    setViewdata(item);
    setModalStatus(true);
    setAlert_name(item.Alert_Name);
    setAlert_description(item.Alert_Description);
    setSelectedCamera(item.Camera_Name);
    setSelectedObjectofInter(item.Object_Class);
    setNo_Object_Status(item?.No_Object_Status);
    setHoliday(item.Holiday_Status);
    setWorking_day(item.Workday_Status);
    setStart_time(from_time);
    setEnd_time(to_time);
    setAlert_status(item.Alert_Status);
    setDisplay_activation(item.Display_Activation);
    setEmail_activation(item.Email_Activation);
    setEdit_alert_id(item._id);
    setSubmittype("view");
    setModalopened("view");
    setActiveStep(3);

    let camArr: Camera[] = [];
    if (item.Camera_Name.length > 1) {
      for (const singleCamName of item.Camera_Name) {
        for (const innerCam of cameralist) {
          if (innerCam.Camera_Name === singleCamName && innerCam.image !== "") {
            camArr.push({ name: innerCam.Camera_Name, image: innerCam.image } as any);
          }
        }
      }
    }
    setListOfCamera(camArr);
    setAdd_camera_img(camArr.map(cam => cam.image || ''));
  }, [weeks, camera_img, toDataUrl, cameralist]);

  /**
   * Resets the modal state and fetches updated alert and image lists after an operation.
   * @param {'add' | 'edit' | 'view'} mode - The mode of the operation that just completed.
   */
  const handleResetNCloseModal = useCallback((mode: 'add' | 'edit' | 'view') => {
    setActiveStep(0);
    setAlert_name("");
    setAlert_description("");
    setSelectedCamera([]);
    setSelectedObjectofInter("");
    setNo_Object_Status(true);
    setSelecteButttonDay("");
    setStart_time(dayjs().set("hour", 7).set("minute", 0));
    setEnd_time(dayjs().set("hour", 19).set("minute", 0));
    setModalStatus(false);
    setSubmittype("");
    if (mode === "edit") {
      setEdit_alert_id("");
      setAlert_status("");
      setDisplay_activation(false);
      setEmail_activation(false);
    }
    getalertlist();
    getimagebycameraname(null);
    handleClose();
  }, [getalertlist, getimagebycameraname, handleClose]);

  /**
   * Handles the submission (creation or update) of an alert.
   * Constructs the payload based on current state and sends it to the backend.
   * Manages success/error messages and updates relevant lists.
   * @param {'add' | 'edit'} mode - The mode of operation: 'add' for creating, 'edit' for updating.
   */
  const update_add_alert = useCallback(async (mode: 'add' | 'edit') => {
    let rtspid = 0;
    if (calledInsideMenu === true) {
      try {
        const response = await axiosJWT.get<Record<string, { rtsp_id: number }>>(VITE_base_url + "/rtsplinks.json");
        const rtsplink = response.data;
        // console.log('rtsp',rtsplink);
        if (camera_link && rtsplink[camera_link]) {
          rtspid = rtsplink[camera_link].rtsp_id;
        }
      } catch (error) {
        console.error("Error fetching RTSP links:", error);
      }
    }

    try {
      const weekarr: string[] = weeks.filter(item => item.selected).map(item => item.value);

      const from_time = dayjs(start_time).format("HH:mm");
      const to_time = dayjs(end_time).format("HH:mm");

      let params: Omit<Alert, '_id'> = {
        Alert_Name: alert_name,
        Alert_Description: alert_description,
        Camera_Name: selectedCamera,
        Object_Class: selectedObjectofInter,
        No_Object_Status: No_Object_Status,
        Holiday_Status: holiday,
        Workday_Status: working_day,
        Alert_Status: mode === "add" ? "active" : (alert_status || "active"), // Default to "active" if empty in edit
        Days_Active: weekarr,
        Display_Activation: mode === "add" ? true : (display_activation === "" ? false : display_activation as boolean), // Ensure boolean
        Email_Activation: mode === "add" ? true : (email_activation === "" ? false : email_activation as boolean), // Ensure boolean
        Start_Time: from_time,
        End_Time: to_time,
        Object_Area: aipollygon,
      };

      let fixed_params = { ...params };
      if (mode === "edit" && !editImageAOI) {
        // If not editing AOI, use existing AOI from viewdata (if viewdata is an Alert object)
        fixed_params.Object_Area = (viewdata as Alert).Object_Area;
      }

      const headers = { "Content-Type": "application/json; charset=utf-8" };
      let data: { success: boolean; message: string };

      if (mode === "add") {
        const response = await axiosJWT.post<{ success: boolean; message: string }>(`${VITE_base_url}${import.meta.env.VITE_ALERT_CREATE}`, params, { headers: headers });
        data = response.data;
      } else {
        const response = await axiosJWT.put<{ success: boolean; message: string }>(`${VITE_base_url}${import.meta.env.VITE_ALERT_UPDATE}` + edit_alert_id, fixed_params, { headers: headers });
        data = response.data;
      }

      if (data.success === true) {
        getcameralist(selectedCamera.join(','), true); // Pass selectedCamera as string for getcameralist
        const msg = mode === "add" ? t("Alert is created successfully.") : t("Alert is updated successfully.");
        setMessage(msg);
        setOpen(true);
        setWarning(false);
      } else {
        setMessage(data.message);
        setOpen(true);
        setWarning(false);
      }
    } catch (ex) {
      console.error("Error in update_add_alert:", ex);
      setMessage("An error occurred. Please try again.");
      setOpen(true);
      setWarning(true);
    } finally {
      handleResetNCloseModal(mode);
      if (calledInsideMenu === false && setdata) {
        setdata();
      }
    }
  }, [
    calledInsideMenu, camera_link, alert_name, alert_description,
    selectedCamera, selectedObjectofInter, No_Object_Status, holiday,
    working_day, alert_status, weeks, display_activation, email_activation,
    start_time, end_time, aipollygon, edit_alert_id, editImageAOI, viewdata,
    getcameralist, setMessage, setOpen, setWarning, handleResetNCloseModal, setdata
  ]);

  /**
   * Calls `update_add_alert` with the appropriate mode ('add' or 'edit') based on `submittype`.
   */
  const submit_button = useCallback(() => {
    const mode = submittype === "edit" ? "edit" : "add";
    update_add_alert(mode);
  }, [submittype, update_add_alert]);

  /**
   * Sets the Area of Interest (AOI) polygon coordinates.
   * @param {any[]} params - The coordinates of the AOI polygon.
   */
  const setAIPolygen = useCallback((params: any[]) => {
    setAipollygon(params);
  }, []);

  /**
   * Shows the alert creation modal with default values.
   */
  const show_modal = useCallback(() => {
    setModalStatus(true);
    setSubmittype("add");
    setActiveStep(0);
    setSelectedCamera([props_camera]);
    setModalopened("");
    setAlert_name("");
    setAlert_description("");
    setSelectedObjectofInter("person");
    setNo_Object_Status(true);
    setSelecteButttonDay("Holiday");
    setStart_time(dayjs().set("hour", 7).set("minute", 0));
    setEnd_time(dayjs().set("hour", 19).set("minute", 0));
    setAlert_status("");
    setDisplay_activation("");
    setEmail_activation("");
    setWeeks(prevWeeks => prevWeeks.map(week => ({ ...week, selected: true })));
    setIsClose(false);
  }, [props_camera]);

  /**
   * Handles changes to the alert name input field.
   * @param {React.ChangeEvent<HTMLInputElement>} event - The change event from the input field.
   */
  const handleAlertName = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setAlert_name(event.target.value);
  }, []);

  /**
   * Handles changes to the alert description input field.
   * @param {React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>} event - The change event from the input/textarea field.
   */
  const handleAlertDescription = useCallback((event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setAlert_description(event.target.value);
  }, []);

  /**
   * Handles changes to the alert start time.
   * @param {Dayjs | null} value - The new start time as a Dayjs object or null.
   */
  const handleChangeStartTime = useCallback((value: Dayjs | any) => {
    if (value) setStart_time(value);
  }, []);

  /**
   * Handles changes to the alert end time.
   * @param {Dayjs | null} value - The new end time as a Dayjs object or null.
   */
  const handleChangeEndTime = useCallback((value: Dayjs | any) => {
    if (value) setEnd_time(value);
  }, []);

  /**
   * Toggles the `editImageAOI` state, allowing or disallowing editing of the Area of Interest.
   */
  const hangleEditImageAOI = useCallback(() => {
    setEditImageAOI((prev) => !prev);
  }, []);

  /**
   * Effect hook to detect mobile device width and update `isMobileDevice` and `screenType` states.
   * Adds and removes a resize event listener.
   */
  useEffect(() => {
    const handleResize = () => {
      const isMobile = window.innerWidth <= 800;
      if (isMobile !== isMobileDevice) {
        setIsMobileDevice(isMobile);
        setScreenType(isMobile ? "Mobile" : "Desktop");
      }
    };

    handleResize(); // Set initial state
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [isMobileDevice]);

  // Derived state for no data status
  const noData = alertlist.length === 0;

  return (
    <>
      {calledInsideMenu && (
        <Tooltip title={t("Add Alert")}>
          <button
            type="button"
            className="add-alert-tile-btn"
            onClick={show_modal}
          >
            <i className="bx bx-bell-plus"></i>
          </button>
        </Tooltip>
      )}

      {!calledInsideMenu && (
        <AlertListComponent
          pageType={props.pageType}
          screenType={screenType}
          style={{ padding: 12 }}
          alertlist={alertlist}
          tableloader={tableloader}
          noAvailableStatus={noData}
          props_camera={props_camera} // This remains a fixed placeholder as per original
          setMessage={setMessage}
          setOpen={setOpen}
          setWarning={setWarning}
          onChangeSingleEmailAlerts={onChangeSingleEmailAlerts}
          onChangeSingleDisplayAlerts={onChangeSingleDisplayAlerts}
          showeditmodal={showeditmodal}
          showviewdetailsmodal={showviewdetailsmodal}
          getalertlist={getalertlist}
          handleShow={handleShow}
        />
      )}

      <ViewAlertDialog
        open={viewmodalstatus}
        viewData={viewdata}
        onClose={() => setViewmodalstatus(false)}
      />

      <AlertConfigurationModal
        modalStatus={modalStatus}
        activeStep={activeStep}
        selectedFrequency={selectedfrequency}
        handleClose={handleClose}
        calledInsideMenu={calledInsideMenu}
        modalopened={modalopened}
        submittype={submittype}
        alert_name={alert_name}
        alert_description={alert_description}
        selectedCamera={selectedCamera}
        cameralist={cameralist}
        alertlist={alertlist}
        selectedObjectofInter={selectedObjectofInter}
        listofobjectlabels={listofobjectlabels}
        No_Object_Status={No_Object_Status}
        working_day={working_day}
        holiday={holiday}
        weeks={weeks}
        start_time={start_time}
        end_time={end_time}
        isMobileDevice={isMobileDevice}
        add_camera_img={add_camera_img}
        viewdata={viewdata}
        viewimagedata={viewimagedata}
        listOfCamera={listOfCamera}
        camera_img={camera_img}
        aipollygon={aipollygon}
        editImageAOI={editImageAOI}
        isClose={isClose}
        hangleEditImageAOI={hangleEditImageAOI}
        handleChangeStartTime={handleChangeStartTime}
        handleChangeEndTime={handleChangeEndTime}
        handleAlertName={handleAlertName}
        handleAlertDescription={handleAlertDescription}
        handleChangeCamera={handleChangeCamera}
        handleSelectAllCameras={handleSelectAllCameras}
        handleChangeObjectofInter={handleChangeObjectofInter}
        handleObjectCheckChange={handleObjectCheckChange}
        handleChangeFrequency={handleChangeFrequency}
        handleChangeWeek={handleChangeWeek}
        setAIPolygen={setAIPolygen}
        showstep0={showstep0}
        showstep1={showstep1}
        showstep2={showstep2}
        submit_button={submit_button}
      />
    </>
  );
};

export default Alerts;