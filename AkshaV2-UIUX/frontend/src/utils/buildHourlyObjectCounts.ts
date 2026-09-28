

export interface RecordItem {
  timestamp: string;
  counts?: {
    person?: number;
    [key: string]: number | undefined;
  };
}

export interface CameraReport {
  camera_name: string;
  records: RecordItem[];
}

type HourLabel = string; // e.g. "09:00"
type CameraObjectKey = `${string}__person`;

interface HourAggregation {
  total: number;
  count: number;
}


interface HourMap {
  [hour: HourLabel]: {
    [key: CameraObjectKey]: HourAggregation;
  };
}

interface ResultData {
  [hour: HourLabel]: {
    [key: CameraObjectKey]: number;
  };
}

export interface HourlyObjectCountsResult {
  labels: HourLabel[];
  data: ResultData;
}



export const buildHourlyObjectCounts = (
  reportData: CameraReport[],
  selectedLabels: string[]
): HourlyObjectCountsResult => {
  const hourMap: HourMap = {};

  reportData.forEach((camera) => {
    const camName = camera.camera_name;

    camera.records.forEach((rec) => {
      const date = new Date(rec.timestamp);
      const hour = date.getHours();
      const endHour = (hour + 1) % 24;
      const hourKey: HourLabel = `${String(endHour).padStart(2, "0")}:00`;

      if (!hourMap[hourKey]) {
        hourMap[hourKey] = {};
      }

      const camKey: CameraObjectKey = `${camName}__person`;

      if (!hourMap[hourKey][camKey]) {
        hourMap[hourKey][camKey] = {
          total: 0,
          count: 0,
        };
      }

      const personCount = rec.counts?.person ?? 0;

      hourMap[hourKey][camKey].total += personCount;
      hourMap[hourKey][camKey].count += 1;
    });
  });

  const result: ResultData = {};

  Object.entries(hourMap).forEach(([hour, camData]) => {
    result[hour] = {};

    Object.entries(camData).forEach(([camKey, obj]) => {
      result[hour][camKey as CameraObjectKey] =
        obj.count > 0 ? Math.round(obj.total / obj.count) : 0;
    });
  });

  return {
    labels: Object.keys(result).sort(),
    data: result,
  };
};
