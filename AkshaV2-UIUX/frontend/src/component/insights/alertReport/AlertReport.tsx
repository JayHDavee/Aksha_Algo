/**
 * @fileoverview Alert Report Component - Displays comprehensive alert analytics and reporting interface
 * @module AlertReport
 * @description This component provides a complete alert reporting system with filtering, visualization,
 * and AI-powered summary generation capabilities for security alerts and insights.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import axios from 'axios';
import dayjs from 'dayjs';
import Markdown from 'react-markdown';
import { subDays } from 'date-fns';

// Material-UI Components
import SearchIcon from "@mui/icons-material/Search";
import HighlightOffRoundedIcon from '@mui/icons-material/HighlightOffRounded';
import { Dialog, DialogActions, CircularProgress, Box } from '@mui/material';

// Custom Components
import { searchTabs } from "./searchStore";
import NotFound from "../../common/NotFound";
import useRemoveScroll from "../../../hooks/useRemoveScroll";
import CustomTable from "./components/CustomTable";
import DoughnutChart from "./components/DoughnutChart";
import HorizontalBarChart from "./components/HorizontalBarChart";
import Messagebox from "../../common/Messagebox";
import TimePickerPopover from "../../common/TimePickerPopover";
import DatePickerPopover from "../../common/DatePickerPopover";
import Dropdown from "./components/Dropdown";

// Types
import { SearchTab, ReportData, DateRange } from "./types";

// Utilities
import getTabsDateString from "../../../utils/getTabsDateString";
import getTimeString from "../../../utils/getTimeString";
import axiosJWT from "../../../context/axiosAuthIntercept";
import { useTranslation } from 'react-i18next';

// Styles
import './styles/alertReport.scss';

/**
 * Interface for camera data structure
 */
interface Camera {
  Camera_Name: string;
  Active: boolean;
  [key: string]: any;
}

/**
 * Alert Report Component
 * 
 * @component
 * @description Main component for displaying and managing alert reports with filtering,
 * visualization, and AI-powered summary generation capabilities.
 * 
 */
