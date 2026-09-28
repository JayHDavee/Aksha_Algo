import React from "react";
import Tabs from "../../component/Tabs/ColorTabs";
import ActivityTracker from "../../component/insights/activityTracker/ActivityTracker";
import AlertReport from "../../component/insights/alertReport/AlertReport";
import Kreport from "../../component/insights/Kreport/Kreport";
/**
 * Insights Component
 * Renders tabs for:
 * - Activity Tracker
 * - Report (Alert Report)
 */
const Insights: React.FC = () => {
  return (
    <div style={{ marginTop: 68 }}>
      <Tabs
        tabName={[
          { value: "one", label: "Activity Tracker" },
          { value: "two", label: "Report" },
          { value : "three", label: "KPI Report"},
        ]}
        pages={[
          { value: "one", component: <ActivityTracker /> },
          { value: "two", component: <AlertReport /> },
          { value: "three", component:<Kreport/>},
        ]}
      />
    </div>
  );
};

export default Insights;
