import { configureStore } from "@reduxjs/toolkit";

// Empty reducer for now — you can add slices as needed
export const store = configureStore({
  reducer: {},
});

// Needed because tests import store as default
export default store;

// Optional: add RootState & AppDispatch types if needed later
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
