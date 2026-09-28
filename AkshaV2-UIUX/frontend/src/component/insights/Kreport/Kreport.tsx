import React, { useState, useEffect } from "react";
import dayjs, { Dayjs } from "dayjs";
import axiosJWT from "../../../context/axiosAuthIntercept";
import { subDays } from "date-fns";
import { searchTabs } from "./searchStore";
import NotFound from "../../common/NotFound";
import TimePickerPopover from "../../common/TimePickerPopover";
import DatePickerPopover from "../../common/DatePickerPopover";
import SearchIcon from "@mui/icons-material/Search";
import getTimeString from "../../../utils/getTimeString";
import useRemoveScroll from "../../../hooks/useRemoveScroll";
import "./styles/Kreport.scss";
import getDateString from "../../../utils/getDateString";
import getTabsDateString from "../../../utils/getTabsDateString";
import Messagebox from "../../common/Messagebox";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import KPIReportTable from "./KreportTable";
import Dropdown from "../alertReport/components/Dropdown";
import HourlyMultiObjectBarChart from "./Charts/HourlyMultiObjectBarChart";
import {
  buildHourlyObjectCounts,
  HourlyObjectCountsResult,
} from "../../../utils/buildHourlyObjectCounts";
import HourlyTrendLineChart from "./Charts/HourlyTrendLineChart";
import { useMediaQuery } from "@mui/material";

interface Tab {
  heading: string;
  text: string;
  active: boolean;
}

interface RecordItem {
  timestamp: string;
  counts: Record<string, number>;
  frame_link?: string | null;
}

interface CameraReport {
  camera_name: string;
  records: RecordItem[];
}

interface DateRange {
  startDate: Date;
  endDate: Date;
  key: string;
}

interface KPIRecord {
  timestamp: string;
  counts: Record<string, number>;
  frame_link?: string;
}

interface KPICameraReport {
  camera_name: string;
  records: KPIRecord[];
}

const react_app_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;
// 🔧 Safely extract object counts from backend record
const resolveCounts = (rec: any): Record<string, number> => {
  return (
    rec.object_counts ||
    rec.alerts?.object_counts ||
    rec.objects ||
    rec.counts_by_object ||
    {}
  );
};

