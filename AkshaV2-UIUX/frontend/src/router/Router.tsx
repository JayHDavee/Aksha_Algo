import React from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";

import Header from "../header/Header";
import Protected from "../component/common/Protected";

import Monitor from "../container/monitor/Monitor";
import Investigation from "../container/investigation/Investigation";
import Insights from "../container/insights/Insights";
import JewelryDashboard from "../container/jewelryDashboard/JewelryDashboard";
import CameraDirectory from "../container/cameraDirectory/CameraDirectory";
import EditCameraDirectory from "../container/cameraDirectory/List/Edit";
import Alerts from "../component/common/customAlertModal/Alerts";
import Loginpage from "../pages/Login";
import Signup from '../pages/Signup';
import ForgotPassword from "../pages/ForgotPassword";
import Footer from "../footer/footer";

const Router: React.FC = () => {
  const isLoggedIn = JSON.parse(localStorage.getItem("isLoggedIn") || "false");
  const location = useLocation();

  // Define routes that should NOT show the Header
  const hideHeaderRoutes = ["/", "/login", "/signup", "/forgotpassword"];

  const shouldHideHeader = hideHeaderRoutes.includes(location.pathname.toLowerCase());

  return (
    <div className="app-layout">
      {!shouldHideHeader && <Header />}

      <main className="app-content">
        <Routes>
          {/* Public Routes */}
          <Route path="/" element={<Loginpage />} />
          <Route path="/login" element={<Loginpage />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgotpassword" element={<ForgotPassword />} />

          {/* Protected Routes */}
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/investigation" element={<Investigation />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/jewelry-dashboard" element={<JewelryDashboard />} />

          <Route
            path="/cameraDirectory"
            element={
              <Protected isLoggedIn={isLoggedIn}>
                <CameraDirectory />
              </Protected>
            }
          />

          <Route
            path="/cameraDirectory/edit"
            element={
              <Protected isLoggedIn={isLoggedIn}>
                <EditCameraDirectory />
              </Protected>
            }
          />

          <Route
            path="/alert"
            element={
              <Protected isLoggedIn={isLoggedIn}>
                <Alerts calledInsideMenu={true} />
              </Protected>
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {!shouldHideHeader && <Footer />}
    </div>
  );

};

export default Router;