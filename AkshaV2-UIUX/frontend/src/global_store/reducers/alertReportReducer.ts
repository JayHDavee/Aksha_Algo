import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import dayjs from 'dayjs';

// Define the shape of the slice's state
interface AlertReportState {
  reportData: Record<string, any>;  // Can be replaced with a specific type later
  alertDate: string;                // Always store dates as ISO strings (serializable)
}

// Initial state with default alertDate set to yesterday
const initialState: AlertReportState = {
  reportData: {},
  alertDate: dayjs().subtract(1, 'day').format('YYYY-MM-DD'), // Redux requires serializable values
};

/**
 * alertReport slice
 * Handles state for alert reports and the selected alert date.
 */
const alertReportSlice = createSlice({
  name: 'alertReport',
  initialState,
  reducers: {
    /**
     * Sets the alert report data.
     * @param state - Current state
     * @param action - Payload containing the report data
     */
    fetchAlertReport: (state, action: PayloadAction<Record<string, any>>) => {
      state.reportData = action.payload;
    },

    /**
     * Sets the selected alert date.
     * @param state - Current state
     * @param action - Payload containing the new date as string (YYYY-MM-DD)
     */
    setAlertDate: (state, action: PayloadAction<string>) => {
      state.alertDate = action.payload;
    },
  },
});

// Export actions and reducer
export const { fetchAlertReport, setAlertDate } = alertReportSlice.actions;
export default alertReportSlice.reducer;
