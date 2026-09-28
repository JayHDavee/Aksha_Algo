/**
 * Doughnut chart component for displaying total alerts per camera
 * @module DoughnutChart
 */

import React from 'react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { reduceStringSize } from '../../../../utils/reduceStringSize';
import { CHART_PALETTE } from '../../../../utils/chartColors';
import { ReportData } from '../types';

// Register Chart.js components
ChartJS.register(ArcElement, Tooltip, Legend);

/**
 * Configuration options for the doughnut chart
 */
const options = {
  animation: {
    duration: 0
  },
  cutout: '68%',
  plugins: {
    title: {
      display: false,
    },
    legend: {
      display: true,
      position: "bottom" as const,
      labels: {
        usePointStyle: true,
        pointStyle: 'circle',
        boxWidth: 8,
        boxHeight: 8,
        padding: 16,
        font: {
          family: 'Inter, sans-serif',
          size: 12,
        },
      },
    }
  },
  maintainAspectRatio: false,
};

/**
 * Props interface for DoughnutChart component
 */
interface DoughnutChartProps {
  /** Report data containing camera information and alert counts */
  data: ReportData;
}

/**
 * Doughnut chart component for displaying total alerts per camera
 * @param {DoughnutChartProps} props - Component props
 * @returns {JSX.Element} Doughnut chart component
 */
const DoughnutChart: React.FC<DoughnutChartProps> = ({ data }) => {
  // Get camera names from data
const camNames = Object.keys(data.cameras || {});
  // Format camera names for display
  const formattedCamNames = camNames.length > 0 
    ? camNames.map(camName => camName ? reduceStringSize(camName) : camName) 
    : [];

    
  // Extract total alerts data
 const camData = Object.values(data.cameras || {}).map(
  cam => cam.total_alerts_generated ?? 0
);

 console.log(camData)

  // Chart configuration
  const chartData = {
    labels: formattedCamNames,
    datasets: [
      {
        label: 'Total alerts',
        data: camData,
        backgroundColor: CHART_PALETTE,
        borderColor: '#ffffff',
        borderWidth: 2,
        hoverOffset: 6,
      },
    ],
  };

  return <Doughnut data={chartData} options={options} />

};

export default React.memo(DoughnutChart);
