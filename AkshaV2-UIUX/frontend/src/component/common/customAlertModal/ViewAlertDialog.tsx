import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@mui/material';
import moment from 'moment';
import "./Alerts.css";
interface ViewData {
  _id?: any;
  Alert_Name: string;
  Camera_Name: string | any;
  [key: string]: any;
}

interface ViewAlertDialogProps {
  open: boolean;
  onClose: () => void;
  viewData?: ViewData;
  calledInsideMenu?: boolean;
}

/**
 * A modal dialog component to display full details of a selected alert.
 *
 * @param {boolean} open - Controls the open/close state of the dialog.
 * @param {() => void} onClose - Callback function to close the dialog.
 * @param {ViewData} viewData - Data object containing alert details.
 * @param {boolean} calledInsideMenu - Optional flag to modify styling if used inside a menu.
 */
const ViewAlertDialog: React.FC<ViewAlertDialogProps> = ({
  open,
  onClose,
  viewData,
  calledInsideMenu = false,
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      scroll="paper" // keeps scroll inside DialogContent
      className={calledInsideMenu ? 'add-camera-modal zIndex-1024' : 'add-camera-modal'}
    >
      <DialogTitle>Alert Details</DialogTitle>
      <DialogContent dividers className="alert-dialog-content">
        {viewData ? (
          <div className="alert-details">
            <p><strong>Alert Name:</strong> {viewData.Alert_Name || '---'}</p>
            <p><strong>Alert Description:</strong> {viewData.Alert_Description || '---'}</p>
            <p><strong>Alert Status:</strong> {viewData.Alert_Status || '---'}</p>
            <p><strong>Camera Name:</strong> {Array.isArray(viewData.Camera_Name)
              ? (viewData.Camera_Name.length > 0 ? viewData.Camera_Name.join(', ') : '---')
              : (viewData.Camera_Name || '---')}</p>
            <p><strong>Days Active:</strong> {viewData.Days_Active?.length ? viewData.Days_Active.join(', ') : '---'}</p>
            <p><strong>Display Activation:</strong> {viewData.Display_Activation ? 'Yes' : 'No'}</p>
            <p><strong>Email Activation:</strong> {viewData.Email_Activation ? 'Yes' : 'No'}</p>
            <p><strong>Start Time:</strong> {viewData.Start_Time ? moment(viewData.Start_Time).format('DD MMM, YYYY') : '---'}</p>
            <p><strong>End Time:</strong> {viewData.End_Time ? moment(viewData.End_Time).format('DD MMM, YYYY') : '---'}</p>
            <p><strong>Object Class:</strong> {viewData.Object_Class || '---'}</p>
            <p><strong>Holiday Status:</strong> {viewData.Holiday_Status ? 'Yes' : 'No'}</p>
            <p><strong>Weekday Status:</strong> {viewData.Workday_Status ? 'Yes' : 'No'}</p>
            <p><strong>Created At:</strong> {viewData.Timestamp ? moment(viewData.Timestamp).format('DD MMM, YYYY') : 'No'}</p>
          </div>
        ) : (
          <p>No data available.</p>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="primary">OK</Button>
      </DialogActions>
    </Dialog>

  );
};

export default ViewAlertDialog;