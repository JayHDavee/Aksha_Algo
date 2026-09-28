/**
 * Type definitions for Alert Report components
 * @module AlertReportTypes
 */

/**
 * Interface for camera data structure
 */
export interface CameraData {
  total_alerts_generated: number;
  object_detection_alerts: Record<string, any>;
  most_active_hour_for_each_object: Record<string, any>;
  peak_alert_time_hour: string | null;
  alerts: Record<string, AlertDetail>;
}

/**
 * Interface for individual alert details
 */
export interface AlertDetail {
  object: string;
  timestamp: string;
  link?: string;
  my_alert_name?: string[];
  no_obj_status?: boolean;
}

/**
 * Interface for report data structure
 */
export interface ReportData {
  [cameraName: string]: CameraData;
}

/**
 * Interface for search tab configuration
 */
export interface SearchTab {
  heading: string;
  text: string | string[];
  active: boolean;
}

/**
 * Interface for dropdown component props
 */
export interface DropdownProps {
  heading: string;
  active: boolean;
  options: string[];
  selectedLabels: string[];
  setSelectedLabels: React.Dispatch<React.SetStateAction<string[]>>;
  mobile: boolean;
}

/**
 * Interface for chart data
 */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor: string[];
    borderColor: string[];
    borderWidth: number;
  }>;
}

/**
 * Interface for date range
 */
export interface DateRange {
  startDate: Date;
  endDate: Date;
  key: string;
}

/**
 * Interface for time selection
 */
export interface TimeSelection {
  startTime: string;
  endTime: string;
}

/**
 * Interface for camera selection
 */
export interface CameraSelection {
  name: string;
  isCamera: boolean;
}
