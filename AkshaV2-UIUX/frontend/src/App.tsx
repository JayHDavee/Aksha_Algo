import { ThemeProvider } from "@emotion/react";
import { BrowserRouter } from "react-router-dom";
import { useEffect } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { connect, useDispatch } from "react-redux";

import Router from "./router/Router";
import Snackbar from "./component/common/CustomizedSnackbars";
import theme from "./theme";
import { isMobile } from "./utils/common";
import { AuthProvider } from './context/AuthContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { mobileDevice } from "./global_store/reducers/deviceCheckReducer";
import "./i18n";
// Define props from Redux
type AppProps = {
  show: boolean;
  indicator: any;
  message: string;
};

// Main component
const App = ({ show, indicator, message }: AppProps) => {
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(mobileDevice({ is_mobile: isMobile.any() }));
  }, [dispatch]);

  return (
    <>
      <BrowserRouter>
        <ThemeProvider theme={theme}>
          <AuthProvider>
            <FeatureFlagsProvider>
              <Router />
              <Snackbar show={show} indicator={indicator} message={message} />
              <ToastContainer position="bottom-right" />
            </FeatureFlagsProvider>
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </>
  );
};

// Map Redux state to props
const mapStateToProps = (state: any): AppProps => {
  const { show, indicator, message } = state.snackBar.toast;
  return { show, indicator, message };
};

export default connect(mapStateToProps)(App);