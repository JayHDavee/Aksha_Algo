import React, { useState, useEffect } from 'react';
import { Modal } from 'react-bootstrap'; // Assuming react-bootstrap Modal is used
import { CancelRounded } from '@mui/icons-material'; // Assuming Material-UI icon
import Tooltip from '@mui/material/Tooltip';
import CanvasDraw2 from '../CanvasDraw2'; // Assuming this component exists
import ImageBox from '../ImageBox'; // Assuming this component exists
import CustomTimePicker from '../CustomTimePicker';
import { useTranslation } from 'react-i18next';

/**
 * @typedef {Object} Camera
 * @property {string} Camera_Name - The name of the camera.
 * // Add other camera properties if known
 */
interface Camera {
  Camera_Name: string;
  // Add other properties as needed, e.g., id: string; imageUrl: string;
}

/**
 * @typedef {Object} WeekDay
 * @property {number} id - Unique ID for the weekday.
 * @property {string} name - Name of the weekday (e.g., "Mon", "Tue").
 * @property {boolean} selected - Whether the weekday is selected.
 */
interface WeekDay {
  id: number;
  name: string;
  selected: boolean;
}

/**
 * @interface AlertConfigurationModalProps
 * @property {boolean} show - Controls the visibility of the modal.
 * @property {() => void} handleClose - Function to call when the modal is closed.
 * @property {boolean} [calledInsideMenu] - Optional prop to determine styling based on where it's called.
 * @property {'view' | 'add' | 'edit'} modalopened - Indicates the mode of the modal (view, add, edit).
 * @property {'add' | 'edit'} submittype - Indicates the submission type (add or edit).
 * @property {string} alert_name - The name of the alert.
 * @property {string} alert_description - The description of the alert.
 * @property {string} selectedCamera - The currently selected camera.
 * @property {Camera[]} cameralist - List of available cameras.
 * @property {string} selectedObjectofInter - The currently selected object of interest.
 * @property {string[]} listofobjectlabels - List of available object labels.
 * @property {boolean} No_Object_Status - Status for "No Object" alert.
 * @property {boolean} working_day - Indicates if working day is selected for scheduling.
 * @property {boolean} holiday - Indicates if holiday is selected for scheduling.
 * @property {WeekDay[]} weeks - Array of weekday objects for custom scheduling.
 * @property {string} start_time - The start time for the alert schedule.
 * @property {string} end_time - The end time for the alert schedule.
 * @property {boolean} isMobileDevice - Indicates if the current device is a mobile device.
 * @property {string[]} add_camera_img - Array of image URLs for added cameras.
 * @property {any} viewdata - Data related to the currently viewed alert.
 * @property {any[]} listOfCamera - List of cameras for viewing/editing.
 * @property {string | null} camera_img - The image URL of the selected camera.
 * @property {string} aipollygon - AI polygon data for the image.
 * @property {boolean} editImageAOI - Controls whether Area of Interest (AOI) can be edited on the image.
 * @property {boolean} isClose - Indicates if the modal is closing.
 * @property {(event: React.ChangeEvent<HTMLSelectElement>) => void} handleChangeCamera - Handler for camera selection change.
 * @property {(event: React.ChangeEvent<HTMLInputElement>) => void} handleSelectAllCameras - Handler for select all cameras checkbox.
 * @property {(event: React.ChangeEvent<HTMLSelectElement>) => void} handleChangeObjectofInter - Handler for object of interest selection change.
 * @property {(event: React.ChangeEvent<HTMLInputElement>) => void} handleObjectCheckChange - Handler for no object check change.
 * @property {(event: React.ChangeEvent<HTMLSelectElement>) => void} handleChangeFrequency - Handler for frequency selection change.
 * @property {(id: number) => void} handleChangeWeek - Handler for weekday selection change.
 * @property {(points: number[][]) => void} setAIPolygen - Function to set AI polygon data.
 * @property {() => void} showstep0 - Function to navigate to step 0.
 * @property {() => void} showstep1 - Function to navigate to step 1.
 * @property {() => void} showstep2 - Function to navigate to step 2.
 * @property {() => void} submit_button - Function to handle form submission.
 */
