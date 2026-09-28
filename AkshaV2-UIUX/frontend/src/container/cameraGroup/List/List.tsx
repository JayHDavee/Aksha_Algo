import React, { useState, useEffect, ChangeEvent } from 'react';
import { useSelector } from 'react-redux';
import { useApi } from '../../../hooks/useApi';
import Add from './AddGroup';
import useRemoveScroll from '../../../hooks/useRemoveScroll';
import './list.scss';
import { CircularProgress } from '@mui/material';
import Box from '@mui/material/Box';
import Messagebox from '../../../component/common/Messagebox';
import Modal from 'react-bootstrap/Modal';
import Button from 'react-bootstrap/Button';
import CameraSettingsPanel from './components/CameraSettingsPanel';
import { Translation, useTranslation } from 'react-i18next';
const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/**
 * Interface representing a camera object.
 */
interface Camera {
  _id: string;
  Camera_Name: string;
  Rtsp_Link: string;
  FPS?: number;
  Description?: string;
  Feature?: string;
  Priority?: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  Email_Alert: boolean;
  Display_Alert: boolean;
  Status?: string;
  rowselected?: boolean;
  rtsp_id?: string;
}

/**
 * Props for the List component.
 */
interface ListProps {
  camDirectory: boolean;
  setCamDirectory: (value: boolean) => void;
}

/**
 * List component displays and manages the camera directory.
 * Shows either a table of cameras or an add/edit camera form based on state.
 * Handles toggling alerts, adding, editing, deleting cameras.
 * @param props - ListProps
 * @returns JSX.Element
 */
const List: React.FC<ListProps> = (props) => {
  const { callApi } = useApi();
 const {t} = useTranslation();
  // Redux state to detect if device is mobile
  const { is_mobile } = useSelector((state: any) => state.isMobileDevice);

  // State variables
  const [activescreen, setActivescreen] = useState<number>(0);
  const [allselected, setAllselected] = useState<boolean>(false);
  const [displayalertstatus, setDisplayalertstatus] = useState<boolean>(true);
  const [emailalertstatus, setEmailalertstatus] = useState<boolean>(true);
  const [cameraList, setCameraList] = useState<Camera[]>([]);
  const [copyCameraList, setCopyCameraList] = useState<Camera[]>([]);
  const [tableloader, setTableloader] = useState<boolean>(false);
  const [cameradata, setCameradata] = useState<Partial<Camera>>({});
  const [cameraId, setCameraId] = useState<string>('');
  const [deletemodalstatus, setDeletemodalstatus] = useState<boolean>(false);
  const [viewmodalstatus, setViewModalStatus] = useState<boolean>(false);
  const [viewdata, setViewdata] = useState<Partial<Camera>>({});
  const [activepage, setActivepage] = useState<string>('');
  const [cameraemailalerts, setCameraemailalerts] = useState<boolean>(true);
  const [cameradisplayalerts, setCameradisplayalerts] = useState<boolean>(true);
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>('');
  const [disableCam, setDisableCamera] = useState<boolean>(false);
  const [warning, setWarning] = useState<boolean>(false);
  const [isCamLimitExceeded, setIsCamLimitExceeded] = useState<boolean>(false);
  const [maxCam, setMaxCam] = useState<number>(0);
  const [email_auto_alert, setemail_auto_alert] = useState<boolean>(true);
  const [display_auto_alert, setdisplay_auto_alert] = useState<boolean>(true);
  const [display_alert, setdisplay_alert] = useState<boolean>(true);
  const [email_alert, setemail_alert] = useState<boolean>(true);
  const [rtspdata, setrtspdata] = useState<any>(null);


  //Handle Close Message Box
  const handleClose = () => {
    setOpen(false);
  };

  // Runs on first render to fetch RTSP links and check login status
  useEffect(() => {
    callApi(`${VITE_base_url}/rtsplinks.json`, { method: 'GET' })
      .then((response) => {
        setrtspdata(response.data);
        console.log('response Data : ', response.data);
      });

    if (localStorage.getItem('isLoggedIn') !== 'true') {
      window.location.assign('/monitor');
    }
  }, []);

  /**
   * Toggles selection of all cameras.
   * Updates rowselected property on each camera.
   */
  const handleSelectAll = (): void => {
    setAllselected(!allselected);
    cameraList.forEach(camera => {
      camera.rowselected = !allselected;
    });
    setCameraList([...cameraList]);
  };

  /**
   * Handles toggling display auto alerts for all cameras.
   * @param e - ChangeEvent<HTMLInputElement>
   */
  const handledisplayalerts = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setDisplayalertstatus(e.target.checked);
    const status = e.target.checked;
    const showmessage = 1;
    cameraList.forEach(camera => {
      camera.Display_Auto_Alert = status;
      update_camera_status_py(status, camera, 'display');
    });
    update_camera_status_db(status, "display", showmessage);
    setCameraList([...cameraList]);
  };

  /**
   * Handles toggling email auto alerts for all cameras.
   * @param e - ChangeEvent<HTMLInputElement>
   */
  const handleemailalerts = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const status = e.target.checked;
    const showmessage = 1;
    setEmailalertstatus(status);
    cameraList.forEach(camera => {
      camera.Email_Auto_Alert = status;
      update_camera_status_py(status, camera, 'email');
    });
    update_camera_status_db(status, "email", showmessage);
    setCameraList([...cameraList]);
  };

  /**
   * Updates camera alert status in the database.
   * @param status - boolean status to set
   * @param type - 'email' or 'display'
   * @param showmessage - number flag to show message
   */
