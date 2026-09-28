/**
 * Type definitions for Activity Tracker component
 * @module ActivityTrackerTypes
 */

/**
 * Represents a search tab configuration
 */
export interface SearchTab {
  /** Display heading for the tab */
  heading: string;
  /** Current text value displayed in the tab */
  text: string;
  /** Whether this tab is currently active */
  active: boolean;
}

/**
 * Configuration for date range selection
 */
export interface DateRange {
  /** Start date of the range */
  startDate: Date;
  /** End date of the range */
  endDate: Date;
  /** Unique key identifier */
  key: string;
}

/**
 * API request payload for camera insights
 */
export interface CameraInsightRequest {
  /** Name of the selected camera */
  Camera_Name: string;
  /** Start date in YYYY-MM-DD format */
  Start_Date: string;
  /** End date in YYYY-MM-DD format */
  End_Date: string;
  /** Start time in HH:MM:SS format */
  Start_Time: string;
  /** End time in HH:MM:SS format */
  End_Time: string;
}

/**
 * Response structure for camera insights
 */
export interface CameraInsightResponse {
  /** Generated insight data */
  insight: {
    /** URL/path to the insight image/video */
    image: string;
    /** Name of the camera */
    camera_Name: string;
  };
}

/**
 * Camera information structure
 */
export interface CameraInfo {
  /** Unique identifier for the camera */
  id?: string;
  /** Display name of the camera */
  Camera_Name: string;
  /** Whether the camera is active */
  Active: boolean;
  /** Additional camera properties */
  [key: string]: any;
}
