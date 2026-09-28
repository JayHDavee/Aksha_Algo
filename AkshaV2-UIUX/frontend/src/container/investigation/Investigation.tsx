import React from "react";
import Tabs from "../../component/Tabs/ColorTabs";
import ObjectOfInterest from "../../component/investigation/ObjectOfInterest/ObjectOfInterest";
import RecentAlerts from "../../component/investigation/RecentAlerts/RecentAlerts";
import MyAlerts from "../../component/investigation/MyAlerts/MyAlerts";

/**
 * Investigation Component
 * Renders three tabs for various alert and interest investigations:
 * - Object of Interest
 * - Recent Alerts
 * - My Alerts
 *
 * (Auto Alerts tab is hidden — component still exists, just not wired in here.)
 */
const Investigation: React.FC = () => {
  return (
    <div style={{ marginTop: 68 }}>
      <Tabs
        tabName={[
          { value: "one", label: "Recent Alerts" },
          { value: "two", label: "My Alerts" },
          { value: "four", label: "Object of Interest" },
        ]}
        pages={[
          { value: "one", component: <RecentAlerts /> },
          { value: "two", component: <MyAlerts /> },
          { value: "four", component: <ObjectOfInterest /> },
        ]}
      />
    </div>
  );
};

export default Investigation;
