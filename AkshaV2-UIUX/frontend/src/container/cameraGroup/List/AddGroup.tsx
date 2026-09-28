import React, { useState, useEffect } from "react";
import { useApi } from "../../../hooks/useApi";
import Checkbox from "@mui/material/Checkbox";
import ListItemText from "@mui/material/ListItemText";
import "antd/dist/antd.css";
import "./list.scss";
import { useTranslation } from "react-i18next";
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
} from "@mui/material";
import Messagebox from "../../../component/common/Messagebox";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface CameraOption {
  _id: string;
  Camera_Name: string;
  group_id?: number;
  Priority?: string;
  PriorityType?: string;
}

interface AddGroupProps {
  setMessage: (msg: string) => void;
  setOpen: (open: boolean) => void;
  showScreen: () => void;
  loadlist: () => void;
  groupdata: any;
  list: any[];
  screenMode: "add" | "edit" | "view";
}

const AddGroup: React.FC<AddGroupProps> = (props) => {
  const { t } = useTranslation();
  const { callApi } = useApi();

  const [pagetype, setPagetype] = useState<string>("add");
  const [groupName, setGroupName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [PriorityType, setPriorityType] = useState<string>("Custom");
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [cameraOptions, setCameraOptions] = useState<CameraOption[]>([]);
  const [formloader, setFormloader] = useState<boolean>(false);
  const [warning, setWarning] = useState<boolean>(true);
  const [isModalVisible, setIsModalVisible] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");


  const handleClose = (): void => props.setOpen(false);
  const handleCancel = (): void => setIsModalVisible(false);


  const getCameraOptions = async (Priority: string): Promise<void> => {
    try {
      const url = `${VITE_base_url}/api/camera`;
      const res = await callApi(url, { method: "GET" });

      if (res.data?.success && Array.isArray(res.data.cameras)) {
        const cameras = res.data.cameras;

        let availableCameras = cameras.filter((cam: any) => {
          const isNotInAnyGroup = !cam.group_id; // backend sets group_id = 1
          const isInThisGroup =
            props.groupdata &&
            props.groupdata.cameras?.some((c: any) => c.camera_id === cam._id);

          return isNotInAnyGroup || isInThisGroup;
        });

        if (Priority && Priority !== "Custom") {
          availableCameras = availableCameras.filter((cam: any) => {
            const type = cam.Priority || cam.PriorityType || "Custom";
            return type === Priority;
          });
        }

        setCameraOptions(availableCameras);
      } else {
        setCameraOptions([]);
      }
    } catch (err) {
      console.error("Error fetching camera list:", err);
      setCameraOptions([]);
    }
  };


  const validateForm = (): boolean => {
    if (!groupName.trim()) {
      setMessage(t("Please enter a group name."));
      setOpen(true);
      return false;
    }

    if (!PriorityType || PriorityType.trim() === "") {
      setMessage(t("Please select priority type."));
      setOpen(true);
      return false;
    }

    if (!description.trim()) {
      setMessage(t("Please enter description."));
      setOpen(true);
      return false;
    }
    if (cameraOptions.length === 0) {
      setMessage(
        t("No cameras available for this priority. Please select a different priority.")
      );
      setOpen(true);
      return false;
    }
    if (selectedCameras.length === 0) {
      setMessage(t("Please select at least one camera."));
      setOpen(true);
      return false;
    }

    return true;
  };


  const add_group = (): void => {
    // 🔍 1. VALIDATE BEFORE DOING ANYTHING
    if (!validateForm()) return;

    // 🔄 2. Prepare cameras array (only if validation passes)
    const cameras = selectedCameras.map((id, index) => ({
      camera_id: id,
      camera_name: cameraOptions.find((c) => c._id === id)?.Camera_Name || "",
      custom_order: index + 1,
    }));

    // 📌 3. Prepare API params
    const params = {
      group_name: groupName,
      description,
      priority_type: PriorityType,
      cameras,
    };

    setFormloader(true);

    const url = `${VITE_base_url}/api/camgroup/add`;
    const headers = { "Content-Type": "application/json; charset=utf-8" };

    // 🚀 4. API CALL
    callApi(url, { method: "POST", body: params, headers })
      .then((res: any) => {
        console.log("Full API response:", res);

        // If backend says success
        if (res?.data?.success === true) {
          props.setMessage(
            t(`Group "${groupName}" added successfully.`)
          );
          props.setOpen(true);

          // Refresh & close popup
          props.loadlist();
          props.showScreen();
        } else {
          // Backend returned a 400 / custom error
          props.setMessage(res?.data?.message || t("Something went wrong."));
          props.setOpen(true);
        }

        setFormloader(false);
      })
      .catch((error: any) => {
        // 🔴 5. Catch unexpected errors
        props.setMessage(
          error?.response?.data?.message || t("Network or server error")
        );
        props.setOpen(true);

        setFormloader(false);
      });
  };

  const update_group = (): void => {
    if (!validateForm()) return;

    const cameras = selectedCameras.map((id, index) => ({
      camera_id: id,
      camera_name: cameraOptions.find((c) => c._id === id)?.Camera_Name || "",
      custom_order: index + 1,
    }));

    const params = {
      group_name: groupName,
      description,
      priority_type: PriorityType,
      cameras,
    };


    setFormloader(true);
    console.log("PUT payload:", params);

    const url = `${VITE_base_url}/api/camgroup/${props.groupdata._id}`; //edit
    const headers = { "Content-Type": "application/json; charset=utf-8" };

    callApi(url, { method: "PUT", body: params, headers })
      .then((res: any) => {
        if (res.data.success === true) {
          props.setMessage(`Group "${groupName}" updated successfully.`);
          props.setOpen(true);
          props.loadlist();
          props.showScreen();
        } else {
          props.setMessage(res.data.message || "Error updating group");
          props.setOpen(true);
        }
        setFormloader(false);
      })
      .catch(() => setFormloader(false));
  };


  // Initialize on mount / group change
  useEffect(() => {
    console.log();
    if (props.groupdata && props.groupdata._id) {
      setPagetype("edit");
      setGroupName(props.groupdata.group_name || "");
      setDescription(props.groupdata.description || "");
      setPriorityType(props.groupdata.priority_type || "Custom");
      setSelectedCameras(
        (props.groupdata.cameras || []).map((c: any) => c.camera_id)
      );
      getCameraOptions(props.groupdata.priority_type || "Custom");
    } else {
      setPagetype("add");
      setGroupName("");
      setDescription("");
      setPriorityType("Custom");
      setSelectedCameras([]);
      getCameraOptions("Custom");
    }
  }, [props.groupdata]);

  // Refetch when Priority changes
  useEffect(() => {
    getCameraOptions(PriorityType);
  }, [PriorityType]);


  return (
    <div
      className="add-camera-section"
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: "100vh",
        paddingTop: "35px",  // only top padding if you want spacing
        paddingLeft: 0,      // remove left padding
        paddingRight: 0,     // remove right padding
      }}
    >
      <Messagebox
        open={open}
        handleClose={handleClose}
        message={message}
        warning={warning}
      />

      <Dialog open={isModalVisible} onClose={handleCancel}>
        <DialogTitle>{t("Confirm")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("Do you want to proceed?")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} color="primary">
            {t("Cancel")}
          </Button>
          <Button onClick={add_group} color="primary" autoFocus>
            {t("OK")}
          </Button>
        </DialogActions>
      </Dialog>
      <div className="corner pt-0">
        <h3 style={{
          fontSize: "24px",          // slightly smaller
          fontWeight: "500",
          color: "#2f2f2f",          // soft charcoal
          fontFamily: `"Inter", "Segoe UI", "Roboto", system-ui, sans-serif`,
          marginBottom: "4px",
          paddingBottom: "6px",
          marginLeft: "5px",
          letterSpacing: "0.2px",
          marginTop: "8px",
        }}>
          {props.screenMode === "view"
            ? t("View Group Details")
            : pagetype === "edit"
              ? t("Update Group")
              : t("Add Group")}
        </h3>


        {formloader ? (
          <Box
            position="absolute"
            top="50%"
            left="50%"
            sx={{ transform: "translate(-50%, -50%)" }}
          >
            <CircularProgress />
            <p style={{ color: "#1976d2", marginTop: "0.5rem" }}>
              {t("savingSettings")}
            </p>
          </Box>
        ) : (
          <>
            <div style={{ flexGrow: 1, width: "100%" }}>
              <div className="form-basic-details">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "20px" }}>
                  <label style={{ fontWeight: 500 }}>{t("Group Name")}</label>
                  <input
                    className="classy-input"
                    disabled={props.screenMode === "view"}
                    type="text"
                    placeholder={t("Enter group name")}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "20px" }}>
                  <label style={{ fontWeight: 500 }}>{t("Priority Type")}</label>
                  <select
                    className="classy-select"
                    disabled={props.screenMode === "view"}
                    value={PriorityType}
                    onChange={(e) => setPriorityType(e.target.value)}
                  >
                    <option value="High">{t("High")}</option>
                    <option value="Medium">{t("Medium")}</option>
                    <option value="Low">{t("Low")}</option>
                    <option value="Custom">{t("Custom")}</option>
                  </select>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "20px" }}>
                  <label style={{ fontWeight: 500 }}>
                    {t("Select Cameras")}
                  </label>
                  <FormControl fullWidth>
                    <InputLabel id="camera-select">{t("Cameras")}</InputLabel>
                    <Select
                      labelId="camera-select"
                      label={t("Cameras")}   // ✅ THIS fixes the cut line
                      multiple
                      disabled={props.screenMode === "view"}
                      value={selectedCameras}
                      onChange={(e) =>
                        setSelectedCameras(e.target.value as string[])
                      }
                      renderValue={(selected) =>
                        cameraOptions
                          .filter((cam) => selected.includes(cam._id))
                          .map((cam) => cam.Camera_Name)
                          .join(", ")
                      }
                      sx={{ maxWidth: "95%", backgroundColor: "white" }}
                    >
                      {cameraOptions.length === 0 ? (
                        <MenuItem disabled>
                          {t("No available cameras")}
                        </MenuItem>
                      ) : (
                        cameraOptions.map((cam) => (
                          <MenuItem key={cam._id} value={cam._id}>
                            {cam.Camera_Name}
                          </MenuItem>
                        ))
                      )}
                    </Select>
                  </FormControl>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: 20, marginLeft: 25, width: 550, maxWidth: "calc(100% - 25px)", boxSizing: "border-box" }}>
                <label style={{ fontWeight: 500 }}>{t("Description")}</label>
                <textarea
                  className="classy-textarea"
                  disabled={props.screenMode === "view"}
                  rows={4}
                  cols={30}
                  maxLength={40}
                  placeholder={t("Maximum 200 characters.")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{
                    width: "88%",
                    fontSize: 15,
                  }}
                />
              </div>
            </div>

            {props.screenMode !== "view" ? (
              <div className="form-button-group" style={{ marginLeft: "25px" }}>
                <button className="outlined-button" onClick={props.showScreen}>
                  {t("Cancel")}
                </button>
                {pagetype === "edit" ? (
                  <button
                    className="filled-button"
                    onClick={() => {
                      if (!validateForm()) return;   // ⛔ Show message + STOP
                      update_group();                   // ✔ Only run if valid
                    }}
                  >
                    {t("Update Group")}
                  </button>
                ) : (
                  <button
                    className="filled-button"
                    onClick={() => {
                      if (!validateForm()) return;   // ⛔ Show message + STOP
                      add_group();                   // ✔ Only run if valid
                    }}
                  >
                    {t("Save Group")}
                  </button>

                )}
              </div>
            ) : (
              <div className="form-button-group" style={{ marginLeft: "25px" }}>
                <button className="outlined-button" onClick={props.showScreen}>
                  {t("Back")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AddGroup;