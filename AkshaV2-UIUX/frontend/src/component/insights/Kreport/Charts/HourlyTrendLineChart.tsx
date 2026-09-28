import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  ChartData,
  ChartOptions,
} from "chart.js";
import { Line } from "react-chartjs-2";
import ChartDataLabels, { Context } from "chartjs-plugin-datalabels";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  ChartDataLabels
);


type HourLabel = string;

interface HourlyData {
  [cameraObjectKey: string]: number;
}

interface ChartPayload {
  labels: HourLabel[];
  data: Record<HourLabel, HourlyData>;
}

interface HourlyTrendLineChartProps {
  chartPayload?: ChartPayload | null;
}


const HourlyTrendLineChart: React.FC<HourlyTrendLineChartProps> = ({
  chartPayload,
}) => {
  if (!chartPayload?.labels || !chartPayload?.data) return null;

  const { labels, data } = chartPayload;

  const trendData: number[] = labels.map((hour) => {
    const hourObj = data[hour] || {};

    return Object.entries(hourObj)
      .filter(([key]) => key.endsWith("__person"))
      .reduce((sum, [, val]) => sum + (val ?? 0), 0);
  });

  const chartData: ChartData<"line"> = {
    labels,
    datasets: [
      {
        label: "Person Count Trend",
        data: trendData,
        borderColor: "#035faa",
        backgroundColor: "rgba(3, 95, 170, 0.12)",
        pointBackgroundColor: "#ffffff",
        pointBorderColor: "#035faa",
        pointBorderWidth: 2,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        fill: true,

        datalabels: {
          display: true,
          color: "#024578",
          anchor: "end",
          align: "top",
          offset: 6,
          clip: false,
          font: {
            family: "Inter, sans-serif",
            weight: "bold",
            size: 12,
          },
          formatter: (value: number, _ctx: Context) => value,
        },
      },
    ],
  };

 const options: ChartOptions<"line"> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      position: "bottom",
      labels: {
        usePointStyle: true,
        pointStyle: "circle",
        boxWidth: 8,
        boxHeight: 8,
        padding: 16,
        font: { family: "Inter, sans-serif", size: 12 },
      },
    },
  },
  layout: {
    padding: {
      top: 20,
      bottom: 0,
    },
  },
  scales: {
    x: {
      grid: {
        display: false,
      },
      ticks: { font: { family: "Inter, sans-serif", size: 11 } },
    },
    y: {
      beginAtZero: true,
      grace: "20%",
      grid: { color: "rgba(15, 23, 42, 0.06)" },
      title: {
        display: true,
        text: "Person Count",
        font: { family: "Inter, sans-serif", size: 12 },
      },ticks: {
        precision: 0,
        stepSize: 1,
        font: { family: "Inter, sans-serif", size: 11 },
        callback: (value) => Number(value).toFixed(0),
      },
    },
  },
};


  return <Line data={chartData} options={options} />;
};

export default HourlyTrendLineChart;
