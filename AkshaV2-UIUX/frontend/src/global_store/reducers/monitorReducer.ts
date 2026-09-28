import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Define the shape of individual data objects
interface CameraInfo {
  // Add more specific fields here if known (e.g., id, name, status)
  [key: string]: any;
}

// Define the structure for camera-related data
interface CameraResponse {
  info: CameraInfo[];
  message: string;
}

// Define the complete state structure for the monitor slice
interface MonitorState {
  cameraDetails: CameraResponse;
  spotLightCameras: CameraResponse;
  notificationsCount: number;
}

// Initial state
const initialState: MonitorState = {
  cameraDetails: {
    info: [],
    message: '',
  },
  spotLightCameras: {
    info: [],
    message: '',
  },
  notificationsCount: 0,
};

/**
 * monitorSlice
 * Manages camera data, spotlight cameras, and notification count
 * used for the monitoring dashboard.
 */
const monitorSlice = createSlice({
  name: 'monitor',
  initialState,
  reducers: {
    /**
     * Sets user camera details (info + message)
     */
    fetchUser: (state, action: PayloadAction<CameraResponse>) => {
      state.cameraDetails = action.payload;
    },

    /**
     * Sets spotlight camera data
     */
    getAllSpotLight: (state, action: PayloadAction<CameraResponse>) => {
      state.spotLightCameras = action.payload;
    },

    /**
     * Updates the count of unread notifications
     */
    notifications: (state, action: PayloadAction<{ notificationsCount: number }>) => {
      state.notificationsCount = action.payload.notificationsCount;
    },
  },
});

// Export actions and reducer
export const { fetchUser, getAllSpotLight, notifications } = monitorSlice.actions;
export default monitorSlice.reducer;
