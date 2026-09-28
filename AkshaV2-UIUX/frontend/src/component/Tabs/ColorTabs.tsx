import React, { useState, useEffect } from "react";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import FormControl from "@mui/material/FormControl";
import Select, { SelectChangeEvent } from "@mui/material/Select";
import { TabContext, TabPanel } from "@mui/lab";
import { makeStyles } from "@mui/styles";
import { Button } from "@mui/material";
import { useLocation } from "react-router-dom";
import { useDispatch } from "react-redux";
import { getDurationTime } from "../../global_store/reducers/investigationReducer";
import axiosJWT from "../../context/axiosAuthIntercept";
import Tooltip from '@mui/material/Tooltip';
import { useNavigate } from "react-router-dom";
import { TabProps } from "./tabs.types";
import startMonitorTour from "../../pages/Tour/MonitorTour";
import startInvestigationTour from "../../pages/Tour/InvestigationTour";
import startInsightsTour from "../../pages/Tour/InsightsTour";
import startCameraDirectoryTour from "../../pages/Tour/CameraDirectory";
import monitorPlay from "../../assets/images/icons/monitorPlay.png";
import detective from "../../assets/images/icons/detective.png";
import insight from "../../assets/images/icons/insight.png";
import camDir from "../../assets/images/icons/add-new-cam-icon.png"

import "./tabs.scss";
import ImageModal from "../../pages/ImageModal";
import { useTranslation } from "react-i18next";

// ==========================
// Custom MUI Style Overrides
// ==========================
const useStyles = makeStyles({
  toggleButtonContainer: {
    position: "absolute",
    right: "3%",
    border: "1px solid #035faa",
    borderRadius: "17px",
  },
  dropBtn: {
    position: "absolute",
    right: "7%",
    top: "-11px",
  },
  toggleClass: {
    background: "#035faa!important",
    color: "white!important",
    borderRadius: "16px!important",
    "&:hover": {
      background: "#024578!important",
      color: "white!important",
    },
  },
  quantityRoot: {
    "& .MuiOutlinedInput-notchedOutline": {
      border: "0px solid transparent",
    },
    "&:hover .MuiOutlinedInput-notchedOutline": {
      border: "0px solid transparent",
    },
    "& .Mui-focused .MuiOutlinedInput-notchedOutline": {
      border: "0px solid transparent",
    },
  },
});

