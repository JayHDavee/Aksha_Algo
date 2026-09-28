import * as React from "react";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import CustomDatePicker from "./CustomDatePicker";
import { addDays } from "date-fns";
import './styles/asteric.css';

/**
 * Props for the DatePickerPopover component.
 */
interface DatePickerPopoverProps {
  heading: string; // Label shown above selected date
  text: string; // Selected date range or placeholder
  active: boolean; // Controls active tab styling
  index: number; // Index in tabs array
  dates: { startDate: Date; endDate: Date; key: string }[]; // Current selected date range

  onChangeActiveCss: (index: number) => void; // Callback to set current tab as active
  onDateChange: (item: any, index: number) => void; // Callback to update date

  mobile?: boolean; // Whether view is on mobile (affects heading format)
  minDate?: Date; // Minimum selectable date
  maxDate?: Date; // Maximum selectable date
  months?: number; // Number of calendar months to show
  showPreview?: boolean; // Whether to show visual end-date preview
}

/**
 * A reusable popover component that displays a `CustomDatePicker` when clicked.
 * Used inside tabs where users can select date ranges in-place.
 *
 * @component
 */
const DatePickerPopover: React.FC<DatePickerPopoverProps> = ({
  heading,
  text,
  active,
  index,
  dates,
  onChangeActiveCss,
  onDateChange,
  mobile = false,
  minDate = addDays(new Date(), -10),
  maxDate = new Date(),
  months = 2,
  showPreview = true,
}) => {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);

  /**
   * Open the popover by setting anchor element.
   */
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
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
        onClick={(e) => {
          handleClick(e);
          onChangeActiveCss(index);
        }}
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
        className="model-radius"
      >
        <Typography sx={{ p: 2 }} style={{ overflowX: "scroll" }}>
          <CustomDatePicker
            dates={dates}
            onDateChange={onDateChange}
            index={index}
            maxDate={maxDate}
            minDate={minDate}
            months={months}
            showPreview={showPreview}
          />
        </Typography>
      </Popover>
    </div>
  );
};

export default DatePickerPopover;
