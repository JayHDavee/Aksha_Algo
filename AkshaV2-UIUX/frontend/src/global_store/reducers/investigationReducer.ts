import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Camera {
  Camera_Name: string;
  Active: boolean;
}

// Define the state structure
interface InvestigationState {
  allCameraNames: Camera[];
  allObjectOfInterestLabels: string[];
  areaOfInterestImage: string;
  durationTime: number;
  isCoordinatesSelected: boolean | null;
}

// Initial state
const initialState: InvestigationState = {
  allCameraNames: [],
  allObjectOfInterestLabels: [],
  areaOfInterestImage: '',
  durationTime: 0,
  isCoordinatesSelected: null,
};

/**
 * investigationSlice
 * Handles camera list, object labels, duration, coordinate status, and area images
 * used in investigation features of the app.
 */
const investigationSlice = createSlice({
  name: 'investigation',
  initialState,
  reducers: {
    /**
     * Set all camera names in the system
     */
    fetchAllCamerasName: (state, action: any) => {
      state.allCameraNames = action.payload;
    },

    /**
     * Set all object-of-interest labels (tags/categories)
     */
    fetchAllObjectOfInterestLabels: (state, action: PayloadAction<string[]>) => {
      state.allObjectOfInterestLabels = action.payload;
    },

    /**
     * Set the base64 image or URL representing the area of interest
     */
    fetchAreaOfInterestImage: (state, action: any) => {
      state.areaOfInterestImage = action.payload;
    },

    /**
     * Set the selected duration time (e.g., time range in seconds/minutes)
     */
    getDurationTime: (state, action: any) => {
      state.durationTime = action.payload;
    },

    /**
     * Track whether coordinates were selected for area-of-interest marking
     */
    coordinatesSelected: (state, action: PayloadAction<boolean | null>) => {
      state.isCoordinatesSelected = action.payload;
    },
  },
});

// Export actions and reducer
export const {
  fetchAllCamerasName,
  fetchAllObjectOfInterestLabels,
  fetchAreaOfInterestImage,
  getDurationTime,
  coordinatesSelected,
} = investigationSlice.actions;

export default investigationSlice.reducer;