// ====================
// Main Component
// ====================
function ColorTabs({
  tabName,
  pages,
  // hideHeader = false,
  showOnlyActiveTab = false
}: TabProps) {
  const location = useLocation();
  const dispatch = useDispatch();
  const classes = useStyles();
  const navigate = useNavigate();

  // Active tab state (persisted from localStorage)
  const [value, setValue] = useState<string>(() => {
    const savedValue = localStorage.getItem("tabValue");
    return savedValue ? JSON.parse(savedValue) : "one";
  });

  // Toggle state for Holiday/Work Day
  const [toggleDays, setToggleDays] = useState<boolean>(() => {
    const stored = localStorage.getItem("WorkHoliday");
    return stored ? JSON.parse(stored) !== "Work Day" : false;
  });

  // Selected dropdown value (duration)
  const [age, setAge] = useState("1");

  const { t } = useTranslation();
  const [isImageOpen, setIsImageOpen] = useState(false);
  const [imageSrc, setImageSrc] = useState("");

  const openModal = (img: string) => {
    setImageSrc(img);
    setIsImageOpen(true);
  };

  const closeModal = () => setIsImageOpen(false);

  const getIconByPath = (path: string) => {
    if (path.includes("monitor")) {
      return <img src={monitorPlay} alt="monitor icon" style={{ width: "20px" }} />;
    } else if (path.includes("investigation")) {
      return <img src={detective} alt="investigation icon" style={{ width: "25px" }} />;
    } else if (path.includes("insights")) {
      return <img src={insight} alt="insights icon" style={{ width: "20px" }} />;
    } else if (path.includes("cameraDirectory")) {
      return <img src={camDir} alt="camera-directory icon" style={{ width: "23px" }} />;
    }
  };


  // Handle tab change and persist in localStorage
  const handleChange = (_: React.SyntheticEvent, newValue: string) => {
    setValue(newValue);
    localStorage.setItem("tabValue", JSON.stringify(newValue));
  };

  // Handle dropdown duration change
  const selectChange = (event: SelectChangeEvent<string>) => {
    const selected = event.target.value;
    setAge(selected);
    dispatch(getDurationTime(selected === "" ? 0 : Number(selected)));
  };

  // Handle Holiday / Work Day toggle and notify server
  const checkForWorkingDay = (value: "Holiday" | "Work Day") => {
    localStorage.setItem("WorkHoliday", JSON.stringify(value));
    setToggleDays(value !== "Work Day");

    const endpoint = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_CHECK_FOR_WORKING_DAY}`;
    const url = `${endpoint}?workday=${value === "Work Day"}`;

    axiosJWT.get(url).catch((err) => console.error("WorkDay error:", err));
  };
  //dropdown
  const [cameraGroups, setCameraGroups] = useState<
    {
      group_name: string;
      description: string;
      priority_type: string;
      cameras: { camera_id: string; camera_name: string }[];
    }[]
  >([]);
  const [selectedGroup, setSelectedGroup] = useState(() => {
    const stored = localStorage.getItem("selectedGroup");
    return stored ? JSON.parse(stored) : "default";
  });
  const handleGroupChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    setSelectedGroup(value);
    localStorage.setItem("selectedGroup", JSON.stringify(value));
  };

  // Fetch groups from backend on mount
  useEffect(() => {
    if (location.pathname === "/monitor") {
      axiosJWT
        .get(`${import.meta.env.VITE_BASE_URL}/api/camgroup`)
        .then((res) => {
          if (res.data.groups) setCameraGroups(res.data.groups);
        })
        .catch((err) => console.error("Error fetching camera groups:", err));
    }
  }, [location.pathname]);

  const SHOW_TOUR = import.meta.env.VITE_SHOW_TOUR === "true";
  // ================
  // Render Component
  // ================
  return (
    <Box sx={{ width: "100%" }} className="tab-wrapper tab-container-1">
      <TabContext value={value}>
        <div
          style={{
            display: "block"
          }}
        >

          <Tabs
            value={value}
            onChange={handleChange}
            aria-label="App Tabs"
            className="px-4 pt-2 tabBg tabsColor"
          >

            {tabName
              .filter(tab =>
                showOnlyActiveTab ? tab.value === value : true
              )
              .map((tab, idx) => (
                <Tab
                  key={idx}
                  value={tab.value}
                  label={t(tab.label)} className={
                    // Monitor
                    tab.label.toLowerCase() === "live"
                      ? "monitor-live"
                      : tab.label.toLowerCase() === "spotlight"
                        ? "monitor-spotlight"


                        // Investigation
                        : tab.label.toLowerCase() === "object of interest"
                          ? "investigation-object-interest"
                          : tab.label.toLowerCase() === "recent alerts"
                            ? "investigation-recent-alerts"
                            : tab.label.toLowerCase() === "my alerts"
                              ? "investigation-my-alerts"
                              : tab.label.toLowerCase() === "auto alerts"
                                ? "investigation-auto-alerts"
                                // Insights
                                : tab.label.toLowerCase() === "activity tracker"
                                  ? "insights-activity-tracker"
                                  : tab.label.toLowerCase() === "report"
                                    ? "insights-reports"
                                    : ""
                  } />
              ))}




            {/* Monitor page toggle buttons */}
            {/* {location.pathname === "/monitor" && (
              <div className={classes.toggleButtonContainer} id="monitor-holiday-buttons">
                <Button
                  onClick={() => checkForWorkingDay("Holiday")}
                  className={toggleDays ? classes.toggleClass : ""}
                  style={{ width: "100px" }}
                >
                  Holiday
                </Button>
                <Button
                  onClick={() => checkForWorkingDay("Work Day")}
                  className={!toggleDays ? classes.toggleClass : ""}
                  style={{ width: "100px" }}
                >
                  Work Day
                </Button>
                
              </div>
              
            )} */}
            {/* Monitor page group dropdown */}
            {location.pathname === "/monitor" && (
              <div className={classes.dropBtn}>
                <FormControl sx={{ m: 1, minWidth: 120 }} className={classes.quantityRoot}>
                  <Select
                    value={selectedGroup}
                    onChange={handleGroupChange}
                    displayEmpty
                    inputProps={{ "aria-label": "Select Camera Group" }}
                    sx={{
                      "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                        borderColor: "transparent",
                      },
                      "& .MuiOutlinedInput-notchedOutline": {
                        borderWidth: "1px",
                      },
                      "&.Mui-focused": {
                        boxShadow: "none",
                      },
                    }}
                  >
                    <MenuItem value="default">{t("All Group Cameras")}</MenuItem>
                    {cameraGroups.map((group) => (
                      <MenuItem key={group.group_name} value={group.group_name}>
                        {group.group_name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </div>
            )}


            {/* Investigation dropdown on second tab */}
            {location.pathname === "/investigation" && value === "one" && (
              <div className={classes.dropBtn}>
                <FormControl sx={{ m: 1, minWidth: 120 }} className={classes.quantityRoot}>
                  <Select
                    value={age}
                    onChange={selectChange}
                    displayEmpty
                    inputProps={{ "aria-label": "Duration Selector" }}
                    sx={{
                      "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                        borderColor: "transparent",
                      },
                      "& .MuiOutlinedInput-notchedOutline": {
                        borderWidth: "1px",
                      },
                      "&.Mui-focused": {
                        boxShadow: "none",
                      },
                    }}
                  >
                    <MenuItem value="">{t("Duration")}</MenuItem>
                    <MenuItem value="1">{t("1 hour")}</MenuItem>
                    <MenuItem value="2">{t("2 hours")}</MenuItem>
                    <MenuItem value="3">{t("3 hours")}</MenuItem>
                    <MenuItem value="4">{t("4 hours")}</MenuItem>

                  </Select>
                </FormControl>

              </div>
            )}

            {SHOW_TOUR && (
              <Box sx={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
                <Tooltip
                  title={t("Start Tour")}
                  style={{ border: "1px solid #035faa", padding: "10px", margin: "5px" }}
                >
                  <Button
                    onClick={() => {
                      const currentPath = location.pathname;

                      if (currentPath.includes("monitor")) {
                        startMonitorTour(t, navigate, openModal);
                      } else if (currentPath.includes("investigation")) {
                        startInvestigationTour(t, navigate, openModal);
                      } else if (currentPath.includes("insights")) {
                        startInsightsTour(t, navigate, openModal);
                      } else if (currentPath.includes("cameraDirectory")) {
                        startCameraDirectoryTour(t, navigate, openModal);
                      }
                    }}
                    sx={{
                      height: "46px",
                      minWidth: "40px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      marginTop: "5px",
                    }}
                  >
                    {getIconByPath(location.pathname)}
                    <span style={{ fontSize: "17px" }}>{t("Tour")}</span>
                  </Button>
                </Tooltip>
              </Box>
            )}
          </Tabs>

        </div>



        {/* Render tab content panels */}
        {pages.map((page, idx) => (
          <TabPanel key={idx} value={page.value}>
            {React.isValidElement(page.component)
              ? React.cloneElement(page.component, {
                selectedGroup,
                cameraGroups
              })
              : page.component}
          </TabPanel>
        ))}

      </TabContext>


      <ImageModal
        isOpen={isImageOpen}
        imageSrc={imageSrc}
        onClose={() => setIsImageOpen(false)}
      />
    </Box>


  );
}

export default React.memo(ColorTabs);