const update_camera_status_db = (status: boolean, type: string, showmessage: number): void => {
  setTableloader(true);
  setTimeout(() => {
    let url = "";
    if (type === 'email') {
      url = `${import.meta.env.VITE_BASE_URL}/api/camera/allEmailAutoAlert?alert=${status}`;
    } else {
      url = `${import.meta.env.VITE_BASE_URL}/api/camera/allDisplayAutoAlert?alert=${status}`;
    }
    callApi(url, { method: 'GET' })
      .then((res) => {
        if (res.data.success === true) {
          if (showmessage === 1) {
            setMessage(t("Camera alert status is updated successfully."));
            setOpen(true);
            getcameralist();
          }
        } else {
          setMessage(res.data.message);
          setOpen(true);
        }
        setTableloader(false);
      });
  }, 1000);
};

  /**
   * Updates camera alert status in Python backend.
   * @param status - boolean status to set
   * @param item - Camera object
   * @param type - 'email' or 'display'
   */
  const update_camera_status_py = (status: boolean, item: Camera, type: string): void => {
    setTimeout(() => {
      let emailAutoAlert = email_auto_alert;
      let displayAutoAlert = display_auto_alert;
      if (type === 'email') {
        emailAutoAlert = status;
        setemail_auto_alert(status);
      } else {
        displayAutoAlert = status;
        setdisplay_auto_alert(status);
      }
      const paramsPy = {
        camera_list: [
          {
            alerts: [],
            email_auto_alert: emailAutoAlert,
            display_auto_alert: displayAutoAlert,
            email_alert: email_alert,
            display_alert: display_alert,
            update_camera_name: item.Camera_Name ? item.Camera_Name.split(' ').join('_') : "",
            camera_name: item.Camera_Name,
            rtsp_link: item.Rtsp_Link,
            fps: item.FPS,
            rtsp_id: rtspdata ? rtspdata[item.Rtsp_Link]?.rtsp_id : undefined
          }
        ],
        type: 'restart',
      };
      const headersPy = {
        "Content-Type": "application/json",
        "accept": "application/json",
      };
      const urlPy = `${import.meta.env.VITE_START_SURVIELLANCE}`;
      callApi(urlPy, { method: 'POST', body: paramsPy, headers: headersPy })
        .then((res) => {
          console.log('surveillance res', res);
        });
    }, 1000);
  };

  /**
   * Toggles email auto alert for a single camera.
   * @param item - Camera object
   */
  const onChangeSingleEmailAlerts = (item: Camera): void => {
    const arr = cameraList.map(camera => {
      if (camera._id === item._id) {
        camera.Email_Auto_Alert = !camera.Email_Auto_Alert;
      }
      return camera;
    });
    const status = !item.Email_Auto_Alert;
    update_camera(status, item, 'email');
    setCameraList(arr);
  };

  /**
   * Toggles display auto alert for a single camera.
   * @param item - Camera object
   */
  const onChangeSingleDisplayAlerts = (item: Camera): void => {
    const arr = cameraList.map(camera => {
      if (camera._id === item._id) {
        camera.Display_Auto_Alert = !camera.Display_Auto_Alert;
      }
      return camera;
    });
    const status = !item.Display_Auto_Alert;
    update_camera(status, item, 'display');
    setCameraList(arr);
  };

  /**
   * Toggles row selection for a single camera.
   * @param id - camera _id string
   */
  const onChangeSingleRowSelected = (id: string): void => {
    const arr = cameraList.map(camera => {
      if (camera._id === id) {
        camera.rowselected = !camera.rowselected;
      }
      return camera;
    });
    setCameraList(arr);
  };

  /**
   * Fetches the list of active cameras from the backend.
   */
