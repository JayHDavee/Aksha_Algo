import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
  ChartData,
  ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { CHART_PALETTE } from "../../../../utils/chartColors";


ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend
);


type HourLabel = string;

interface HourlyData {
  [cameraObjectKey: string]: number;
}

interface ChartPayload {
  labels: HourLabel[];
  data: Record<HourLabel, HourlyData>;
}

interface HourlyMultiObjectBarChartProps {
  chartPayload?: ChartPayload | null;
}


const BAR_COLORS: string[] = CHART_PALETTE;


const HourlyMultiObjectBarChart: React.FC<
  HourlyMultiObjectBarChartProps
> = ({ chartPayload }) => {
  if (!chartPayload?.data || !chartPayload?.labels) return null;

  const { labels, data } = chartPayload;


  const valueLabelPlugin = {
  id: "valueLabelPlugin",
  afterDatasetsDraw(chart: any) {
    const { ctx } = chart;

    chart.data.datasets.forEach((dataset: any, datasetIndex: number) => {
      const meta = chart.getDatasetMeta(datasetIndex);

      if (!meta.hidden) {
        meta.data.forEach((bar: any, index: number) => {
          const value = dataset.data[index];

          if (value > 0 && bar) {
            ctx.save();
            ctx.fillStyle = "#000";
            ctx.font = "bold 12px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(value, bar.x, bar.y - 6);
            ctx.restore();
          }
        });
      }
    });
  },
};

  // // Collect all camera__object keys
  // const allKeys = new Set<string>();
  // Object.values(data).forEach((hourObj) =>
  //   Object.keys(hourObj).forEach((k) => allKeys.add(k))
  // );


  // const datasets: ChartData<"bar">["datasets"] = Array.from(allKeys).map(
  //   (key, i) => {
  //     const [camera, object] = key.split("__");

  //     return {
  //       label: `${camera} - ${object}`,
  //       data: labels.map((hour) => data[hour]?.[key] ?? 0),
  //       backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
  //       barThickness: 18,
  //     };
  //   }
  // );

  // Collect unique cameras only
const cameras = new Set<string>();

Object.values(data).forEach((hourObj) =>
  Object.keys(hourObj).forEach((k) => {
    const [camera, object] = k.split("__");

    if (object === "person") {
      cameras.add(camera);
    }
  })
);

const datasets: ChartData<"bar">["datasets"] = Array.from(cameras).map(
  (camera, i) => {
    return {
      label: camera,
      data: labels.map((hour) => {
        const key = `${camera}__person`;
        return data[hour]?.[key] ?? 0;
      }),
      backgroundColor: BAR_COLORS[i % BAR_COLORS.length],
      barThickness: 22,
      borderRadius: 4,
      borderSkipped: false,
    };
  }
);

 const chartData: ChartData<"bar"> = {
    labels,
    datasets,
  }; 

  const options: ChartOptions<"bar"> = {
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
  scales: {
    x: {
      stacked: false,
      grid: { display: false },
      ticks: { font: { family: "Inter, sans-serif", size: 11 } },
    },
    y: {
      stacked: false,
      beginAtZero: true,
      grace: "20%",
      grid: { color: "rgba(15, 23, 42, 0.06)" },
      ticks:{
        precision:0,
        font: { family: "Inter, sans-serif", size: 11 },
      },
      title: {
        display: true,
        text: "Person Count",
        font: { family: "Inter, sans-serif", size: 12 },
      },
    },
  },
};
console.log("LABELS", labels.length);
console.log("DATASETS", datasets.length);
console.log("FIRST DATASET", datasets[0]?.data);

  return (
  <div>
   <Bar data={chartData} options={options} plugins={[valueLabelPlugin]} />

  </div>
);

};

export default HourlyMultiObjectBarChart;
