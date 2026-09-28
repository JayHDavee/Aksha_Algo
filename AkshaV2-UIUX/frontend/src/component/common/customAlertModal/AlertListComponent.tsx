import React from 'react';
import { Box, CircularProgress, Tooltip } from '@mui/material';
import NoDataFound from '../../../container/cameraDirectory/NoDataFound/NoDataFound'; // Assuming you have a NoDataFound component
import DeleteAlertModal from '../../../container/cameraDirectory/List/custom/DeleteAlertModal'; // Assuming you have a DeleteAlertModal component
import { useTranslation } from 'react-i18next';
/**
 * @interface AlertItem
 * @property {string} _id - The unique ID of the alert.
 * @property {string} Alert_Name - The name of the alert.
 * @property {string[]} Camera_Name - An array of camera names associated with the alert.
 * @property {boolean} Email_Activation - Indicates if email notifications are active for this alert.
 * @property {boolean} Display_Activation - Indicates if display notifications are active for this alert.
 * @property {any} [Object_Area] - The area of interest for the alert (can be array or object).
 * @property {string} [Start_Time] - The start time of the alert.
 * @property {string} [End_Time] - The end time of the alert.
 * @property {string} [Object_Class] - The object class being monitored.
 * @property {boolean} [No_Object_Status] - Status if it's a "no object" alert.
 * @property {boolean} [Holiday_Status] - Status for holidays.
 * @property {boolean} [Workday_Status] - Status for working days.
 * @property {string} [Alert_Status] - The overall status of the alert.
 * @property {string[]} [Days_Active] - Days when the alert is active.
 * @property {string} [Alert_Description] - Description of the alert.
 */

interface Alert {
  _id?: any;
  Alert_Name: string;
  Camera_Name: string;
  [key: string]: any;
}

/**
 * @interface AlertListComponentProps
 * @property {string} [pageType] - Type of the page, if present, influences styling.
 * @property {'edit' | 'view'} screenType - Determines if the component is in 'edit' or 'view' mode, affecting button visibility.
 * @property {React.CSSProperties} [style] - Custom inline style to apply to the main container.
 * @property {Alert[]} alertlist - The list of alert objects to display in the table.
 * @property {boolean} tableloader - Loading state for the table, displays a spinner when true.
 * @property {boolean} noAvailableStatus - Status indicating if no data is available, for displaying 'NoDataFound' component.
 * @property {Object} props_camera - Camera properties, typically contains an ID.
 * @property {(message: string) => void} setMessage - Function to set a message for external notification (e.g., toast).
 * @property {(open: boolean) => void} setOpen - Function to control the open state of an external notification.
 * @property {(warning: boolean) => void} setWarning - Function to set a warning state for an external notification.
 * @property {(item: Alert) => void} onChangeSingleEmailAlerts - Callback for changing email alert status.
 * @property {(item: Alert) => void} onChangeSingleDisplayAlerts - Callback for changing display alert status.
 * @property {(item: Alert) => void} showeditmodal - Callback to open the edit alert modal for a specific alert.
 * @property {(item: Alert) => void} showviewdetailsmodal - Callback to open the view alert details modal for a specific alert.
 * @property {() => void} getalertlist - Callback to refresh the list of alerts.
 * @property {() => void} handleShow - Callback to show the add alert modal.
 */
export interface AlertListComponentProps {
  pageType?: string;
  screenType: any;
  style?: React.CSSProperties;
  alertlist: Alert[];
  tableloader: boolean;
  noAvailableStatus: boolean;
  props_camera: string; // Example, adjust based on actual structure
  setMessage: (message: string) => void;
  setOpen: (open: boolean) => void;
  setWarning: (warning: boolean) => void;
  onChangeSingleEmailAlerts: (item: Alert) => void;
  onChangeSingleDisplayAlerts: (item: Alert) => void;
  showeditmodal: (item: Alert) => void;
  showviewdetailsmodal: (item: Alert) => void;
  getalertlist: () => void;
  handleShow: () => void;
}

/**
 * AlertListComponent is a functional component that displays a table of configured alerts.
 * It provides functionalities to view, edit, and manage alert activation statuses.
 *
 * @param {AlertListComponentProps} props - The properties for the component.
 * @returns {JSX.Element} The rendered alert list component.
 */