const getcameralist = (): void => {
  const url = `${VITE_base_url}/api/camgroup`;
  setTableloader(true);
  callApi(url, { method: 'GET' })
    .then((response) => {
      const arr: Camera[] = [];
      for (const item of response.data.cameras) {
        if (item.Active === true) {
          item.rowselected = allselected;
          arr.push(item);
        }
      }
      const priorityOrder: Record<string, number> = { High: 1, Medium: 2, Low: 3 };
      console.log(arr);
const sortedData = arr.sort(
  (a: any, b: any) => priorityOrder[a.Priority || "Low"] - priorityOrder[b.Priority || "Low"]
);
setCameraList(sortedData);

      setCopyCameraList(response.data.cameras);
      setTableloader(false);
    })
    .catch(() => {
      setTableloader(false);
    });
};

  // Runs on first mount to fetch camera list and check camera limit
  useEffect(() => {
    getcameralist();
    checkCamLimit();
  }, []);

  /**
   * Shows the camera table view.
   */
  const show_camera_tab = (): void => {
    setActivescreen(0);
    setActivepage('');
  };

  /**
   * Updates a camera's alert status.
   * @param status - boolean status to set
   * @param item - Camera object
   * @param type - 'email' or 'display'
   */
const update_camera = (status: boolean, item: Camera, type: string): void => {
  let params: any = {};
  if (type === 'email') {
    params = {
      rtsp_id: item.rtsp_id,
      Rtsp_Link: item.Rtsp_Link,
      Camera_Name: item.Camera_Name,
      Prev_Camera_Name: item.Camera_Name,
      Description: item.Description,
      Feature: item.Feature,
      Priority: item.Priority,
      Email_Auto_Alert: status,
      Display_Auto_Alert: item.Display_Auto_Alert,
      Email_Alert: item.Email_Alert,
      Display_Alert: item.Display_Alert
    };
  } else {
    params = {
      rtsp_id: item.rtsp_id,
      Rtsp_Link: item.Rtsp_Link,
      Camera_Name: item.Camera_Name,
      Prev_Camera_Name: item.Camera_Name,
      Description: item.Description,
      Feature: item.Feature,
      Priority: item.Priority,
      Email_Auto_Alert: item.Email_Auto_Alert,
      Display_Auto_Alert: status,
      Email_Alert: item.Email_Alert,
      Display_Alert: item.Display_Alert
    };
  }
  setTableloader(true);
  setTimeout(() => {
    const url = `${VITE_base_url}${import.meta.env.VITE_CAMERA_UPDATE}${item._id}`;
    let emailAutoAlert = email_auto_alert;
    let displayAutoAlert = display_auto_alert;
    if (type === 'email') {
      emailAutoAlert = status;
      setemail_auto_alert(status);
    } else {
      displayAutoAlert = status;
      setdisplay_auto_alert(status);
    }
    callApi(url, { method: 'PUT', body: params })
      .then((res) => {
        if (res.data.success === true) {
          setMessage(t("Camera alert status is updated successfully."));
          setOpen(true);
          getcameralist();
        } else {
          setMessage(res.data.message);
          setOpen(true);
        }
        setTableloader(false);
      });
  }, 1000);
};

  /**
   * Opens the add/edit camera page in edit mode.
   * @param item - Camera object to edit
   */
  const showeditpage = (item: Camera): void => {
    setCameradata(item);
    setActivescreen(1);
    props.setCamDirectory(false);
  };

  /**
   * Checks if the camera limit is exceeded.
   */
