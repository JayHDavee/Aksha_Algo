import React, { useState, useEffect, ChangeEvent } from "react";
import { useApi } from "../../../hooks/useApi";
import "antd/dist/antd.css";
import "./list.scss";
import axiosJWT from "../../../context/axiosAuthIntercept";
import { useTranslation } from "react-i18next";
import Alerts from "../../../component/common/customAlertModal/Alerts"; //alert modal with steps
import {
  Button,
  Select,
  Box,
  InputLabel,
  FormControl,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  CircularProgress,
  Tooltip,
  MenuProps,
} from "@mui/material";
import Messagebox from "../../../component/common/Messagebox";
import { useFeatureFlags } from "../../../context/FeatureFlagsContext";

// define base url
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Interface representing a feature item.
 */
interface Feature {
  id: number;
  name: string;
  status: boolean;
}

/**
 * Interface representing props for Add component.
 */
interface AddProps {
  setMessage: (msg: string) => void;
  setOpen: (open: boolean) => void;
  setWarning?: (warning: boolean) => void;
  showScreen: () => void;
  loadlist: () => void;
  cameradata: any;
  list: any[];
  activescreen: string;
  redirectOnSuccess?: () => void;
  renderedFrom?: string;
  setCamDirectory?: (value: boolean) => void;
}

/**
 * Add component allows adding or editing a camera.
 * Handles form inputs, validation, API calls, and alert management.
 * @param props - AddProps
 * @returns JSX.Element
 */
