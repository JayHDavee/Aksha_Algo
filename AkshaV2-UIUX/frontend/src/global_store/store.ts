import { configureStore } from "@reduxjs/toolkit";
import { TypedUseSelectorHook, useDispatch, useSelector } from "react-redux";
import monitorReducer from "./reducers/monitorReducer";
import investigationReducer from "./reducers/investigationReducer";
import snackBarReducer from "./reducers/snackBarReducer";
import deviceCheckReducer from "./reducers/deviceCheckReducer";
import  alertReportReducer from './reducers/alertReportReducer';
import authReducer from './reducers/authReducer'

/**
 * Root Redux Store
 * Combines all app slices and sets up dev tools
 */
const store = configureStore({
  reducer: {
    monitor: monitorReducer,
    investigation: investigationReducer,
    snackBar: snackBarReducer,
    isMobileDevice: deviceCheckReducer,
    alertReport: alertReportReducer,
    auth: authReducer
  },
  devTools: import.meta.env.VITE_NODE_ENV !== 'production', // Enable Redux DevTools only in development
});

// Infer AppDispatch and RootState from store itself
export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;

// Typed versions of useDispatch and useSelector for better DX and type safety
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export default store;