const checkCamLimit = (): void => {
  const url = `${VITE_base_url}/api/camera/limit`;
  callApi(url, { method: 'POST' })
    .then((response) => {
      if (response.data.success === true) {
        setIsCamLimitExceeded(response.data.isCamLimitExceeded);
        setMaxCam(response.data.camLimit);
      }
    })
    .catch(() => { });
};

  /**
   * Opens the add/view camera page in view mode.
   * @param item - Camera object to view
   */
  const showviewpage = (item: Camera): void => {
    setCameradata(item);
    setActivescreen(1);
    setActivepage('view');
    props.setCamDirectory(false);
  };

  /**
   * Opens the add new camera page.
   * Disables adding if camera limit exceeded.
   */
  const showaddpage = (): void => {
    setCameradata({});
    props.setCamDirectory(false);
    if (isCamLimitExceeded) {
      setDisableCamera(true);
      setMessage(t("You cannot add more camera, maximum limit is", {maxCam}));
      setOpen(true);
    } else {
      setActivescreen(1);
    }
  };

  /**
   * Shows the delete confirmation modal for a camera.
   * @param item - Camera object to delete
   */
  const showdeletemodal = (item: Camera): void => {
    setDeletemodalstatus(true);
    setCameraId(item._id);
  };

  /**
   * Shows the view modal for a camera.
   * @param item - Camera object to view
   */
  const showviewmodal = (item: Camera): void => {
    setViewModalStatus(true);
    setViewdata(item);
  };

  /**
   * Deletes a camera.
   */
