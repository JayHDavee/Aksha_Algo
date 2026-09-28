import * as React from "react";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import CustomTimePicker from "./CustomTimePicker";
import "./styles/timePickerPopover.scss";
import "./styles/asteric.css";

/**
 * Props for the TimePickerPopover component.
 */
interface TimePickerPopoverProps {
  heading: string; // e.g. "Time*"
  text: string; // e.g. "07 - 19"
  active: boolean;
  index: number;

  mobile?: boolean;

  starTime: any; // e.g. "07:00"
  endTime: any;  // e.g. "19:00"

  setStartTime: any;
  setEndTime: any;

  onChangeActiveCss: (index: number) => void;
}

/**
 * TimePickerPopover
 *
 * A reusable popover component that displays two `CustomTimePicker` inputs
 * inside a styled MUI popover.
 *
 * Used for selecting a time range (From - To).
 *
 * @component
 */
const TimePickerPopover: React.FC<TimePickerPopoverProps> = ({
  heading,
  text,
  active,
  index,
  mobile = false,
  starTime,
  endTime,
  setStartTime,
  setEndTime,
  onChangeActiveCss,
}) => {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);

  /**
   * Open the popover when element is clicked.
   */
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
    onChangeActiveCss(index); // highlight current tab
  };

  /**
   * Close the popover.
   */
  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);
  const id = open ? "simple-popover" : undefined;

  return (
    <div>
      <div
        className={`inner-content text-center ${active ? "activeTab" : ""}`}
        key={index}
        onClick={handleClick}
      >
        {!mobile && (
          <p>
            <span>{heading.slice(0, -1)}</span>
            <span className="asterics_style">
              {heading.charAt(heading.length - 1)}
            </span>
          </p>
        )}
        <p className="text-label mb-0">{text}</p>
      </div>

      <Popover
        id={id}
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "left",
        }}
        className="model-radius-timepickerPopover"
      >
        <Typography sx={{ p: 2 }}>
          <div className="row mt-3">
            <div className="col-sm-12 col-md-6 col-lg-6 text-center mb-3">
              <CustomTimePicker
                label="From"
                index={index}
                value={starTime}
                onChange={setStartTime}
              />
            </div>
            <div className="col-sm-12 col-md-6 col-lg-6 text-center">
              <CustomTimePicker
                label="To"
                index={index}
                value={endTime}
                onChange={setEndTime}
              />
            </div>
          </div>
        </Typography>
      </Popover>
    </div>
  );
};

export default TimePickerPopover;