const AlertReport: React.FC = () => {
  // State management for tab configuration
  const [tabStore, setTabStore] = useState<SearchTab[]>(searchTabs);
  
  // Loading states
  const [loader, setLoader] = useState<boolean>(false);
  const [reportSummaryLoading, setReportSummaryLoading] = useState<boolean>(false);
  
  // Modal states for image preview
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalImage, setModalImage] = useState<string | null>(null);
  
  // Message box states
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [warning, setWarning] = useState<boolean>(true);
  
  // Filter states
  const [ooiLabels, setOoiLabels] = useState<string[]>([]);
  const [selectedOoiLabels, setSelectedOoiLabels] = useState<string[]>([]);
  const [allCameras, setAllCameras] = useState<Camera[]>([]);
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  
  // Date and time states
  const [dates, setDates] = useState<DateRange[]>([
    {
      startDate: subDays(new Date(), 7),
      endDate: new Date(),
      key: "selection",
    },
  ]);
  const [startTime, setStartTime] = useState(dayjs().set("hour", 7).set("minute", 0));
  const [endTime, setEndTime] = useState(dayjs().set("hour", 19).set("minute", 0));
  
  // Report data states
  const [reportData, setReportData] = useState<ReportData>({});
  const [reportSummary, setReportSummary] = useState<string | null>(null);
  const [reportSummaryError, setReportSummaryError] = useState<string | null>(null);
  
  // AI features states
  const [genAIFeatures, setGenAIFeatures] = useState<boolean>(false);
  const [reportSummaryModel, setReportSummaryModel] = useState<string>("GPT 4o");
  const [reportSummaryLang, setReportSummaryLang] = useState<string>('eng');
  const [isChecked, setIsChecked] = useState<boolean>(false);

  // Redux selectors
  const reportDataaa = useSelector((state: any) => state.alertReport.reportData);
  const dated = useSelector((state: any) => state.alertReport.alertDate);

  // Dependency array for scroll management
  const [dependencyArr, setDependencyArr] = useState<number[]>([]);

  const {t} = useTranslation();
  /**
   * Handles modal close action
   */
  const handleClose = (): void => {
    setOpen(false);
  };

  /**
   * Extracts and formats labels array from API response
   * @param labelsArr - Array of label strings from API
   * @returns Formatted array of labels
   */
  const getLabelsArr = (labelsArr: string[]): string[] => {
    let arr: string[] = [];
    
    for (let item of labelsArr) {
      item = item.replace("\r", "");
      arr = [...arr, item];
    }
    
    // Ensure array has at least one element
    arr = arr.length > 1 ? [arr[0]] : arr;
    return arr;
  };

  /**
   * Populates filter options on component mount
   * Fetches cameras list and object of interest labels
   */
  const populateFilterOptions = async (): Promise<void> => {
    try {
      setLoader(true);
      
      // Fetch all cameras
      const { data: allCameras } = await axios.get(
        `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_CAMERAS_LIST}`
      );
      setAllCameras(allCameras.cameras);

      const activeCameras = allCameras.cameras.filter(
        (cam: Camera) => cam.Active === true
      );
      const firstCamera = activeCameras.length > 0 ? activeCameras[0].Camera_Name : t("camera1");

      // Fetch object of interest labels
      const { data: objOfInterestLabels } = await axios.get(
        `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_OBJECT_OF_INTEREST_LABELS}`
      );
      setOoiLabels(objOfInterestLabels.labels);
      console.log(objOfInterestLabels.labels);
      let labelsArr = ["Truck"];
      if (objOfInterestLabels?.length > 0) {
        labelsArr = getLabelsArr(objOfInterestLabels);
      }

      // Update tab store with default values
      const currStartDate = getTabsDateString(dates[0].startDate);
      const currEndDate = getTabsDateString(dates[0].endDate);

      const tabStoreCopy = tabStore.map((tab, index) => {
        switch (index) {
          case 0:
            return { ...tab, text: `${currStartDate} - ${currEndDate}` };
          case 1:
            return { ...tab, text: "07:00 - 19:00" };
          case 2:
            return { ...tab, text: firstCamera };
          case 3:
            return { ...tab, text: labelsArr };
          default:
            return tab;
        }
      });

      setTabStore(tabStoreCopy);
    } catch (ex) {
      console.error("Error populating filter options:", ex);
    } finally {
      setLoader(false);
    }
  };

  /**
   * Handles start time change
   * @param value - New start time value
   * @param index - Tab index
   */
  const handleSetStartTime = (value: any, index: number): void => {
    const newStartTime = getTimeString(value);
    const oldEndTime = getTimeString(endTime);
    setStartTime(value);

    const tabStoreCopy = [...tabStore];
    const obj = { ...tabStoreCopy[index] };
    obj.text = `${newStartTime || "07:00"} - ${oldEndTime || "19:00"}`;
    tabStoreCopy[index] = obj;
    setTabStore(tabStoreCopy);
  };

  /**
   * Handles end time change
   * @param value - New end time value
   * @param index - Tab index
   */
  const handleSetEndTime = (value: any, index: number): void => {
    const newEndTime = getTimeString(value);
    const oldStartTime = getTimeString(startTime);
    setEndTime(value);

    const tabStoreCopy = [...tabStore];
    const obj = { ...tabStoreCopy[index] };
    obj.text = `${oldStartTime || "07:00"} - ${newEndTime || "19:00"}`;
    tabStoreCopy[index] = obj;
    setTabStore(tabStoreCopy);
  };

  /**
   * Fetches alert report summary using AI
   */
  const fetchAlertReportSummary = async (): Promise<void> => {
    try {
      setReportSummaryError(null);
      setReportSummary(null);
      setReportSummaryLoading(true);

      const requestBody = {
        start_date: dayjs(dates[0].startDate).format("YYYY-MM-DD"),
        end_date: dayjs(dates[0].endDate).format("YYYY-MM-DD"),
        model_option: reportSummaryModel,
        lang_option: reportSummaryLang,
        filtered_data: {
          ...reportData?.cameras,
        },
      };

      const { data } = await axios.post(
        `${import.meta.env.VITE_AlertReportAnalyzer}`,
        requestBody,
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      const parsedData = JSON.parse(data);
      if (!parsedData['report_analysis']) {
        throw new Error("No report summary found: Invalid response");
      }
      
      setReportSummary(parsedData['report_analysis']);
    } catch (error) {
      console.error("Error fetching report summary:", error);
      setReportSummaryError(
        (error as any).response?.data?.message || 
        (error as Error).message || 
        "Error fetching report summary"
      );
    } finally {
      setReportSummaryLoading(false);
    }
  };

  /**
   * Gets alert report status from server
   */
  const getAlertReportStatus = (): void => {
    const url = `${import.meta.env.VITE_BASE_URL}/api/mail_insight_report_status`;
    axiosJWT.get(url).then((res) => {
      if (res.data.success === true) {
        const sendAlertReport = res.data.send_alert_report;
        setIsChecked(sendAlertReport);
      }
    });
  };

  /**
   * Toggles email notification setting
   */
  const toggleSendMail = (): void => {
    const url = `${import.meta.env.VITE_BASE_URL}/api/mail_insight_report`;
    const params = { send_email: !isChecked };
    
    axiosJWT.put(url, params).then((res) => {
      if (res.data.success === true) {
        console.log('Email notification status changed');
      }
    });
  };

  /**
   * Changes active CSS for tabs
   * @param index - Index of tab to activate
   */
  const handleChangeActiveCss = (index: number): void => {
    const tabStoreCopy = tabStore.map((tab) => ({ ...tab, active: false }));
    tabStoreCopy[index].active = true;
    setTabStore(tabStoreCopy);
  };

  /**
   * Populates dropdown values on component mount
   */
  const populateDropDownOnMount = (): void => {
    try {
      setLoader(true);
      const formattedDate = dayjs(dated).format('DD/MM/YY');
      const tabStoreCopy = tabStore.map((tab) => ({ 
        ...tab, 
        text: formattedDate 
      }));
      setTabStore(tabStoreCopy);
    } catch (ex) {
      console.error("Error populating dropdown:", ex);
    } finally {
      setLoader(false);
    }
  };

  /**
   * Shows modal with image preview
   * @param image - Image URL to display
   */
  const handleShowModal = (image: string): void => {
    console.log(image)
    setIsModalOpen(true);
    setModalImage(image);
  };

  /**
   * Handles modal OK action
   */
  const handleOk = (): void => {
    setIsModalOpen(false);
    setModalImage(null);
  };

  /**
   * Handles modal cancel action
   */
  const handleCancel = (): void => {
    setIsModalOpen(false);
    setModalImage(null);
  };

  /**
   * Toggles checkbox state
   */
  const toggleCheckBox = (): void => {
    setIsChecked(!isChecked);
    setMessage(
      !isChecked 
        ? t("You will keep receiving bimonthly alert report") 
        : t("You will not receive bimonthly alert report")
    );
    setOpen(true);
    setWarning(isChecked);
    toggleSendMail();
  };

  /**
   * Handles date change
   * @param item - Date selection object
   * @param index - Tab index
   */
  const handleDateChange = (item: any, index: number): void => {
    setDates([item.selection]);
    
    const currStartDate = getTabsDateString(item.selection.startDate);
    const currEndDate = getTabsDateString(item.selection.endDate);

    const tabStoreCopy = [...tabStore];
    const obj = { ...tabStoreCopy[index] };
    obj.text = `${currStartDate} - ${currEndDate}`;
    tabStoreCopy[index] = obj;
    setTabStore(tabStoreCopy);
    setReportData({});
  };

  /**
   * Fetches report data based on current filters
   */
  const getReportData = async (): Promise<void> => {
    setReportData({});
    setReportSummary(null);
    
    // Validation
    if (!dates[0].startDate || !dates[0].endDate) {
      setMessage("Please select date.");
      setOpen(true);
      return;
    }

    if (!startTime || !endTime) {
      setMessage("Please select time.");
      setOpen(true);
      return;
    }

    if (startTime >= endTime) {
      setMessage("Start time should be less than end time.");
      setOpen(true);
      return;
    }

    setLoader(true);
    const startDateFormatted = dayjs(dates[0].startDate).format("YYYY-MM-DD");
    const endDateFormatted = dayjs(dates[0].endDate).format("YYYY-MM-DD");

    try {
      const insightReportUrl = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_INSIGHT_REPORT}`;
      const reqBody = {
        startDate: startDateFormatted,
        endDate: endDateFormatted,
        startTime: getTimeString(startTime),
        endTime: getTimeString(endTime),
        cameras: selectedCameras,
        objectsOfInterest: selectedOoiLabels,
      };

      const { data: allData } = await axios.post(insightReportUrl, reqBody, {
        headers: { "Content-Type": "application/json" },
      });

      setReportData(allData);
      console.log('reportdata',allData);
    } catch (error) {
      setReportData({});
      setMessage(t("No Alerts Found"));
      setOpen(true);
    } finally {
      setLoader(false);
    }
  };

  /**
   * Checks GenAI feature status
   */
  const checkGenAIStatus = (): void => {
    const url = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_GET_EMAIL_DETAILS}`;
    axiosJWT.get(url).then((res) => {
      if (res.data.success === true) {
        const genAiFeatures = res.data.genai_features;
        setGenAIFeatures(genAiFeatures);
      }
    });
  };

  // Effects
  useEffect(() => {
    const dependencyArray = Object.keys(reportDataaa || {}).length > 0 ? new Array(1) : [];
    setDependencyArr(dependencyArray);
  }, [reportDataaa]);

  useEffect(() => {
    populateFilterOptions();
    populateDropDownOnMount();
    getAlertReportStatus();
    
    // Hide scrollbar on mount
    const element = document.getElementById("body-tag");
    if (element) {
      element.classList.add("hide-scrollbar");
    }
  }, []);

  useRemoveScroll(dependencyArr);

  return (
    <>
      {/* Image Modal */}
      <Dialog
        open={isModalOpen}
        onClose={handleCancel}
        maxWidth="md"
        fullWidth
      >
        <DialogActions>
          <HighlightOffRoundedIcon 
            onClick={handleOk} 
            style={{ cursor: "pointer", fontSize: "2rem" }} 
          />
        </DialogActions>
        <div className="alert-image">
          <div className="report-alert-modal-container">
            <div className="add-margin"></div>
            {modalImage && (
              <img
                alt="alert img"
                crossOrigin="anonymous"
                src={modalImage}
                className="report-alert-camera-img"
              />
            )}
          </div>
        </div>
      </Dialog>

      <div className="alert-report">
        <Messagebox
          open={open}
          handleClose={handleClose}
          message={message}
          warning={warning}
        />
        
        {/* Search and Filter Section */}
        <div className="search-bar">
          <div className="main-content">
            {tabStore.map((tab, index) => {
              switch (tab.heading) {
                case "Date*":
                  return (
                    <DatePickerPopover
                      key={index}
                      heading={t("Date*")}
                      text={tab.text as string}
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
                      key={index}
                      heading={t("Time*")}
                      text={tab.text as string}
                      active={tab.active}
                      index={index}
                      onChangeActiveCss={handleChangeActiveCss}
                      starTime={startTime}
                      endTime={endTime}
                      setStartTime={handleSetStartTime}
                      setEndTime={handleSetEndTime}
                      mobile={false}
                    />
                  );
                case "Camera*":
                  return (
                    <Dropdown
                      key={index}
                      heading={t("Camera")}
                      active={tab.active}
                      options={allCameras.filter(cam => cam.Active).map(cam => cam.Camera_Name)}
                      selectedLabels={selectedCameras}
                      setSelectedLabels={setSelectedCameras}
                      mobile={false}
                    />
                  );
                case "Object of Interest*":
                  return (
                    <Dropdown
                      key={index}
                      heading={t("Object of Interest")}
                      active={tab.active}
                      options={ooiLabels.map(label => t(label))}
                      selectedLabels={selectedOoiLabels}
                      setSelectedLabels={setSelectedOoiLabels}
                      mobile={false}
                    />
                  );
                default:
                  return null;
              }
            })}
          </div>

          <SearchIcon
            className="searchIcon"
            onClick={getReportData}
          />
          
          {/* <div className="send-mail-button" onClick={toggleCheckBox}>
            <input 
              className="form-check-input" 
              type="checkbox" 
              checked={isChecked} 
              readOnly 
            />
            <span className="send-mail-text">{t("Send alert report bimonthly")}</span>
          </div> */}
        </div>

        {/* Loading State */}
        {loader ? (
          <Box
            position="absolute"
            top="50%"
            left="50%"
            sx={{ transform: 'translate(-50%, -50%)' }}
          >
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* Report Content */}
            {Object.keys(reportData || {}).length > 0 ? (
              <div className="reportcontent">
                <div className="row mt-3 mx-auto mt-5">
                  <div className="col-lg-8">
                    <CustomTable 
                      data={reportData} 
                      showModal={handleShowModal} 
                    />
                  </div>

                  <div className="col-lg-4">
                    <div className="row mb-2">
                      <div className="col-12">
                        <div className="graph-container">
                          <DoughnutChart data={reportData} />
                        </div>
                      </div>
                    </div>
                    <HorizontalBarChart data={reportData} />
                  </div>
                </div>

                {/* AI Report Summary Section */}
                {genAIFeatures && (
                  <div className="generate-report-summary">
                    <div className="report-summary-config-select">
                      <label>{t("Select Model")}</label>
                      <select
                        value={reportSummaryModel}
                        onChange={(e) => setReportSummaryModel(e.target.value)}
                      >
                        <option value="GPT 4o">GPT 4o</option>
                        <option value="GPT 4 Turbo">GPT 4 Turbo</option>
                      </select>
                      
                      <label>{t("Select Language")}</label>
                      <select
                        value={reportSummaryLang}
                        onChange={(e) => setReportSummaryLang(e.target.value)}
                      >
                        <option value="english">English</option>
                        <option value="japanese">Japanese</option>
                      </select>
                    </div>
                    
                    <button
                      className="btn btn-primary"
                      onClick={fetchAlertReportSummary}
                      disabled={reportSummaryLoading}
                    >
                      {t("Generate Report Summary")}
                    </button>
                  </div>
                )}

                {/* Report Summary Display */}
                {reportSummaryLoading && (
                  <div className="report-summary-text-center">
                    <CircularProgress />
                    <span>{t("Generating AI report...")}</span>
                  </div>
                )}
                
                {reportSummaryError && (
                  <div className="report-summary-text-center text-danger">
                    {reportSummaryError}
                  </div>
                )}
                
                {reportSummary && (
                  <div className="report-summary">
                    <h2 className="report-summary__title">
                      {t("AI-Generated Summary")}
                    </h2>
                    <div className="report-summary__content">
                      <Markdown>{reportSummary}</Markdown>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="my_alert_not_found my-5">
                <NotFound />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
};

export default AlertReport;