const AlertListComponent: React.FC<AlertListComponentProps> = ({
  pageType,
  screenType,
  style,
  alertlist,
  tableloader,
  noAvailableStatus,
  props_camera, // Assuming props_camera is needed for DeleteAlertModal based on original context
  setMessage,
  setOpen,
  setWarning,
  onChangeSingleEmailAlerts,
  onChangeSingleDisplayAlerts,
  showeditmodal,
  showviewdetailsmodal,
  getalertlist,
  handleShow,
}) => {
  const { t } = useTranslation();
  console.log("pagetype", pageType);
  return (
    <div
      className="bg-white padding-cls-camera"
      style={{
        width: '100%',
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '1rem',
        minHeight: '100%',
        ...style,
      }}
    >
      <>
        {tableloader ? (
          // Display a circular progress indicator when the table data is loading
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          >
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* alerts table starts here */}
            {alertlist && alertlist.length > 0 ? (
              // Render the table if there are alerts in the list
              // <table style={{ width: "100vh", tableLayout: "fixed", marginLeft: -20 }}>
              <div className="table-responsive classy-table-card">
              <table className="table classy-table align-middle">
                <thead>
                  <tr>
                    <th className="fs-14">{t("Alert Name")}</th>
                    <th className="fs-14">{t("Email Alerts")}</th>
                    <th className="fs-14">{t("Display Alerts")} </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {alertlist.map((item) => (
                    <tr key={item._id}>
                      {/* Alert Name column */}
                      <td>
                        {item.Camera_Name && item.Camera_Name.length > 1 ? (
                          <span className="alert-name">
                            {item.Alert_Name}
                          </span>
                        ) : (
                          // Applies a different style if no specific camera name is associated or if it's a single camera alert
                          <span className="alert-name-absent">
                            {item.Alert_Name}
                          </span>
                        )}
                      </td>

                      {/* Email Alerts checkbox */}
                      <td>
                        <div className="form-check margin-l-38">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id={`email-check-${item._id}`} // Unique ID for accessibility
                            checked={item.Email_Activation}
                            disabled={pageType === "view"} // Disable if in view mode
                            onChange={() => onChangeSingleEmailAlerts(item)}
                          />
                        </div>
                      </td>

                      {/* Display Alerts checkbox */}
                      <td>
                        <div className="form-check margin-l-38">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            checked={item.Display_Activation}
                            id={`display-check-${item._id}`} // Unique ID for accessibility
                            disabled={pageType === "view"} // Disable if in view mode
                            onChange={() => onChangeSingleDisplayAlerts(item)}
                          />
                        </div>
                      </td>

                      {/* Action buttons (Edit, View, Delete) */}
                      <td className="right-radius">
                        <div className="d-flex flex-box-style">
                          {pageType !== "view" && (
                            // Edit button, hidden in view mode
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault(); // Prevent page reload
                                showeditmodal(item);
                              }}
                            >
                              <Tooltip title={t("Edit Alert")}>
                                <i className="bx bx-edit-alt Edit-Alert-style"></i>
                              </Tooltip>
                            </a>
                          )}

                          {/* View button */}
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault(); // Prevent page reload
                              showviewdetailsmodal(item);
                            }}
                          >
                            <Tooltip title={t("View Alert")}>
                              <i className="bx bx-show View-Alert-style"></i>
                            </Tooltip>
                          </a>

                          {pageType !== "view" && (
                            // Delete button, hidden in view mode
                            <DeleteAlertModal
                              data={item}
                              camera={props_camera} // Assuming props_camera.id holds the camera name
                              onRefresh={getalertlist}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <>
                {/* Display NoDataFound or Loading message if no alerts */}
                {noAvailableStatus === true ? (
                  <NoDataFound pageType={pageType} />
                ) : (
                  <div className="Loading">Loading..</div>
                )}
              </>
            )}
            {/* alerts table ends here */}
          </>
        )}
      </>

      {/* Add Alert Button */}
      {pageType ? (
        pageType !== "view" && (
          <button className="addButton addalert" onClick={handleShow} style={{
            padding: "8px 16px",
            fontSize: "14px",
            minHeight: "auto",
            lineHeight: "1.2",
            marginTop: "16px",
          }}>
            {t("Add Alert")}
          </button>
        )
      ) : null}
    </div>
  );
};

export default AlertListComponent;