import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Define the toast state structure
interface ToastState {
  show: boolean;
  indicator: string; // Can be 'success' | 'error' | 'warning' etc. if you want to restrict
  message: string;
}

// Full state structure for the snackbar slice
interface SnackbarState {
  toast: ToastState;
}

// Initial state
const initialState: SnackbarState = {
  toast: {
    show: false,
    indicator: '',
    message: '',
  },
};

/**
 * snackBarSlice
 * Controls visibility and content of global toast notifications.
 */
const snackBarSlice = createSlice({
  name: 'snackbar',
  initialState,
  reducers: {
    /**
     * Show or hide the toast with a given message and indicator
     * @param state - Current snackbar state
     * @param action - Payload with toast details
     */
    showToast: (state, action: PayloadAction<ToastState>) => {
      const { show, indicator, message } = action.payload;
      state.toast = { show, indicator, message };
    },
  },
});

// Export actions and reducer
export const { showToast } = snackBarSlice.actions;
export default snackBarSlice.reducer;
