import React from "react";

import { DateRangePicker } from "react-date-range";
import "react-date-range/dist/styles.css"; // Required base styles
import "react-date-range/dist/theme/default.css"; // Required theme styles
import "./styles/DatesModel.scss"; // Custom styling overrides for react-date-range classes

/**
 * Represents a date range with start and end dates.
 */
interface DateRange {
  startDate: Date;
  endDate: Date;
  key: string;
}

/**
 * Props for the CustomDatePicker component.
 */
interface CustomDatePickerProps {
  /**
   * Currently selected date range(s).
   */
  dates: DateRange[];

  /**
   * Callback triggered when the date range changes.
   * @param range - The selected range object.
   * @param index - Index of the date picker instance (used if multiple instances exist).
   */
  onDateChange: (range: any, index: number) => void;

  /**
   * The index of this date picker instance in the parent component.
   */
  index: number;

  /**
   * Optional maximum selectable date.
   */
  maxDate?: Date;

  /**
   * Optional minimum selectable date.
   */
  minDate?: Date;

  /**
   * Number of months to display side-by-side in the picker.
   * @default 2
   */
  months?: number;

  /**
   * Whether to show a visual preview while selecting dates.
   * @default false
   */
  showPreview?: boolean;
}

// Inline styles for the wrapper container
const styles = {
  container: {
    padding: "8px",
    display: "inline-block",
  } as React.CSSProperties,
};

/**
 * A reusable date range picker component built using `react-date-range`.
 *
 * It allows users to select a range of dates, and passes the selected range
 * back to the parent component via `onDateChange`.
 *
 * All appearance-related customization for inner date cells and layout is handled via `DatesModel.css`.
 *
 * @component
 */
const CustomDatePicker: React.FC<CustomDatePickerProps> = ({
  dates,
  onDateChange,
  index,
  maxDate,
  minDate,
  months = 2,
  showPreview = false,
}) => {
  return (
    <div className="range-picker-search-bar" style={styles.container}>
      <DateRangePicker
        ranges={dates}
        onChange={(item: any) => onDateChange(item, index)}
        moveRangeOnFirstSelection={false}
        direction="horizontal"
        preventSnapRefocus={true}
        showDateDisplay={false}
        showMonthAndYearPickers={false}
        fixedHeight={true}
        showPreview={showPreview}
        months={months}
        minDate={minDate}
        maxDate={maxDate}
      />
    </div>
  );
};

export default CustomDatePicker;