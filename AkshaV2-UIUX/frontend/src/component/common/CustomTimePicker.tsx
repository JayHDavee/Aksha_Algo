import * as React from "react";
import TextField from "@mui/material/TextField";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import { Dayjs } from "dayjs";

/**
 * Props for the CustomTimePicker component.
 */
interface CustomTimePickerProps {
  label: string; // Label displayed on the time picker
  value: Dayjs | null| any; // Current time value from parent (dayjs object)
  onChange: (val: Dayjs | null| any, index: number) => void; // Callback to update time in parent
  index?: number; // Used when the component is part of a list (e.g. tabs)
  disabled?: boolean; // If true, disables the time picker
}

/**
 * CustomTimePicker
 *
 * A reusable stateless time picker based on MUI v5 and Dayjs.
 * Delegates state handling to the parent.
 *
 * @component
 */
const CustomTimePicker: React.FC<CustomTimePickerProps> = ({
  label,
  value,
  onChange,
  index = 0,
  disabled = false,
}) => {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <TimePicker
        label={label}
        readOnly={disabled}
        value={value}
        onChange={(newValue) => {
          onChange(newValue, index);
        }}
        renderInput={(params) => <TextField {...params} fullWidth />}
      />
    </LocalizationProvider>
  );
};

export default CustomTimePicker;