const Add: React.FC<AddProps> = (props) => {
  console.log('activescreen', props.activescreen);
  const { callApi } = useApi();
  const { t } = useTranslation();
  const { PPE_DETECTION, JEWELRY_DETECTION } = useFeatureFlags();
  const [pagetype, setPagetype] = useState<string>("add");
  const [showAlert, setShowAlert] = useState<boolean>(false);
  const [editLink, setEditLink] = useState<boolean>(false);
  const [features, setFeatures] = useState<Feature[]>([
    {
      id: 1,
      name: "Live",
      status: true,
    },
    {
      id: 2,
      name: "Anomaly Detection",
      status: true,
    },
  ]);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [prevcamrename, setPrevcamrename] = useState<string>("");
  const [rtsp_id, setrtsp_id] = useState<string>("");
  const [warning, setWarning] = useState<boolean>(true);
  let rtsplink: any = null;
  const [camera_name, setCamera_name] = useState<string>("");
  const [camera_link, setCamera_link] = useState<string>("");
  const [priority, setPriority] = useState<string>("High");
  const [detectionType, setDetectionType] = useState<string>("standard");
  const [description, setDescription] = useState<string>("");
  const [formloader, setFormloader] = useState<boolean>(false);
  const [camera_id, setCamera_id] = useState<number>(0);
  const [cameraList, setCameraList] = useState<any[]>([]); //list of cameras state in index.js, found unused
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const [singleData, setSingleData] = useState<any>({});
  const [alertlist, setAlertlist] = useState<string[]>([]);
  const [myclist, setMyclist] = useState<any[]>([]);
  const [rtspdata, setrtspdata] = useState<any>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [camnamertsp, setcamnamertsp] = useState<string>("");
  const [rtspid, setRtspid] = useState<string>("");

  /**
   * Closes the message box.
   */
  const handleClose = (): void => {
    setOpen(false);
  };

  /**
   * Toggles edit link state.
   */
  const HandleEditLink = (): void => {
    setEditLink(!editLink);
  };

  /**
   * Toggles feature status by id.
   * @param id - feature id
   */
  const onChangeFeature = (id: number): void => {
    const arr = features.map((item) => {
      if (item.id === id) {
        return { ...item, status: !item.status };
      }
      return item;
    });
    setFeatures(arr);
  };

  const handleMenuOpen = (): void => {
    setMenuOpen(true);
  };

  const handleMenuClose = (): void => {
    setMenuOpen(false);
  };

  /**
   * Adds a new camera or activates existing inactive camera.
   */
  const add_camera = (): void => {
    let status = false; //if camera is already present in databse with Active === false then status = true and enable modal called

    let arr: any[] = [];

    if (myclist.length > 0) {
      for (let item of myclist) {
        if (item.Rtsp_Link === camera_link && item.Active === false) {
          status = true;
          arr = [...arr, item];
        } else if (item.Rtsp_Link === camera_link && item.Active === true) {
          props.setMessage(t("duplicateRtsp"));
          props.setOpen(true);
          return;
        }
      }
    }

    if (status === true) {
      setSingleData(arr);
      setIsModalVisible(true);
    } else {
      let featurelist: string[] = [];

      for (let item of features) {
        if (item.status === true) {
          featurelist = [...featurelist, item.name];
        }
      }
      if (!camera_name) {
        setMessage(t("invalidName"));
        setOpen(true);
        return;
      }
      if (
        camera_name &&
        camera_name.length > 0 &&
        camera_name.indexOf(" ") !== -1
      ) {
        setMessage(t("cameraNameNoSpace"));
        setOpen(true);
        return;
      }
      if (
        camera_name &&
        camera_name.length > 0 &&
        camera_name.indexOf("_") !== -1
      ) {
        setMessage(t("cameraNameNoUnderscore"));
        setOpen(true);
        return;
      }
      if (!camera_link) {
        setMessage(t("invalidCameraLink"));
        setOpen(true);
        return;
      }
      if (!priority) {
        setMessage(t("invalidPriority"));
        setOpen(true);
        return;
      }
      if (!description) {
        setMessage(t("invalidDescription"));
        setOpen(true);
        return;
      }
      if (featurelist.length === 0) {
        setMessage(t("selectOneFeature"));
        setOpen(true);
        return;
      }

      let params = {
        rtsp_id: rtsp_id,
        Rtsp_Link: camera_link,
        Camera_Name: camera_name,
        Prev_Camera_Name:
          prevcamrename !== "" ? prevcamrename : camera_name.split(" ").join("_"),
        alerts: alertlist,
        Description: description,
        Feature: featurelist,
        Priority: priority,
        Detection_Type: detectionType,
      };

      setFormloader(true);

      const headers = {
        "Content-Type": "application/json; charset=utf-8",
      };
      let url = `${VITE_base_url}/api/camera/create`;
      callApi(url, { method: "POST", body: params, headers, timeout: 10000 })
        .then((res: any) => {
          if (res.data.success === true) {
            props.setMessage(
              t('Camera "{{cameraName}}" is added successfully.', { cameraName: camera_name })
            );
            props.setWarning && props.setWarning(false);
            props.setOpen(true);
            setShowAlert(true);
            props.showScreen();
            props.loadlist();
            getalertlist();
            setFormloader(false);
            if (props.redirectOnSuccess) {
              props.redirectOnSuccess();
            }
          } else {
            props.setMessage(res.data.message);
            props.setOpen(true);
            setFormloader(false);
          }
        });
    }
  };

  /**
   * Updates camera details.
   */
  const update_camera = (): void => {
    getalertlist(); //get the alerts from mongodb
    let featurelist: string[] = [];
    for (let item of features) {
      if (item.status === true) {
        featurelist = [...featurelist, item.name]; //check which features selected by user
      }
    }

    //form fields state validation with toast error messgae
    if (!camera_name) {
      setMessage(t("invalidCameraName"));
      setOpen(true);
      return;
    }

    //Camera name cannot include space
    if (
      camera_name &&
      camera_name.length > 0 &&
      camera_name.indexOf(" ") !== -1
    ) {
      setMessage(t("cameraNameNoSpace"));
      setOpen(true);
      return;
    }

    // Camera name cannot include  _
    if (
      camera_name &&
      camera_name.length > 0 &&
      camera_name.indexOf("_") !== -1
    ) {
      setMessage(t("cameraNameNoUnderscore"));
      setOpen(true);
      return;
    }
    if (!camera_link) {
      setMessage(t("invalidCameraLink"));
      setOpen(true);
      return;
    }
    if (!description) {
      setMessage(t("invalidDescription"));
      setOpen(true);
      return;
    }
    if (!priority) {
      setMessage(t("invalidPriority"));
      setOpen(true);
      return;
    }
    if (featurelist.length === 0) {
      setMessage(t("selectOneFeature"));
      setOpen(true);
      return;
    }

    let params = {
      Rtsp_Link: camera_link,
      rtsp_id: props.cameradata.rtsp_id,
      Camera_Name: camera_name,
      Prev_Camera_Name:
        prevcamrename !== "" ? prevcamrename : camera_name.split(" ").join("_"),
      Description: description,
      Feature: featurelist,
      Priority: priority,
      Detection_Type: detectionType,
    };
    setFormloader(true); //show spinner in ui
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
    };
    let url = `${VITE_base_url}/api/camera/update/` + camera_id;
    callApi(url, { method: "PUT", body: params, headers })
      .then((res: any) => {
        if (res.data.success == true) {
          props.setMessage(
            t('Camera "{{cameraName}}" is updated successfully.', { cameraName: camera_name })
          );
          props.setOpen(true);
          props.showScreen(); //back to all cameras listed table
          props.loadlist(); //this gets new cameras added in index.js
          if (props.redirectOnSuccess) {
            props.redirectOnSuccess();
          }
        } else {
          props.setMessage(res.data.message);
          props.setWarning && props.setWarning(true);
          props.setOpen(true);
        }
        setFormloader(false);
      });
    props.setCamDirectory && props.setCamDirectory(true);
  };

  /**
   * Activates a previously deleted camera.
   */
  const activate_camera = (): void => {
    setIsModalVisible(false);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
    };
    let id = singleData[0]._id;
    let url = `${VITE_base_url}${import.meta.env.VITE_ACTIVATE_CAMERA}${id}`;
    callApi(url, { method: "GET", headers: headers })
      .then((res: any) => {
        if (res.data.success === true) {
          props.setMessage(t("cameraActivateSuccess"));
          props.setOpen(true);
          props.showScreen();
          props.loadlist();
          getalertlist();
        } else {
          props.setMessage(t("tryAgain"));
          props.setOpen(true);
        }
        setFormloader(false);
      });
  };

  /**
   * Hides the activation modal.
   */
  const handleCancel = (): void => {
    setIsModalVisible(false);
  };

  /**
   * Fetches alert list for current camera.
   */
  const getalertlist = (): void => {
    let url = `${VITE_base_url}/api/alert/` + camera_name;
    callApi(url, { method: "GET" })
      .then((response: any) => {
        if (response.data.success === true) {
          let arr: string[] = [];
          for (let item of response.data.alerts) {
            arr = [...arr, item.Alert_Name];
          }
          setAlertlist(arr);
        }
      })
      .catch(() => { });
  };

  /**
   * Fetches list of cameras including inactive ones.
   */
  const getcameralist = (): void => {
    let url = `${VITE_base_url}${import.meta.env.VITE_CAMERA}`;
    callApi(url, { method: "GET" })
      .then((response: any) => {
        setMyclist(response.data.cameras);
      })
      .catch(() => { });
  };

  useEffect(() => {
    getcameralist();
    axiosJWT.get(VITE_base_url + "/rtsplinks.json").then((response) => {
      setrtspdata(response.data);
      rtsplink = response.data;
      console.log(response);
    });
    var element = document.getElementById("body-tag");
    element?.classList.remove("hide-scrollbar");

    setCameraList(props.list);

    if (props.cameradata.Rtsp_Link) {
      setrtsp_id(props.cameradata.rtsp_id);
      setCamera_link(props.cameradata.Rtsp_Link);
      setCamera_name(props.cameradata.Camera_Name);
      setDescription(props.cameradata.Description);
      setPriority(props.cameradata.Priority);
      setDetectionType(props.cameradata.Detection_Type || "standard");
      setCamera_id(props.cameradata._id);
      setPagetype("edit");
      setPrevcamrename(props.cameradata.Camera_Name);
      let featurelist: Feature[] = [];
      for (let item of features) {
        if (props.cameradata.Feature.includes(item.name)) {
          item.status = true;
        } else {
          item.status = false;
        }
        featurelist = [...featurelist, item];
      }
      setFeatures(features);
    } else {
      setCamera_link("");
      setCamera_name("");
      setDescription("");
      setPriority("High");
      setDetectionType("standard");
      setCamera_id(0);
      setPagetype("add");
      setPrevcamrename("");
      setFeatures(features);
    }
  }, []);

  return (
    <div
      className="add-camera-section"
      style={{ alignItems: "flex-start", marginTop: props.renderedFrom == "Live" ? "4rem" : undefined }}
    >
      <Messagebox open={open} handleClose={handleClose} message={message} warning={warning} />

      <Dialog
        open={isModalVisible}
        onClose={handleCancel}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">Confirm</DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">Do you want to enable camera?</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} color="primary">
            Cancel
          </Button>
          <Button onClick={activate_camera} color="primary" autoFocus>
            OK
          </Button>
        </DialogActions>
      </Dialog>

      <div className="corner pt-0" style={{ padding: "clamp(16px, 4vw, 35px) clamp(16px, 5vw, 50px)" }}>
        {formloader ? (
          <Box position="absolute" top="50%" left="50%" sx={{ transform: "translate(-50%, -50%)" }}>
            <CircularProgress />
            <p style={{ color: "var(--color-primary)", marginLeft: "-25%", marginTop: "0.5rem" }}>{t("savingSettings")}</p>
          </Box>
        ) : (
          <>
            <div className="form-basic-details">
              <div>
                <label style={{ position: "relative", top: 10 }}>{t("Name")}</label>
                {pagetype === "edit" ? (
                  <>
                    <br />
                    <input
                      disabled={props.activescreen === "view" ? true : false}
                      type="text"
                      placeholder="Camera Name"
                      value={camera_name}
                      onChange={(e) => {
                        setCamera_name(e.target.value);
                        setrtsp_id(rtspdata[camera_link].rtsp_id);
                      }}
                      className="nameinput"
                    />
                  </>
                ) : (
                  <>
                    <FormControl fullWidth>
                      <InputLabel id="demo-simple-select-label">{t("Name")}</InputLabel>
                      <Select
                        disabled={props.activescreen === "view" ? true : false}
                        labelId="demo-simple-select-label"
                        id="demo-simple-select"
                        value={camera_link}
                        label="Rtsplink"
                        onChange={(e) => {
                          setCamera_link(e.target.value);
                          setCamera_name(rtspdata[e.target.value].cam_name);
                          setrtsp_id(rtspdata[e.target.value].rtsp_id);
                        }}
                        onOpen={handleMenuOpen}
                        onClose={handleMenuClose}
                        sx={{ maxWidth: "95%", backgroundColor: "white", maxHeight: "50px" }}
                        MenuProps={{
                          PaperProps: {
                            style: { maxHeight: 220, marginTop: 5, padding: 0 },
                          },
                          anchorOrigin: { vertical: "bottom", horizontal: "left" },
                          transformOrigin: { vertical: "top", horizontal: "left" },
                        }}
                      >
                        {rtspdata &&
                          Object.entries(rtspdata).map(([key, value]) => {
                            const val = key as string;
                            const valObj = value as { running_status: boolean; rtsp_id: string; cam_name: string };
                            return (
                              <MenuItem key={val} value={val} disabled={valObj.running_status}>
                                <Tooltip
                                  title={
                                    <div>
                                      <img
                                        src={`http://${window.location.hostname}:5000/Reference_images/${valObj.rtsp_id}.jpg`}
                                        alt="Image Tooltip"
                                        style={{ width: "110%",height:"100%", marginLeft: "-5%" }}
                                      />
                                    </div>
                                  }
                                >
                                  <span>{valObj.cam_name}-{val}</span>
                                </Tooltip>
                              </MenuItem>
                            );
                          })}
                      </Select>
                    </FormControl>
                  </>
                )}
              </div>

              <div>
                <label style={{ position: "relative", top: 10 }}>{t("Link")}</label>
                {editLink ? (
                  <>
                    <FormControl fullWidth>
                      <InputLabel id="demo-simple-select-label">Select a new rtsp link from the dropdown</InputLabel>
                      <Select
                        disabled={props.activescreen === "view" ? true : false}
                        onDoubleClickCapture={HandleEditLink}
                        labelId="demo-simple-select-label"
                        id="demo-simple-select"
                        value={camera_link}
                        label="Select a new rtsp link from the dropdown"
                        onChange={(e) => {
                          setCamera_link(e.target.value);
                        }}
                        onOpen={handleMenuOpen}
                        onClose={handleMenuClose}
                        sx={{ maxWidth: "95%", backgroundColor: "white", maxHeight: "50px" }}
                        MenuProps={{
                          PaperProps: {
                            style: { maxHeight: 220, marginTop: 5, padding: 0 },
                          },
                          anchorOrigin: { vertical: "bottom", horizontal: "left" },
                          transformOrigin: { vertical: "top", horizontal: "left" },
                        }}
                      >
                        {rtspdata &&
                          Object.entries(rtspdata).map(([key, value]) => {
                            const val = key as string;
                            const valObj = value as { running_status: boolean };
                            return (
                              <MenuItem key={val} value={val}>
                                {!valObj.running_status && <>{val}</>}
                              </MenuItem>
                            );
                          })}
                      </Select>
                    </FormControl>
                  </>
                ) : (
                  <>
                    <input
                      disabled={props.activescreen === "view" ? true : false}
                      type="text"
                      placeholder={t("Camera link")}
                      value={camera_link}
                    />
                  </>
                )}
              </div>

              <div>
                <label style={{ position: "relative", top: 10 }}>{t("Priority")}</label>
                <select
                  disabled={props.activescreen === "view" ? true : false}
                  name="priority"
                  onChange={(e) => setPriority(e.target.value)}
                  value={priority}
                >
                  <option value="High">{t("High")}</option>
                  <option value="Medium">{t("Medium")}</option>
                  <option value="Low">{t("Low")}</option>
                </select>
              </div>

              <div>
                <label style={{ position: "relative", top: 10 }}>{t("Detection Type")}</label>
                <select
                  disabled={props.activescreen === "view" ? true : false}
                  name="detectionType"
                  onChange={(e) => setDetectionType(e.target.value)}
                  value={detectionType}
                >
                  <option value="standard">{t("Standard")}</option>
                  {PPE_DETECTION && <option value="ppe">{t("PPE")}</option>}
                  {JEWELRY_DETECTION && <option value="jewelry">{t("Jewelry")}</option>}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 20, marginLeft: 25, width: 500, maxWidth: "calc(100% - 25px)", boxSizing: "border-box" }}>
              <label style={{ marginBottom: 10 }}>{t("Description")}</label>
              <textarea
                disabled={props.activescreen === "view" ? true : false}
                rows={4}
                cols={40}
                maxLength={150}
                placeholder={t("Maximum 200 characters.")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: "96%", padding: 10, border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", outline: "none", fontSize: 15 }}
              ></textarea>
            </div>

            <div className="bottom-form-content">

              {props.activescreen !== "view" ? (
                <div className="form-button-group">
                  <button className="outlined-button" style={{ width: 117 }} onClick={() => { props.showScreen(); props.setCamDirectory && props.setCamDirectory(true); }}>
                    {t("Cancel")}
                  </button>
                  {pagetype === "edit" ? (
                    <button className="filled-button" style={{ width: 117 }} onClick={() => update_camera()}>
                      {t("Update")}
                    </button>
                  ) : (
                    <button className="filled-button" style={{ width: 220 }} onClick={() => { add_camera(); props.setCamDirectory && props.setCamDirectory(true); }}>
                      {t("Save & Start Surveillance")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="form-button-group">
                  <button className="outlined-button" style={{ width: 117 }} onClick={() => { props.showScreen(); props.setCamDirectory && props.setCamDirectory(true); }}>
                    {t("Back")}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {props.activescreen === "view" ? (
        <div className="corner bg-white padding-cls-camera" >
          <Alerts
            calledInsideMenu={false}
            pageType="view"
            camera_name={camera_name ? camera_name : props.cameradata.Camera_Name}
            setMessage={setMessage}
            setOpen={setOpen}
            setWarning={setWarning}
          />
        </div>
      ) : (pagetype === "edit") ? (
        formloader ? (
          <Box position="absolute" top="50%" left="50%" sx={{ transform: "translate(-50%, -50%)" }}>
            <CircularProgress />
            <p style={{ color: "#1976d2", marginLeft: "-25%", marginTop: "0.5rem" }}>Saving your settings</p>
          </Box>
        ) : (
          <Alerts
            calledInsideMenu={false}
            pageType='edit'
            setdata={(data: any) => getalertlist()}
            camera_name={camera_name ? camera_name : props.cameradata.Camera_Name}
            setMessage={setMessage}
            setOpen={setOpen}
            setWarning={setWarning}
          />
        )
      ) : (
        formloader ? (
          <Box position="absolute" top="50%" left="50%" sx={{ transform: "translate(-50%, -50%)" }}>
            <CircularProgress />
            <p style={{ color: "#1976d2", marginLeft: "-25%", marginTop: "0.5rem" }}>Saving your settings</p>
          </Box>
        ) : (
          <div className="corner bg-white padding-cls-camera" style={showAlert ? {} : { pointerEvents: "none" }}>
            <Alerts
              calledInsideMenu={false}
              pageType={"add"}
              setdata={(data: any) => getalertlist()}
              camera_name={camera_name ? camera_name : props.cameradata.Camera_Name}
              setMessage={setMessage}
              setOpen={setOpen}
              setWarning={setWarning}
            />
          </div>
        )
      )}
    </div>
  );
};

export default Add;