const delete_camera = (): void => {
  setTableloader(true);
  const url = `${VITE_base_url}${import.meta.env.VITE_CAMERA_DELETE}${cameraId}`;
  callApi(url, { method: 'DELETE' })
    .then((res) => {
      if (res.data.success === true) {
        setMessage(t("cameraDeleteSuccess"));
        setOpen(true);
        setTableloader(false);
        setDeletemodalstatus(false);
        getcameralist();
      } else {
        setMessage(t("genericError"));
        setOpen(true);
        setTableloader(false);
      }
    });
};

  /**
   * Hides the delete confirmation modal.
   */
  const hide_delete_modal = (): void => {
    setDeletemodalstatus(false);
    setCameraId('');
  };

  /**
   * Updates email alert status for all cameras.
   * @param e - ChangeEvent<HTMLInputElement>
   */
  const update_email_alert = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setCameraemailalerts(e.target.checked);
    const headers = {
      "Content-Type": "application/json; charset=utf-8"
    };
    const url = `${VITE_base_url}${import.meta.env.VITE_CAMERA_ALL_EMAIL_ALERTS}alert=${e.target.checked}`;
    setTableloader(true);
    callApi(url, { method: 'GET', headers })
      .then((res) => {
        if (res.data.success === true) {
          setMessage(t("Email alert status is updated successfully.."));
          setOpen(true);
          setTableloader(false);
        } else {
          setMessage(t("genericError"));
          setOpen(true);
        }
      });
    const type = "email";
    cameraList.forEach((item) => {
      alert_update(item, type, e.target.checked);
    });
  };

  /**
   * Updates display alert status for all cameras.
   * @param e - ChangeEvent<HTMLInputElement>
   */
  const update_display_alert = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setCameradisplayalerts(e.target.checked);
    const headers = {
      "Content-Type": "application/json; charset=utf-8"
    };
    const url = `${VITE_base_url}${import.meta.env.VITE_CAMERA_ALL_DISPLAY_ALERTS}alert=${e.target.checked}`;
    setTableloader(true);
    callApi(url, { method: 'GET', headers })
      .then((res) => {
        if (res.data.success === true) {
          setMessage(t("Display alert status is updated successfully.."));
          setOpen(true);
          setTableloader(false);
        } else {
          setMessage(t("genericError"));
          setOpen(true);
        }
      });
    const type = "display";
    cameraList.forEach((item) => {
      alert_update(item, type, e.target.checked);
    });
  };

  /**
   * Updates alert status in Python backend.
   * @param item - Camera object
   * @param type - 'email' or 'display'
   * @param status - boolean status to set
   */
  const alert_update = (item: Camera, type: string, status: boolean): void => {
    setTimeout(() => {
      let emailAlert = email_alert;
      let displayAlert = display_alert;
      if (type === 'email') {
        emailAlert = status;
        setemail_alert(status);
      } else {
        displayAlert = status;
        setdisplay_alert(status);
      }
      const paramsPy = {
        camera_list: [
          {
            alerts: [],
            email_auto_alert: email_auto_alert,
            display_auto_alert: display_auto_alert,
            email_alert: emailAlert,
            display_alert: displayAlert,
            update_camera_name: item.Camera_Name,
            camera_name: item.Camera_Name,
            rtsp_link: item.Rtsp_Link,
            fps: item.FPS,
            rtsp_id: rtspdata ? rtspdata[item.Rtsp_Link]?.rtsp_id : undefined
          }
        ],
        type: 'restart',
        emails: localStorage.getItem('emailList') ? localStorage.getItem('emailList') : [],
      };
      const headersPy = {
        "Content-Type": "application/json",
        "accept": "application/json",
      };
      const urlPy = `${import.meta.env.VITE_START_SURVIELLANCE}`;
      callApi(urlPy, { method: 'POST', body: paramsPy, headers: headersPy })
        .then((res) => {
          console.log('surveillance res', res);
        });
    }, 1000);
  };

  // Disable scroll for default screen when cameras count is between 0 and 3
  const dependencyArray = activescreen === 0 && cameraList?.length >= 0 && cameraList?.length <= 3 ? [] : [1];
  useRemoveScroll(dependencyArray);

  return (
    <section className='camera-directory-list-section' style={{ marginTop: -15 }}>
      {activescreen === 1 ? (
        <>
          {/* Add new camera component */}
          <Add
            showScreen={show_camera_tab}
            loadlist={getcameralist}
            cameradata={cameradata}
            list={copyCameraList}
            activescreen={activepage}
            setMessage={setMessage}
            setOpen={setOpen}
            setWarning={setWarning}
            setCamDirectory={props.setCamDirectory}
            renderedFrom={'CamDirectory'}
          />
        </>
      ) : (
        <div className="container widthCls">
          <Messagebox
            open={open}
            handleClose={handleClose}
            message={message}
            warning={warning}
          />
          <div className="row top-filter-section">
            {tableloader ? (
              <Box sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                <CircularProgress />
              </Box>
            ) : (
              <CameraSettingsPanel
                is_mobile={is_mobile}
                allselected={allselected}
                emailalertstatus={emailalertstatus}
                displayalertstatus={displayalertstatus}
                cameraemailalerts={cameraemailalerts}
                cameradisplayalerts={cameradisplayalerts}
                isCamLimitExceeded={isCamLimitExceeded}
                cameraList={cameraList}
                handleSelectAll={handleSelectAll}
                handleemailalerts={handleemailalerts}
                handledisplayalerts={handledisplayalerts}
                update_email_alert={update_email_alert}
                update_display_alert={update_display_alert}
                showaddpage={showaddpage}
                onChangeSingleRowSelected={onChangeSingleRowSelected}
                onChangeSingleEmailAlerts={onChangeSingleEmailAlerts}
                onChangeSingleDisplayAlerts={onChangeSingleDisplayAlerts}
                showeditpage={showeditpage}
                showviewpage={showviewpage}
                showdeletemodal={showdeletemodal}
              />
            )}
            {/* Delete modal */}
            <Modal show={deletemodalstatus} onHide={hide_delete_modal} centered>
              <Modal.Header closeButton>
                <Modal.Title>{t("Delete Confirmation")}</Modal.Title>
              </Modal.Header>
              <Modal.Body>
                <p style={{ padding: '0px 16px', fontSize: 16 }}>
                  {t("Are you sure you want to delete the selected camera?")}
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onClick={hide_delete_modal}>
                  {t("Cancel")}
                </Button>
                <button className="deletebutton" onClick={delete_camera}>
                 {t("Delete")}
                </button>
              </Modal.Footer>
            </Modal>
            {/* View modal */}
            <Modal show={viewmodalstatus} onHide={() => setViewModalStatus(false)} size="lg">
             <Modal.Header closeButton>
    <Modal.Title>{t("Camera Details")}</Modal.Title>
  </Modal.Header>
  <Modal.Body>
    <p style={{ padding: '0 0', fontSize: 15 }}>
      <b>{t("Camera name")}:</b> {viewdata?.Camera_Name ?? '---'}<br />
      <b>{t("Description")}:</b> {viewdata?.Description ?? '---'}<br />
      <b>{t("Display auto alert")}:</b> {viewdata?.Display_Auto_Alert === true ? t("Yes") : t("No")}<br />
      <b>{t("Email auto alert")}:</b> {viewdata?.Email_Auto_Alert === true ? t("Yes") : t("No")}<br />
      <b>{t("Priority")}:</b> {viewdata?.Priority ?? '---'}<br />
      <b>{t("Link")}:</b> {viewdata?.Rtsp_Link ?? '---'}<br />
      <b>{t("Status")}:</b> {viewdata?.Status ?? '---'}<br />
    </p>
  </Modal.Body>
            </Modal>
          </div>
        </div>
      )}
    </section>
  );
};

export default List;
