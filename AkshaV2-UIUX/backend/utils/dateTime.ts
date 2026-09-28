import moment from 'moment';

/**
 * Date and Time Utility Functions
 * 
 * This module provides utility functions for date and time operations
 * used throughout the Aksha surveillance system. It includes:
 * - Date range generation for reports and analytics
 * - Date formatting and validation
 * - Time period calculations for surveillance data
 * 
 * The module uses Moment.js for reliable date manipulation and formatting
 * to ensure consistent date handling across the application.
 */

/**
 * Interface for date range configuration
 */
interface IDateRange {
  startDate: string;
  endDate: string;
  format?: string;
}

/**
 * Interface for date validation result
 */
interface IDateValidation {
  isValid: boolean;
  error?: string;
}

/**
 * Generate an array of all dates between two given dates (inclusive)
 * 
 * This function creates a comprehensive list of dates between a start and end date,
 * useful for generating reports, analytics, and surveillance data queries.
 * The function handles edge cases and ensures proper date ordering.
 * 
 * @param {string | Date} startDate - Start date in any valid format (YYYY-MM-DD recommended)
 * @param {string | Date} endDate - End date in any valid format (YYYY-MM-DD recommended)
 * @param {string} format - Output date format (default: 'YYYY-MM-DD')
 * @returns {string[]} Array of formatted date strings between start and end dates
 * 
 * @example
 * // Generate dates for a week
 * const weekDates = getAllDatesBetween('2023-12-25', '2023-12-31');
 * console.log(weekDates);
 * // Output: ['2023-12-25', '2023-12-26', '2023-12-27', '2023-12-28', '2023-12-29', '2023-12-30', '2023-12-31']
 * 
 * @example
 * // Generate dates with custom format
 * const customDates = getAllDatesBetween('2023-12-25', '2023-12-27', 'DD/MM/YYYY');
 * console.log(customDates);
 * // Output: ['25/12/2023', '26/12/2023', '27/12/2023']
 * 
 * @throws {Error} If start date is after end date
 * @throws {Error} If dates are invalid
 */
export function getAllDatesBetween(
  startDate: string | Date, 
  endDate: string | Date, 
  format: string = 'YYYY-MM-DD'
): string[] {
  try {
    // Validate input parameters
    if (!startDate || !endDate) {
      throw new Error('Both start date and end date are required');
    }

    // Create moment objects for date manipulation
    const currentDate = moment(startDate);
    const stopDate = moment(endDate);

    // Validate that dates are valid
    if (!currentDate.isValid()) {
      throw new Error(`Invalid start date: ${startDate}`);
    }
    if (!stopDate.isValid()) {
      throw new Error(`Invalid end date: ${endDate}`);
    }

    // Ensure start date is not after end date
    if (currentDate.isAfter(stopDate)) {
      throw new Error('Start date cannot be after end date');
    }

    // Generate array of dates
    const dates: string[] = [];
    const iteratorDate = moment(currentDate); // Clone to avoid mutation

    while (iteratorDate.isSameOrBefore(stopDate)) {
      dates.push(iteratorDate.format(format));
      iteratorDate.add(1, 'days');
    }

    // Log the operation for debugging
    console.log(`Generated ${dates.length} dates between ${startDate} and ${endDate}`);

    return dates;
  } catch (error: any) {
    console.error('Error generating date range:', error.message);
    throw new Error(`Failed to generate dates between ${startDate} and ${endDate}: ${error.message}`);
  }
}

/**
 * Validate if a date string is in the correct format
 * 
 * @param {string} dateString - Date string to validate
 * @param {string} expectedFormat - Expected date format (default: 'YYYY-MM-DD')
 * @returns {IDateValidation} Validation result with error details
 * 
 * @example
 * const validation = validateDateFormat('2023-12-25');
 * if (validation.isValid) {
 *   console.log('Date is valid');
 * } else {
 *   console.error('Invalid date:', validation.error);
 * }
 */
export function validateDateFormat(
  dateString: string, 
  expectedFormat: string = 'YYYY-MM-DD'
): IDateValidation {
  try {
    if (!dateString) {
      return { isValid: false, error: 'Date string is required' };
    }

    const parsedDate = moment(dateString, expectedFormat, true);
    
    if (!parsedDate.isValid()) {
      return { 
        isValid: false, 
        error: `Date '${dateString}' does not match expected format '${expectedFormat}'` 
      };
    }

    return { isValid: true };
  } catch (error: any) {
    return { 
      isValid: false, 
      error: `Error validating date: ${error.message}` 
    };
  }
}

/**
 * Get the number of days between two dates
 * 
 * @param {string | Date} startDate - Start date
 * @param {string | Date} endDate - End date
 * @returns {number} Number of days between the dates
 * 
 * @example
 * const daysDiff = getDaysBetween('2023-12-25', '2023-12-31');
 * console.log(daysDiff); // Output: 6
 */
export function getDaysBetween(startDate: string | Date, endDate: string | Date): number {
  try {
    const start = moment(startDate);
    const end = moment(endDate);

    if (!start.isValid() || !end.isValid()) {
      throw new Error('Invalid date provided');
    }

    return end.diff(start, 'days');
  } catch (error: any) {
    console.error('Error calculating days between dates:', error.message);
    throw new Error(`Failed to calculate days between dates: ${error.message}`);
  }
}

/**
 * Format a date to a specific format
 * 
 * @param {string | Date} date - Date to format
 * @param {string} format - Target format (default: 'YYYY-MM-DD')
 * @returns {string} Formatted date string
 * 
 * @example
 * const formatted = formatDate(new Date(), 'DD/MM/YYYY HH:mm:ss');
 * console.log(formatted); // Output: '25/12/2023 14:30:00'
 */
export function formatDate(date: string | Date, format: string = 'YYYY-MM-DD'): string {
  try {
    const momentDate = moment(date);
    
    if (!momentDate.isValid()) {
      throw new Error(`Invalid date: ${date}`);
    }

    return momentDate.format(format);
  } catch (error: any) {
    console.error('Error formatting date:', error.message);
    throw new Error(`Failed to format date: ${error.message}`);
  }
}

/**
 * Get current date in specified format
 * 
 * @param {string} format - Date format (default: 'YYYY-MM-DD')
 * @returns {string} Current date in specified format
 * 
 * @example
 * const today = getCurrentDate();
 * console.log(today); // Output: '2023-12-25'
 */
export function getCurrentDate(format: string = 'YYYY-MM-DD'): string {
  return moment().format(format);
}

/**
 * Check if a date is within a specified range
 * 
 * @param {string | Date} date - Date to check
 * @param {string | Date} startDate - Range start date
 * @param {string | Date} endDate - Range end date
 * @returns {boolean} True if date is within range (inclusive)
 * 
 * @example
 * const isInRange = isDateInRange('2023-12-26', '2023-12-25', '2023-12-31');
 * console.log(isInRange); // Output: true
 */
export function isDateInRange(
  date: string | Date, 
  startDate: string | Date, 
  endDate: string | Date
): boolean {
  try {
    const checkDate = moment(date);
    const rangeStart = moment(startDate);
    const rangeEnd = moment(endDate);

    if (!checkDate.isValid() || !rangeStart.isValid() || !rangeEnd.isValid()) {
      throw new Error('Invalid date provided');
    }

    return checkDate.isBetween(rangeStart, rangeEnd, 'day', '[]'); // '[]' makes it inclusive
  } catch (error: any) {
    console.error('Error checking date range:', error.message);
    return false;
  }
}