interface AlertConfigurationModalProps {
  modalStatus: boolean;
  handleClose: () => void;
  calledInsideMenu?: boolean;
  modalopened: string;
  submittype: string;
  alert_name: string;
  activeStep: any;
  selectedFrequency: string;
  alert_description: string;
  selectedCamera: string[];
  cameralist: Camera[];
  alertlist?: { Alert_Name: string; Camera_Name: string; [key: string]: any }[];
  selectedObjectofInter: string;
  listofobjectlabels: string[];
  No_Object_Status: boolean;
  working_day: boolean;
  holiday: boolean;
  weeks: WeekDay[];
  start_time: any;
  end_time: any;
  isMobileDevice: boolean;
  add_camera_img: string[];
  viewdata: any; // Consider defining a more specific type for viewdata if possible
  viewimagedata: any;
  listOfCamera: any[]; // Consider defining a more specific type for listOfCamera if possible
  camera_img: string | null;
  aipollygon: string; // The previous prompt had this as `string`, but the `setAIPolygen` takes `number[][]`. It should be consistent.
  editImageAOI: boolean;
  isClose: boolean;
  hangleEditImageAOI: () => void
  handleChangeStartTime: (value: any, index: any) => void,
  handleChangeEndTime: (value: string, index: any) => void,
  handleAlertName: (event: any) => void;
  handleAlertDescription: (event: any) => void;
  handleChangeCamera: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  handleSelectAllCameras: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleChangeObjectofInter: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  handleObjectCheckChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleChangeFrequency: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  handleChangeWeek: (id: number) => void;
  setAIPolygen: (points: number[][]) => void;
  showstep0: () => void;
  showstep1: () => void;
  showstep2: () => void;
  submit_button: () => void;
}

/**
 * AlertConfigurationModal component for creating, viewing, and editing alerts.
 * It features a multi-step form for alert details, scheduling, and confirmation,
 * including camera selection, object of interest, and drawing Area of Interest (AOI).
 *
 * @param {AlertConfigurationModalProps} props - The properties for the component.
 * @returns {React.FC<AlertConfigurationModalProps>} A React functional component.
 */

/**
 * AlertConfigurationModal component for creating, viewing, and editing alerts.
 * It features a multi-step form for alert details, scheduling, and confirmation,
 * including camera selection, object of interest, and drawing Area of Interest (AOI).
 *
 * @param {AlertConfigurationModalProps} props - The properties for the component.
 * @returns {React.FC<AlertConfigurationModalProps>} A React functional component.
 **/