const normalizeToKPI = (data: CameraReport[]): KPICameraReport[] => {
  return data.map((cam) => ({
    camera_name: cam.camera_name,
    records: cam.records.map((rec) => ({
      timestamp: rec.timestamp,
      counts: rec.counts ?? {},
      frame_link: rec.frame_link || undefined, // 🔥 null → undefined
    })),
  }));
};
const Kreport: React.FC = () => {
  const [dates, setDates] = useState<DateRange[]>([
    {
      startDate: subDays(new Date(), 7),
      endDate: new Date(),
      key: "selection",
    },
  ]);

  const [tabStore, setTabStore] = useState<Tab[]>(searchTabs);
  const [allActiveCameras, setAllActiveCameras] = useState<string[]>([]);
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [selectedFromTime, setSelectedFromTime] = useState<Dayjs>(
    dayjs().set("hour", 7).set("minute", 0),
  );
  const [selectedToTime, setSelectedToTime] = useState<Dayjs>(
    dayjs().set("hour", 19).set("minute", 0),
  );

  const [loader, setLoader] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");

  const [reportData, setReportData] = useState<KPICameraReport[]>([]);
  const [ooiLabels, setOoiLabels] = useState<string[]>([]);
  const [selectedOOILabels, setSelectedOOILabels] = useState<string[]>([]);
  const [hourlyChartData, setHourlyChartData] =
    useState<HourlyObjectCountsResult | null>(null);
  useEffect(() => {
    console.log("REPORT DATA STATE 👉", reportData);
  }, [reportData]);

  useEffect(() => {
    if (reportData.length && selectedOOILabels.length) {
      const chartPayload = buildHourlyObjectCounts(
        reportData,
        selectedOOILabels, 
      );

      setHourlyChartData(chartPayload);
    } else {
      setHourlyChartData(null);
    }
  }, [reportData, selectedOOILabels, selectedCameras]);

  useEffect(() => {
  if (selectedCameras.length && selectedOOILabels.length) {
    search();
  }
}, [selectedCameras]);

  useEffect(() => {
    populateDropDownOnMount();
    document.getElementById("body-tag")?.classList.add("hide-scrollbar");
  }, []);

  useRemoveScroll(reportData.length ? [1] : []);

  const populateDropDownOnMount = async (): Promise<void> => {
    try {
      setLoader(true);

      const camRes = await axiosJWT.get(
        `${react_app_base_url}${import.meta.env.VITE_CAMERAS_LIST}`,
      );
      const activeCameras: string[] =
        camRes?.data?.cameras
          ?.filter((cam: any) => cam.Active)
          .map((cam: any) => cam.Camera_Name) || [];

      setAllActiveCameras(activeCameras);
      setSelectedCameras(activeCameras.length ? [activeCameras[0]] : []);

      const ooiRes = await axiosJWT.get(
        `${react_app_base_url}${import.meta.env.VITE_OBJECT_OF_INTEREST_LABELS}`,
      );

      setOoiLabels(ooiRes?.data?.labels || []);

      const copy = [...tabStore];
      copy[0].text = `${getTabsDateString(dates[0].startDate)} - ${getTabsDateString(dates[0].endDate)}`;
      copy[1].text = "07:00 - 19:00";
      copy[2].text = activeCameras[0] || "Select Cameras";

      setTabStore(copy);
    } catch (err) {
      console.error("Dropdown load error", err);
    } finally {
      setLoader(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
  };
  const handleDateChange = (item: any, index: number) => {
    setDates([item.selection]);

    const start = getTabsDateString(item.selection.startDate);
    const end = getTabsDateString(item.selection.endDate);

    const copy = [...tabStore];
    copy[index] = { ...copy[index], text: `${start} - ${end}` };
    setTabStore(copy);
  };

  const handleChangeActiveCss = (index: number) => {
    const copy = tabStore.map((tab) => ({ ...tab, active: false }));
    copy[index].active = true;
    setTabStore(copy);
  };

  const handleSetStartTime = (value: Dayjs, index: number) => {
    const newStart = getTimeString(value);
    const oldEnd = getTimeString(selectedToTime);

    setSelectedFromTime(value);

    const copy = [...tabStore];
    copy[index] = {
      ...copy[index],
      text: `${newStart || "07:00"} - ${oldEnd || "19:00"}`,
    };
    setTabStore(copy);
  };

  const handleSetEndTime = (value: Dayjs, index: number) => {
    const newEnd = getTimeString(value);
    const oldStart = getTimeString(selectedFromTime);

    setSelectedToTime(value);

    const copy = [...tabStore];
    copy[index] = {
      ...copy[index],
      text: `${oldStart || "07:00"} - ${newEnd || "19:00"}`,
    };
    setTabStore(copy);
  };

  const search = async (): Promise<void> => {
    if (!selectedOOILabels.length) {
      setMessage("Please select Object of Interest.");
      setOpen(true);
      return;
    }

    const payload = {
      cameras: selectedCameras,
      startDate: getDateString(dates[0].startDate),
      endDate: getDateString(dates[0].endDate),
      startTime: getTimeString(selectedFromTime, true),
      endTime: getTimeString(selectedToTime, true),
      objectsOfInterest: selectedOOILabels,
    };

    try {
      setLoader(true);
      setReportData([]);

      const res = await axiosJWT.post(
        `${react_app_base_url}/api/kpi_report`,
        payload,
      );


      if (res?.data?.success && Array.isArray(res.data.report)) {
        const normalizedForTable: KPICameraReport[] = res.data.report.map(
          (cam: any) => ({
            camera_name: cam.camera_name,
            records: cam.records.map((rec: any) => ({
              timestamp: rec.timestamp,
              counts: rec.counts ?? {},
              frame_link: rec.frame_link ?? undefined,
            })),
          }),
        );

        console.log("NORMALIZED KPI 👉", normalizedForTable);
        console.log(
          "FIRST COUNTS 👉",
          normalizedForTable[0]?.records[0]?.counts,
        );

        setReportData(normalizedForTable);
      }
    } catch (err) {
      console.error(err);
      setMessage("Error fetching KPI report.");
      setOpen(true);
    } finally {
      setLoader(false);
    }
  };

  const filterByOOI = (
    data: CameraReport[],
    labels: string[],
  ): CameraReport[] =>
    data
      .map((cam) => ({
        ...cam,
        records: cam.records.filter((rec) =>
          labels.some(
            (label) =>
              rec.counts !== undefined &&
              rec.counts[label] !== undefined &&
              rec.counts[label] > 0,
          ),
        ),
      }))
      .filter((cam) => cam.records.length > 0);

  return (
    <>
      <div className="autoalert-search autoalert-search-bar">
        <div className="aa-search-bar desktop">
          <Messagebox open={open} handleClose={handleClose} message={message} />
          <div className="aa-main-content">
            {tabStore.map((tab, index) => {
              if (tab.heading === "Date*") {
                return (
                  <DatePickerPopover
                    heading={tab.heading}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    mobile={false}
                    dates={dates}
                    onDateChange={handleDateChange}
                    onChangeActiveCss={handleChangeActiveCss}
                  />
                );
              } else if (tab.heading === "Time*") {
                return (
                  <TimePickerPopover
                    heading={tab.heading}
                    text={tab.text}
                    active={tab.active}
                    index={index}
                    onChangeActiveCss={handleChangeActiveCss}
                    starTime={selectedFromTime}
                    endTime={selectedToTime}
                    setStartTime={handleSetStartTime}
                    setEndTime={handleSetEndTime}
                    mobile={false}
                  />
                );
              } else if (tab.heading === "Camera*") {
                return (
                  <Dropdown
                    heading="Camera"
                    defaultText="Select Cameras"
                    active={tab.active}
                    options={allActiveCameras}
                    selectedLabels={selectedCameras}
                    setSelectedLabels={setSelectedCameras}
                    mobile={false}
                  />
                );
              } else if (tab.heading === "Object of Interest*") {
                return (
                  <Dropdown
                    key={index}
                    heading="Object of Interest"
                    defaultText="Select Objects"
                    // text={tab.text}
                    active={tab.active}
                    // index={index}
                    // setTabStore={setTabStore}
                    // tabStore={tabStore}
                    options={ooiLabels}
                    selectedLabels={selectedOOILabels}
                    setSelectedLabels={setSelectedOOILabels}
                    mobile={false}
                    // isOpen={isOOIDropdownOpen}
                    // setIsOpen={setIsOOIDropdownOpen}
                    // menuRef = {menuRef}
                  />
                );
              }
            })}
          </div>
          <SearchIcon className="aa-searchIcon" onClick={() => search()} />
        </div>

        {loader ? (
          <Box
            component="div"
            position="absolute"
            top="50%"
            left="50%"
            sx={{ transform: "translate(-50%, -50%)" }}
          >
            <CircularProgress />
          </Box>
        ) : reportData.length > 0 ? (
          // <div className="row kpi-content-wrapper">
           
          //   {/* LEFT → TABLE */}
          //   <div className="col-lg-6 col-md-12 mb-3 kpi-left-panel">
             
          //     <div className="card kpi-table-card h-100">
               
          //       <div className="card-body">
                 
          //         <h6 className="mb-3">KPI Details</h6>
          //         <div className="kpi-table-scroll">
          //         <KPIReportTable
          //           data={reportData}
          //           selectedOOILabels={selectedOOILabels}
          //         />
          //         </div>
          //       </div>
          //     </div>
          //   </div>
          //   {/* RIGHT → GRAPH */}
          //   <div className="col-lg-6 col-md-12 mb-3 kpi-right-panel">
             
          //     {/* BAR GRAPH */}
          //     <div className="card kpi-chart-card mb-3">
               
          //       <div className="card-body">
                 
          //         <h6 className="mb-3">Hourly Camera-wise Peak</h6>
          //         <div className="chart-container">
                   
          //           <HourlyMultiObjectBarChart
          //             chartPayload={hourlyChartData}
          //           />
          //         </div>
          //       </div>
          //     </div>
          //     {/* LINE GRAPH */}
          //     <div className="card kpi-chart-card">
               
          //       <div className="card-body">
                 
          //         <h6 className="mb-3">Hourly Trend</h6>
          //         <div className="chart-container">
                   
          //           <HourlyTrendLineChart chartPayload={hourlyChartData} />
          //         </div>
          //       </div>
          //     </div>
          //   </div>
          // </div>
          <div className="row kpi-layout">

  {/* LEFT - TABLE */}
  <div className="col-lg-6 col-md-12">
    <div className="kpi-card kpi-table-card">
      <div className="kpi-card-header">
        KPI Details
      </div>

      <div className="kpi-card-body kpi-table-body">
        <KPIReportTable
          data={reportData}
          selectedOOILabels={selectedOOILabels}
        />
      </div>
    </div>
  </div>

  {/* RIGHT - CHARTS */}
  <div className="col-lg-6 col-md-12">
    <div className="kpi-right-wrapper">

      <div className="kpi-card kpi-chart-card">
        <div className="kpi-card-header">
          Hourly Camera-wise Peak
        </div>
        <div className="kpi-card-body">
          <HourlyMultiObjectBarChart
            chartPayload={hourlyChartData}
          />
        </div>
      </div>

      <div className="kpi-card kpi-chart-card">
        <div className="kpi-card-header">
          Hourly Trend
        </div>
        <div className="kpi-card-body">
          <HourlyTrendLineChart
            chartPayload={hourlyChartData}
          />
        </div>
      </div>

    </div>
  </div>
</div>
    ) : (
          <div className="my_alert_not_found my-5">
           
            <NotFound />
          </div>
        )}
      </div>
    </>
  );
};

export default Kreport;
