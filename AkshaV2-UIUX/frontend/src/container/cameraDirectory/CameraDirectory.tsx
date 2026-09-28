import React, { useState, useEffect } from "react";
import Tabs from "../../component/Tabs/ColorTabs";
import List from "./List/List";
import CameraGroup from "../cameraGroup/CameraGroup";
import CameraNotificationManager from "../cameraNotificationManager/CameraNotificationManager";
import MobileUsers from "../mobileUsers/MobileUsers";

const CameraDirectory: React.FC = () => {
  const [camDirectory, setCamDirectory] = useState(true);
  const [activeTab, setActiveTab] = useState<
    "directory" | "group" | "notification" | "mobile"
  >("directory");

  const tabs = [
    {
      value: "one",
      label: camDirectory
        ? "Camera Directory"
        : "Camera Details",
      component: (
        <List
          camDirectory={camDirectory}
          setCamDirectory={setCamDirectory}
          setActiveTab={setActiveTab}   // 👈 ADD
        />
      ),
    },
    {
      value: "two",
      label: camDirectory
        ? "Camera Group"
        : "Camera Group Details",
      component: (
        <CameraGroup
          camDirectory={camDirectory}
          setCamDirectory={setCamDirectory}
          setActiveTab={setActiveTab}   // 👈 ADD
        />
      ),
    },
    {
      value: "three",
      label: "Notification Manager",
      component: (
        < CameraNotificationManager
          setActiveTab={setActiveTab}
          setCamDirectory={setCamDirectory}
        />
      ),
    },
    {
      value: "four",
      label: "Mobile users",
      component: <MobileUsers setCamDirectory={setCamDirectory} />,
    },
  ];


  return (
    <div style={{ marginTop: 68 }}>
      {/* Tabs MUST always be mounted */}
      <Tabs
        tabName={tabs.map(t => ({ value: t.value, label: t.label }))}
        pages={tabs.map(t => ({ value: t.value, component: t.component }))}
        showOnlyActiveTab={!camDirectory}   // ✅ MAGIC LINE
      />

    </div>
  );
};

export default CameraDirectory;


