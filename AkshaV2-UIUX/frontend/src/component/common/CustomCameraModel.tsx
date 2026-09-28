

import React from "react";

// Define camera object shape
interface CameraData {
  Camera_Name: string;
}

// Define props for the component
interface CustomCameraModelProps {
  index: number;
  close: () => void;
  selectedCamera: string;
  onCameraChange: (val: string, index: number) => void;
  allActiveCameras: CameraData[];
}

// Inline style object similar to your given example
const styles = {
  wrapper: {
    padding: '8px',
    width: '145px',
  } as React.CSSProperties,

  ul: {
    listStyle: 'none',
    marginLeft: 0,
    paddingLeft: 0,
  } as React.CSSProperties,

  li: {
    padding: '10px 20px',
    marginBottom: '8px',
    borderRadius: '7px',
    cursor: 'pointer',
    transition: 'all 600ms',
  } as React.CSSProperties,

  liHoverActive: {
    backgroundColor: '#E8EDFC',
  } as React.CSSProperties,

  p: {
    marginBottom: 0,
    paddingBottom: 0,
  } as React.CSSProperties,
};

// Main component
const CustomCameraModel: React.FC<CustomCameraModelProps> = ({
  index,
  close,
  selectedCamera,
  onCameraChange,
  allActiveCameras,
}) => {
  // Handle option selection
  const showSelected = (val: string) => {
    onCameraChange(val, index);
    close();
  };

  return (
    <div style={styles.wrapper}>
      <ul style={styles.ul}>
        {allActiveCameras?.length > 0 &&
          allActiveCameras.map((data, idx) => {
            const isActive = selectedCamera === data.Camera_Name;
            return (
              <li
                key={idx}
                style={{
                  ...styles.li,
                  ...(isActive ? styles.liHoverActive : {}),
                }}
                onClick={() => showSelected(data.Camera_Name)}
                onMouseOver={(e) =>
                  (e.currentTarget.style.backgroundColor = '#E8EDFC')
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.backgroundColor = isActive
                    ? '#E8EDFC'
                    : '')
                }
              >
                <p style={styles.p}>{data.Camera_Name}</p>
              </li>
            );
          })}
      </ul>
    </div>
  );
};

export default React.memo(CustomCameraModel);
