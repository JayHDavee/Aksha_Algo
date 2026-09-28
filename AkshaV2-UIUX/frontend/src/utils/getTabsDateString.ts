import { format } from 'date-fns';

/**
 * Converts a given date to the format 'dd/MM/yy'.
 *
 * Supports inputs as strings (ISO or RFC format), timestamps, or Date objects.
 */
const getTabsDateString = (value: string | number | Date): string => {
  let dateValue: string | number | Date = value;

  // Handle numeric timestamp strings (e.g., "1717200000000")
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    dateValue = Number(value);
  }

  const date = new Date(dateValue);

  // If date is invalid → return epoch formatted as dd/MM/yy
  if (isNaN(date.getTime())) {
    return '01/01/70';
  }

  return format(date, 'dd/MM/yy');
};

export default getTabsDateString;