const AlertConfigurationModal: React.FC<AlertConfigurationModalProps> = ({
  modalStatus,
  activeStep,
  selectedFrequency,
  handleClose,
  calledInsideMenu,
  modalopened,
  submittype,
  alert_name,
  alert_description,
  selectedCamera,
  cameralist,
  alertlist,
  selectedObjectofInter,
  listofobjectlabels,
  No_Object_Status,
  working_day,
  holiday,
  weeks,
  start_time,
  end_time,
  isMobileDevice,
  add_camera_img,
  viewdata,
  viewimagedata,
  listOfCamera,
  camera_img,
  aipollygon,
  editImageAOI,
  isClose,
  hangleEditImageAOI,
  handleChangeStartTime,
  handleChangeEndTime,
  handleAlertName,
  handleAlertDescription,
  handleChangeCamera,
  handleSelectAllCameras,
  handleChangeObjectofInter,
  handleObjectCheckChange,
  handleChangeFrequency,
  handleChangeWeek,
  setAIPolygen,
  showstep0,
  showstep1,
  showstep2,
  submit_button,
}) => {
  const { t } = useTranslation();
  // State to manage the active step of the multi-step form

  // Derive the action button class based on modalopened status for step 0
  const actionButtonClass =
    modalopened === 'view'
      ? 'filled-button'
      : 'filled-button';

  // State to manage the edit mode for Area of Interest (AOI) image
  const [isEditImageAOI, setIsEditImageAOI] = useState(editImageAOI);

  // Effect to update isEditImageAOI when the prop changes
  useEffect(() => {
    setIsEditImageAOI(editImageAOI);
  }, [editImageAOI]);

  return (
    <Modal
      show={modalStatus}
      onHide={handleClose}
      dialogClassName="add-camera-modal"
      size="lg"
      animation={false}
    >
      <Modal.Body className="alertbox-width">
        <div className="add-camera-step-form">
          {/* Step indicators for the alert configuration process */}
          <div className="step-items">
            {/* Step 1: Alert Details */}
            <div className="item">
              <div
                className={
                  activeStep === 0 || activeStep === 1 || activeStep === 2 || activeStep === 3
                    ? 'icon active'
                    : 'icon'
                }
              >
                1
              </div>
              <span >{t("Alert Details")}</span>
              <div
                className={
                  activeStep === 1 || activeStep === 2 || activeStep === 3
                    ? 'line active'
                    : 'line'
                }
              ></div>
            </div>
            {/* Step 2: Alert Schedule */}
            <div className="item">
              <div
                className={
                  activeStep === 1 || activeStep === 2 || activeStep === 3
                    ? 'icon active'
                    : 'icon'
                }
              >
                2
              </div>
              <span>{t("Alert schedule")}</span>
              <div
                className={
                  activeStep === 2 || activeStep === 3 ? 'line active' : 'line'
                }
              ></div>
            </div>
            {/* Step 3: Save Alert */}
            <div className="item">
              <div
                className={
                  activeStep === 3 ? 'icon active' : 'icon'
                }
              >
                3
              </div>
              <span>{t("Save alert")}</span>
            </div>
            {/* Cancel button */}
            <CancelRounded className="canceloutlined" onClick={handleClose} />
          </div>
          {/* css for steps ends here*/}

          <div className="container container-style">
            <div>
              <div className="col-lg-12-main-camera-div">
                <div className="col-lg-5 overflow-hidden">
                  <div className="row-align-items-start">
                    {/* Step 0: Alert Details - without buttons portion starts here */}
                    {activeStep === 0 && (
                      <div
                        className={
                          calledInsideMenu
                            ? 'col-lg-12 left-content AlertCls w-100 mb-1 mt-2'
                            : 'col-lg-12 left-content AlertCls w-100 mt-1 mb-2 '
                        }
                      >
                        <h2 className="alert-details-heading" >{t("Alert Details")}</h2>
                        <span>
                          {t("Add alert name, type camera & area of interest")}
                        </span>
                        <br />
                        <br />
                        {/* Alert Name Input */}
                        <div className="single-fleld" style={{marginBottom:"4px"}}>
                          <label className="labels"  htmlFor="">
                            {t("Alert Name")}
                          </label>
                          <br />
                          <input
                            type="text"
                            placeholder={t("Eg. Vehicle entry")}
                            value={alert_name}
                            className="textlabel"
                            onChange={handleAlertName} //get alert name
                            style={{ width: "80%", height: '40px', marginTop:"4px" }}

                          />
                        </div>

                        {/* Alert Description Input */}
                        <div className="single-fleld">
                          <label className="labels" htmlFor="">
                            {t("Alert Description")}
                          </label>
                          <br />
                          <textarea
                            placeholder={t("Alert on vehicle entry in premises")}
                            cols={50}
                            rows={2}
                            maxLength={200}
                            value={alert_description}
                            className="alertdescription"
                            onChange={handleAlertDescription} //get Alert Description
                            style={{ width: "80%",  marginTop:"4px" }}
                          ></textarea>
                        </div>

                        <div className="row px-0">
                          {/* Camera Selection */}
                          <div className="col-lg-12 widtCls mb-1">
                            <div className="single-fleld">
                              <label className="labels" htmlFor="">
                                {t("Camera")}
                              </label>
                              <br />
                              <>
                                <select
                                  // selectedCamera is typed string[] but this is a
                                  // single (non-multiple) select — an array value
                                  // never matches any <option>, so it silently
                                  // renders blank. Coerce to a plain string.
                                  value={Array.isArray(selectedCamera) ? (selectedCamera[0] || '') : (selectedCamera || '')}
                                  onChange={handleChangeCamera}
                                  className="form-select-cam"
                                  style={{
                                    // backgroundColor: 'white',
                                    width: '80%',
                                    height: '40px',
                                    marginTop: '4px',
                                    pointerEvents:
                                      modalopened === 'view' ? 'none' : 'auto',
                                  }}
                                >
                                  {cameralist &&
                                    cameralist.map((item, index) => (
                                      <option
                                        value={item.Camera_Name}
                                        key={index}
                                      >
                                        {item.Camera_Name}
                                      </option>
                                    ))}
                                </select>
                              </>

                              {/* Select All Cameras Checkbox */}
                              <div className="form-check mt-3">
                                <input
                                  className="form-check-input selectallcameras-input"
                                  type="checkbox"
                                  id="selectallcameras"
                                  onChange={handleSelectAllCameras} //checkbox to select all cams
                                  style={{ position: 'relative', top: '-2px' }}
                                />
                                &nbsp;&nbsp;
                                <label
                                  //className="form-check-label"
                                  className="selectallcameras-label"
                                  htmlFor="selectallcameras"
                                >
                                  {t("Select All Cameras")}
                                </label>
                              </div>
                            </div>
                          </div>

                          {/* Object of Interest Selection */}
                          <div className="cancelsavebtn">
                            <div className="ooi">
                              <div className="col-12">
                                <div className="ooi-align">
                                  <label className='labels' style={{ marginTop:"5px",marginBottom:"5px"}} htmlFor="">{t("Object of interest")}</label>
                                  <br />
                                  <>
                                    <select
                                      value={selectedObjectofInter}
                                      onChange={handleChangeObjectofInter}
                                      className="form-select-ooi "
                                      style={{
                                        // backgroundColor: 'white',
                                        width: '80%',
                                        height: '40px',
                                        paddingLeft:'10px',
                                        pointerEvents:
                                          modalopened === 'view'
                                            ? 'none'
                                            : 'auto'

                                      }}
                                    >
                                      {listofobjectlabels.map((item: any, index: any) => (
                                        <option value={item} key={index}>
                                          {t(item)}
                                        </option>
                                      ))}
                                    </select>
                                  </>
                                </div>
                              </div>

                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Step 0: Alert Details - without buttons portion ends here */}

                    {/* Step 1: Alert Schedule - without buttons portion starts here */}
                    {activeStep === 1 && (
                      <div className="col-lg-10 left-content AlertCls mt-2 pe-5">
                        <h2>{t("Alert Schedule")}</h2>
                        <span>{t("Add days, time and repetition")}</span>
                        <br />
                        <br />
                        {/* Frequency Selection */}
                        <div className="single-fleld">
                          <label htmlFor="" style={{marginBottom:"6px"}}>{t("Frequency")}</label>
                          <>
                            <select
                              value={selectedFrequency} // Assuming selectedFrequency is a state from parent
                              onChange={handleChangeFrequency}
                              className="form-select"
                              style={{
                                backgroundColor: 'white',
                                width: '100%',
                                height: '45px',
                                marginTop: '-3px',
                                fontSize: '15px',
                                pointerEvents:
                                  modalopened === 'view' ? 'none' : 'auto',
                              }}
                            >
                              <option value="Daily">{t("Daily")}</option>
                              <option value="Custom">{t("Custom")}</option>
                            </select>
                          </>
                        </div>




                        {/* Selected Days for Custom Frequency */}
                        <div className="selected-days mt-3">
                          {weeks &&
                            weeks.map((item: any, index: any) => {
                              return (
                                <div className="day" key={index}>
                                  <div className="form-check">
                                    <input
                                      className="form-check-input"
                                      type="checkbox"
                                      id="flexCheckDefault"
                                      checked={item.selected}
                                      onChange={() =>
                                        handleChangeWeek && handleChangeWeek(item.id)
                                      }
                                    />
                                  </div>
                                  <p>{t(item.name)}</p>
                                </div>
                              );
                            })}
                        </div>

                        <div className="row" style={{ marginTop: "12px", display: "flex", gap: "16px", flexWrap: "wrap" }}>
                          {/* From Time Picker */}
                          <div className="mb-3" style={{ flex: "1 1 200px", minWidth: 0 }}>
                            <CustomTimePicker
                              label={t("From")}
                              value={start_time}
                              onChange={(value, index) => handleChangeStartTime(value, index)}
                            />
                          </div>

                          {/* To Time Picker */}
                          <div className="mb-3" style={{ flex: "1 1 200px", minWidth: 0 }}>
                            <CustomTimePicker
                              label={t("To")}
                              value={end_time}
                              onChange={(value, index) => handleChangeEndTime(value, index)}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Step 1: Alert Schedule - without buttons portion ends here */}

                    {/* Step 2 or 3: All Set! Confirmation - without buttons portion starts here */}
                    {(activeStep === 2 || activeStep === 3) && (
                      <div
                        className="left-content"
                        style={{ marginRight: '10px' }}
                      >
                        <h2>{t("All Set!")}</h2>
                        <span>{t("Confirm details and save alert")}</span>
                        <br />
                        <div className="alert-card">
                          <div className="alert-header">
                            <img
                              src="./assets/img/Warning.png"
                              className="modal-alert-img"
                              alt="Warning"
                            />
                            {alert_name}
                            {modalopened === 'view' ? (
                              <img
                                src="./assets/img/checks.png"
                                className="modal-Checks-img"
                                alt="checks"
                              />
                            ) : (
                              <i className="bx bx-pencil modal-pencil-img"></i>
                            )}
                          </div>
                          <div className="content px-3 py-0">
                            <div className="row px-0 mb-1">
                              {/* Object of interest in confirmation step */}
                              <div className="col-lg-6">
                                <div className="single-fleld">
                                  <label htmlFor="objectofinterst" style={{ marginTop: "10px" }}> {t("Object of interest")}</label>
                                  <>
                                    <select
                                      value={selectedObjectofInter}
                                      onChange={handleChangeObjectofInter}
                                      className="form-select"
                                      style={{
                                        backgroundColor: 'white',
                                        width: '100%',
                                        height: '40px',
                                        marginTop: '5px',
                                        fontSize: '15px',
                                        pointerEvents:
                                          modalopened === 'view'
                                            ? 'none'
                                            : 'auto',
                                      }}
                                    >
                                      {listofobjectlabels.map((item, index) => (
                                        <option value={item} key={index}>
                                          {t(item)}
                                        </option>
                                      ))}
                                    </select>
                                  </>
                                </div>
                              </div>
                              {/* Frequency in confirmation step */}
                              <div className="col-lg-6">
                                <div className="single-fleld">
                                  <label htmlFor="" style={{ marginTop: "10px" }}>{t("Frequency")}</label>
                                  <>
                                    <select
                                      value={selectedFrequency} // Assuming selectedFrequency is a state from parent
                                      onChange={handleChangeFrequency}
                                      className="form-select"
                                      style={{
                                        backgroundColor: 'white',
                                        width: '100%',
                                        height: '40px',
                                        marginTop: '5px',
                                        fontSize: '15px',
                                        pointerEvents:
                                          modalopened === 'view'
                                            ? 'none'
                                            : 'auto',
                                      }}
                                    >
                                      <option value="Daily">{t("Daily")}</option>
                                      <option value="Custom">{t("Custom")}</option>
                                    </select>
                                  </>
                                </div>
                              </div>
                            </div>
                            {/* Selected Days in confirmation step */}
                            <div className="selected-days-pg3">
                              {weeks &&
                                weeks.map((item, index) => {
                                  return (
                                    <div
                                      className="day"
                                      key={index}
                                      style={{
                                        pointerEvents:
                                          modalopened === 'view'
                                            ? 'none'
                                            : 'auto',
                                      }}
                                    >
                                      <div className="form-check">
                                        <input
                                          className="form-check-input"
                                          type="checkbox"
                                          id="flexCheckDefault"
                                          checked={item.selected}
                                          onChange={() =>
                                            handleChangeWeek && handleChangeWeek(item.id)
                                          }
                                        />
                                      </div>
                                      <p>{t(item.name)}</p>
                                    </div>
                                  );
                                })}
                            </div>
                            <div className="px-0" style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "16px" }}>
                              {/* From Time in confirmation step */}
                              <div className="mb-1" style={{ flex: "1 1 160px", minWidth: 0 }}>
                                <CustomTimePicker
                                  label={t('From')}
                                  disabled={submittype === 'view'}
                                  value={start_time}
                                  onChange={(value, index) => handleChangeStartTime(value, index)}
                                />
                              </div>
                              {/* To Time in confirmation step */}
                              <div className="mb-1" style={{ flex: "1 1 160px", minWidth: 0 }}>
                                <CustomTimePicker
                                  label={t('To')}
                                  disabled={submittype === 'view'}
                                  value={end_time}
                                  onChange={(value, index) => handleChangeEndTime(value, index)}
                                />
                              </div>
                              {/* Camera selection in confirmation step */}
                              <div className="mb-2" style={{ flex: "1 1 100%" }}>
                                <div className="single-fleld">
                                  <label style={{ marginBottom: "6px" }} htmlFor="">{t("Camera")}</label>
                                  <br />
                                  <>
                                    <select
                                      value={Array.isArray(selectedCamera) ? (selectedCamera[0] || '') : (selectedCamera || '')}
                                      onChange={handleChangeCamera}
                                      className="form-select"
                                      style={{
                                        backgroundColor: 'white',
                                        width: '100%',
                                        height: '45px',
                                        marginTop: '-3px',
                                        pointerEvents:
                                          modalopened === 'view'
                                            ? 'none'
                                            : 'auto',
                                      }}
                                    >
                                      {cameralist &&
                                        cameralist.map((item, index) => (
                                          <option
                                            value={item.Camera_Name}
                                            key={index}
                                          >
                                            {item.Camera_Name}
                                          </option>
                                        ))}
                                    </select>
                                  </>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Step 2 or 3: All Set! Confirmation - without buttons portion ends here */}

                    {/* Action buttons for desktop view (not mobile) */}
                    {!isMobileDevice && (
                      <div>
                        {activeStep === 0 && (
                          <div className="form-button-group">
                            <button className="outlined-button" onClick={handleClose}>
                              {t("Cancel")}
                            </button>
                            {modalopened === 'view' ? (
                              <button onClick={showstep1} className={actionButtonClass}>
                                {t("Next")}
                              </button>
                            ) : (
                              <button onClick={showstep1} className={actionButtonClass}>
                                {t("Save & Continue")}
                              </button>
                            )}
                          </div>
                        )}

                        {activeStep === 1 && (
                          <div className="form-button-group alert-modal-action-button-main-div-2">
                            <button className="outlined-button" onClick={showstep0}>
                              {t("Back")}
                            </button>
                            {modalopened === 'view' ? (
                              <button onClick={showstep2} className="filled-button">
                                {t("Next")}
                              </button>
                            ) : (
                              <button onClick={showstep2} className="filled-button">
                                {t("Save & Continue")}
                              </button>
                            )}
                          </div>
                        )}

                        {(activeStep === 2 || activeStep === 3) &&
                          modalopened !== 'view' && (
                            <div className="form-button-group">
                              <button className="outlined-button" onClick={showstep1}>
                                {t("Back")}
                              </button>
                              <button
                                onClick={submit_button}
                                className="filled-button"
                              >
                                {t("Save Alert")}
                              </button>
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Right content for camera image display and AOI */}
                <div className="rightcontent-cameraimgClsAlert">
                  {/* Display images for "add" mode when images are present */}
                  {submittype === 'add' && add_camera_img.length > 0 && (
                    <div className="camera-list-scroll">
                      {add_camera_img.map((item, index) => {
                        // selectedCamera is populated from the same source,
                        // in the same order, as add_camera_img — use the real
                        // camera name instead of the raw image filename.
                        const cameraName = selectedCamera[index] || item.split('/').pop();
                        const cameraDetails = cameralist?.find(
                          (cam) => cam.Camera_Name === cameraName
                        ) as any;
                        const cameraAlerts = (alertlist ?? []).filter(
                          (alert) => alert.Camera_Name === cameraName
                        );
                        const tooltipContent = (
                          <>
                            <div>
                              {t("Priority")}: {cameraDetails?.Priority || t("Not set")}
                            </div>
                            <div>
                              {t("Alerts set")}:{" "}
                              {cameraAlerts.length > 0
                                ? cameraAlerts.map((a) => a.Alert_Name).join(", ")
                                : t("None")}
                            </div>
                          </>
                        );
                        return (
                          <div key={index} className="mb-3">
                            <div
                              style={isMobileDevice ? { overflow: 'scroll' } : {}}
                            >
                              {item ? (
                                <div className="aoi-media-box">
                                  <CanvasDraw2
                                    imageUrl={item}
                                    setAIPolygen={setAIPolygen}
                                    styleProperities={{
                                      width: 640,
                                      height: 360,
                                    }}
                                    imagesLength={add_camera_img.length}
                                    isClose={isClose}
                                  />
                                </div>
                              ) : (
                                <div></div>
                              )}
                            </div>

                            {/* Displays camera name below the image, with alert/priority info on hover */}
                            <Tooltip title={tooltipContent} arrow placement="bottom">
                              <p className="camera-name-label">
                                {item && <b>{t("Camera name:")}</b>}{' '}
                                <span>{cameraName}</span>
                              </p>
                            </Tooltip>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* If view or edit mode, display image and AOI without drawing capability initially */}
                  {(modalopened === 'view' || submittype === 'edit') &&
                    selectedCamera.length > 0 && (
                      <div className="mt-4">
                        {viewdata.Camera_Name.length > 0 && (
                          <div className="camera-list-scroll">
                            {listOfCamera.map((item, index) => {
                              if (item !== '') {
                                return (
                                  selectedCamera.length > 0 && (
                                    <div key={index} className="mb-3">
                                      <p>
                                        <b></b>{' '}
                                        {item.name ? item.name : '---'}{' '}
                                      </p>

                                      <div
                                        style={
                                          isMobileDevice
                                            ? { overflow: 'scroll' }
                                            : {}
                                        }
                                      >
                                        <img
                                          src={item.image}
                                          alt="cam-img"
                                          style={{
                                            width: "100%",
                                            maxWidth: "640px",
                                            aspectRatio: "16 / 9",
                                            height: "auto",
                                            objectFit: "contain"
                                          }}
                                        />
                                      </div>
                                    </div>
                                  )
                                );
                              }
                            })}
                          </div>
                        )}
                      </div>
                    )}

                  {camera_img !== null &&
                    camera_img !== '' &&
                    add_camera_img.length === 0 && (
                      <div>
                        {(modalopened === 'view' || submittype === 'edit') &&
                          selectedCamera.length > 0 && (
                            <>
                              <div className="view-edit-img-mode">
                                {/* Switch and reset button for AOI editing */}
                                {modalopened !== 'view' && (
                                  <div className="img-edit-button">
                                    <button
                                      className="edit-buttom"
                                      onClick={hangleEditImageAOI}
                                    >
                                      {t("Edit")}
                                      <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        viewBox="0 0 24 24"
                                      >
                                        <path
                                          fill="currentColor"
                                          d="m14.06 9l.94.94L5.92 19H5v-.92zm3.6-6c-.25 0-.51.1-.7.29l-1.83 1.83l3.75 3.75l1.83-1.83c.39-.39.39-1.04 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29m-3.6 3.19L3 17.25V21h3.75L17.81 9.94z"
                                        />
                                      </svg>
                                    </button>
                                  </div>
                                )}
                                {editImageAOI ? (
                                  <div className="aoi-media-box">
                                    <CanvasDraw2
                                      imageUrl={camera_img}
                                      setAIPolygen={setAIPolygen}
                                      styleProperities={{
                                        width: 640,
                                        height: 360,
                                      }}
                                      imagesLength={add_camera_img.length}
                                      isClose={isClose}
                                    />
                                  </div>
                                ) : (
                                  <div className="aoi-media-box">
                                    <div style={{ width: '100%', maxWidth: 640, aspectRatio: '16 / 9' }}>
                                      <ImageBox data={viewimagedata} aIPolygen={''} /> {/* Assuming viewimagedata is passed or derived */}
                                    </div>
                                  </div>
                                )}
                              </div>
                              {/* Alert Details below image */}
                              {/* Only show for "No Person" alert */}
                              {selectedObjectofInter === 'person' &&
                                !No_Object_Status && (
                                  <div className="alert-type-details">
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      className="icon icon-tabler icons-tabler-outline icon-tabler-user-off"
                                    >
                                      <path
                                        stroke="none"
                                        d="M0 0h24v24H0z"
                                        fill="none"
                                      />
                                      <path d="M8.18 8.189a4.01 4.01 0 0 0 2.616 2.627m3.507 -.545a4 4 0 1 0 -5.59 -5.552" />
                                      <path d="M6 21v-2a4 4 0 0 1 4 -4h4c.412 0 .81 .062 1.183 .178m2.633 2.618c.12 .38 .184 .785 .184 1.204v2" />
                                      <path d="M3 3l18 18" />
                                    </svg>
                                    Alert created for 'No Person'
                                  </div>
                                )}
                            </>
                          )}
                      </div>
                    )}
                </div>
                {/* Action buttons for mobile view */}
                {isMobileDevice && (
                  <div>
                    {activeStep === 0 && (
                      <div className="form-button-group margin-top-70">
                        <button className="outlined-button" onClick={handleClose}>
                          Cancel
                        </button>
                        {modalopened === 'view' ? (
                          <button onClick={showstep1} className="filled-button">
                            Next
                          </button>
                        ) : (
                          <button onClick={showstep1} className="filled-button">
                            Save & Continue
                          </button>
                        )}
                      </div>
                    )}

                    {activeStep === 1 && (
                      <div className="form-button-group margin-top-70">
                        <button className="outlined-button" onClick={showstep0}>
                          Back
                        </button>
                        {modalopened === 'view' ? (
                          <button onClick={showstep2} className="filled-button">
                            Next
                          </button>
                        ) : (
                          <button onClick={showstep2} className="filled-button">
                            Save & Continue
                          </button>
                        )}
                      </div>
                    )}

                    {(activeStep === 2 || activeStep === 3) &&
                      modalopened !== 'view' && (
                        <div className="form-button-group">
                          <button className="outlined-button" onClick={showstep1}>
                            Back
                          </button>
                          <button
                            onClick={submit_button}
                            className="filled-button margin-right-ten-perc"
                          >
                            Save
                          </button>
                        </div>
                      )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </Modal.Body>
    </Modal>
  );
};

export default AlertConfigurationModal;