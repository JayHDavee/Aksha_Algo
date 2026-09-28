import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Define the shape of the state
interface MobileDeviceState {
  is_mobile: boolean;
}

// Initial state
const initialState: MobileDeviceState = {
  is_mobile: false,
};

/**
 * mobileDeviceSlice
 * Manages whether the current device is a mobile device (used for responsive UI behavior).
 */
const mobileDeviceSlice = createSlice({
  name: 'isMobileDevice',
  initialState,
  reducers: {
    /**
     * Sets the mobile device flag based on screen width/device detection.
     * @param state - Current state
     * @param action - Payload with boolean (true = mobile, false = desktop/tablet)
     */
    mobileDevice: (state, action: any) => {
      state.is_mobile = action.payload;
    },
  },
});

// Export actions and reducer
export const { mobileDevice } = mobileDeviceSlice.actions;
export default mobileDeviceSlice.reducer;
