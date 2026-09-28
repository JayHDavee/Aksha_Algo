/**
 * Custom date selector component using MUI StaticDatePicker
 * Returns a single date selected by the user
 * @module CustomDateSelector
 */

import React, { useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import TextField from '@mui/material/TextField';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { StaticDatePicker } from '@mui/x-date-pickers/StaticDatePicker';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import '../../../common/asterics_styles/asteric.css';

/**
 * Props interface for CustomDateSelector component
 */
interface CustomDateSelectorProps {
  /** Heading text for the date selector */
  heading: string;
  /** Current text value to display */
  text: string;
  /** Whether this tab is currently active */
  active: boolean;
  /** Index of this tab in the tab array */
  index: number;
  /** Callback to change active CSS */
  onChangeActiveCss: (index: number) => void;
  /** Whether this is mobile view */
  mobile: boolean;
  /** Current date value */
  value: Dayjs | null;
  /** Callback when date changes */
  onChange: (newValue: Dayjs | null, index: number) => void;
}

/**
 * Custom date selector component that displays a popover with date picker
 * @param {CustomDateSelectorProps} props - Component props
 * @returns {JSX.Element} Custom date selector component
 */
const CustomDateSelector: React.FC<CustomDateSelectorProps> = ({
  heading,
  text,
  active,
  index,
  onChangeActiveCss,
  mobile,
  value,
  onChange
}) => {
  const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);

  /**
   * Handle click event to open popover
   * @param {React.MouseEvent<HTMLDivElement>} event - Click event
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    setAnchorEl(event.currentTarget);
  };

  /**
   * Handle close event to close popover
   */
  const handleClose = () => {
    setAnchorEl(null);
  };

  // Popover state management
  const open = Boolean(anchorEl);
  const id = open ? 'simple-popover' : undefined;

  return (
    <div>
      <div
        className={`inner-content text-center ${active === true && "activeTab"}`}
        key={index}
        onClick={(e) => {
          handleClick(e);
          onChangeActiveCss(index);
        }}
      >
        {mobile === false && (
          <p>
            <span>{heading.slice(0, -1)}</span>
            <span className='asterics_style'>{heading.charAt(heading.length - 1)}</span>
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
        <Typography sx={{ p: 2 }} style={{ overflowX: 'scroll' }}>
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <StaticDatePicker
              displayStaticWrapperAs="desktop"
              minDate={dayjs().subtract(10, 'day')}  // Min date allowed: 10 days before today
              maxDate={dayjs().subtract(1, 'day')}  // Max date allowed: yesterday
              value={value} // State value
              onChange={(newValue) => {
                onChange(newValue, index);
              }}
              renderInput={(params) => <TextField {...params} sx={{}} />}
              views={['day']}
            />
          </LocalizationProvider>
        </Typography>
      </Popover>
    </div>
  );
};

export default CustomDateSelector;
