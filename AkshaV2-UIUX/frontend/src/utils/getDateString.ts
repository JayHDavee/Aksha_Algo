// src/utils/getDateString.ts
import { format } from 'date-fns';

/**
 * Formats a given date (string or Date) into 'yyyy-MM-dd'.
 * Returns an empty string for invalid or empty inputs.
 */
const getDateString = (value: string | Date): string => {
  const date = new Date(value);
  if (isNaN(date.getTime())) return ''; // gracefully handle invalid or empty input
  return format(date, 'yyyy-MM-dd');
};

export default getDateString;
