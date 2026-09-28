import React, { useState, MouseEvent } from 'react';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import CustomCameraModel from './CustomCameraModel';
import './styles/asteric.css';

interface CameraData {
  Camera_Name: string;
}

interface CameraPopoverProps {
  heading: string;
  text: string;
  active: boolean;
  index: number;
  selectedCamera: string;
  onChangeActiveCss: any;
  onCameraChange: any;
  allActiveCameras: CameraData[];
  mobile: boolean;
}


/**
 * CameraPopover Component
 * 
 * @param {Object} props
 * @param {string} props.heading - The heading string (e.g., "Camera*")
 * @param {string} props.text - The subtext to display (e.g., "Camera xyz")
 * @param {boolean} props.active - Whether this tab is active
 * @param {number} props.index - Index of this tab
 * @param {string} props.selectedCamera - Currently selected camera
 * @param {Function} props.onChangeActiveCss - Callback to update active tab
 * @param {Function} props.onCameraChange - Callback to handle camera selection
 * @param {Array} props.allActiveCameras - List of all camera options
 * @param {boolean} props.mobile - Whether it's in mobile view
 */
const CameraPopover: React.FC<CameraPopoverProps> = ({
  heading,
  text,
  active,
  index,
  selectedCamera,
  onChangeActiveCss,
  onCameraChange,
  allActiveCameras,
  mobile,
}) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  // Anchor element for popover
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
    onChangeActiveCss(index);
  };

  // Handle popover close
  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);
  const id = open ? 'camera-popover' : undefined;

  // Render heading with asterisk styling if not mobile
  const renderHeading = () => {
    if (mobile) return null;
    const main = heading.slice(0, -1);
    const asterisk = heading.slice(-1);
    return (
      <p>
        <span>{main}</span>
        <span className="asterics_style">{asterisk}</span>
      </p>
    );
  };

  return (
    <div>
      <div
        className={`inner-content text-center ${active ? 'activeTab' : ''}`}
        onClick={handleClick}
      >
        {renderHeading()}
        <p className="text-label mb-0">{text}</p>
      </div>

      <Popover
        id={id}
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        className="model-radius"
      >
        <Typography sx={{ p: 1 }}>
          <CustomCameraModel
            index={index}
            close={handleClose}
            selectedCamera={selectedCamera}
            onCameraChange={onCameraChange}
            allActiveCameras={allActiveCameras}
          />
        </Typography>
      </Popover>
    </div>
  );
};

export default CameraPopover;
