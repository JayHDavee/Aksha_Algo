/**
 * Horizontal bar chart component for displaying topmost alerts per camera
 * @module HorizontalBarChart
 */

import React , {useState} from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { reduceStringSize } from "../../../../utils/reduceStringSize";
import { CHART_PALETTE } from "../../../../utils/chartColors";
import { useTranslation } from "react-i18next";
// import { ReportData } from "../types";

// Register Chart.js components for horizontal bar chart
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend
);

const colorsss = CHART_PALETTE;


interface ReportData {
  cameras: {
    [camName: string]: CameraData;
  };
}

interface CameraData {
  object_detection_alerts?: Record<string, number>;
  alerts?: Record<string, unknown>;
}

/**
 * Props interface for HorizontalBarChart component
 */
interface HorizontalBarChartProps {
  /** Report data containing camera information and object detection alerts */
  data: ReportData;
}

/**
 * Horizontal bar chart component that displays the topmost alert for each camera
 * 
 * This component analyzes object detection alerts for each camera and displays
 * the most frequently detected object as a horizontal bar chart. It also includes
 * a custom legend showing camera names with corresponding colors.
 * 
 * @param {HorizontalBarChartProps} props - Component props containing report data
 * @returns {JSX.Element} Horizontal bar chart with custom legend
 */
const HorizontalBarChart: React.FC<HorizontalBarChartProps> = ({ data }) => {
  /**
   * Arrays to store chart data
   * labelsssss: Object names for Y-axis labels
   * graphData: Count values for X-axis data
   * camNames: Camera names for custom legend
   */
  const {t} = useTranslation();
  let labelsssss: string[] = [];
  let graphData: number[] = [];
  let camNames: string[] = [];
  let [newData, setNewData] = useState();


  /**
   * Process data for horizontal bar chart
   * Finds the highest value object detection alert for each camera
   */
  if (Object.keys(data?.cameras || {}).length > 0) {
    // Process object detection alerts for chart data
    for (const camName in data.cameras) {
       const camera = data.cameras[camName];
      const objectDetectionAlerts = camera?.object_detection_alerts || {};
      let highestValue = 0;
      let highestValueName = "";

      // Find the most frequent object detection alert
      if (Object.keys(objectDetectionAlerts || {}).length > 0) {
        for (const [key, value] of Object.entries(objectDetectionAlerts)) {
          const numericValue = value as number;
          highestValueName = numericValue > highestValue ? key : highestValueName;
          highestValue = numericValue > highestValue ? numericValue : highestValue;
        }
        
        // Only add to chart if we found valid data
        if (highestValue > 0) {
          graphData.push(highestValue);
          labelsssss.push(highestValueName);
        }
      }
    }

    // Collect camera names for custom legend
    // Only include cameras that have alerts
    for (const camName in data.cameras) {
      if (
        data.cameras[camName]?.alerts &&
        Object.keys(data.cameras[camName].alerts || {}).length > 0
      ) {
        camNames.push(camName);
      }
    }
  }

  /**
   * Chart.js configuration data
   * Contains labels (object names) and datasets (alert counts)
   */
  const chartData = {
    labels: labelsssss,
    datasets: [
      {
        data: graphData,
        borderColor: colorsss,
        backgroundColor: colorsss,
        borderRadius: 6,
        borderSkipped: false,
        barThickness: 18,
      },
    ],
  };

  /**
   * Chart.js configuration options
   * Configures the horizontal bar chart appearance and behavior
   */
  const chartOptions = {
    animation: {
      duration: 0, // Disable animations for better performance
    },
    indexAxis: "y" as const, // Horizontal bar orientation
    elements: {
      bar: {
        borderWidth: 2,
      },
    },
    maintainAspectRatio: false, // Allow custom sizing
    plugins: {
      legend: {
        display: false, // Hide default legend (using custom legend instead)
      },
      title: {
        display: false,
      },
    },
    scales: {
      x: {
        grid: { color: "rgba(15, 23, 42, 0.06)" },
        ticks: { font: { family: "Inter, sans-serif", size: 11 } },
      },
      y: {
        grid: { display: false },
        ticks: { font: { family: "Inter, sans-serif", size: 12 } },
      },
    },
  };

  return (
    <>
      {/* Main horizontal bar chart container */}
      <div className="row mb-3">
        <div className="col-12">
          <div className="graph-container">
            <h6>{t("Top Most Alerts")}</h6>
            <div className="" style={{ maxHeight: "50vh" }}>
              <Bar
                options={chartOptions}
                data={chartData}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Custom legend showing camera names with corresponding colors */}
      <div className="row mb-5 mx-5">
        <div className="col-12">
          <div className="row no-gutters">
            {camNames?.length > 0
              ? camNames.map((camName, index) => (
                  <div className="col" key={index}>
                    <div className="d-flex justify-content-center align-items-center">
                      {/* Color indicator box */}
                      <div
                        style={{
                          background: colorsss[index],
                          width: 39,
                          height: 13,
                          display: "inline-block",
                        }}
                      ></div>
                      &nbsp;
                      {/* Camera name with reduced size for display */}
                      <span style={{ fontSize: 12 }}>
                        {reduceStringSize(camName)}
                      </span>
                    </div>
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>
    </>
  );
};

export default HorizontalBarChart;
