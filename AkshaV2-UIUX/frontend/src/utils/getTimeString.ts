import dayjs from 'dayjs';

/**
 * Formats a given time value into a string in "HH:mm" or "HH:mm:ss" format.
 *
 * @param value - A date/time input accepted by `dayjs()` (e.g., Date, string, number).
 * @param showSeconds - Whether to include seconds in the output (default: false).
 * @param showMinutes - Whether to include minutes (default: true; if false, minutes are shown as "00").
 *
 * @returns A formatted time string (e.g., "08:30" or "08:00:00").
 */
const getTimeString = (
  value: string | number | Date | dayjs.Dayjs,
  showSeconds: boolean = false,
  showMinutes: boolean = true
): string => {
  const d = dayjs(value);

  // Pad hours (e.g., 8 → "08")
  const hours = d.hour().toString().padStart(2, '0');

  // Pad minutes (e.g., 4 → "04")
  const minutes = d.minute().toString().padStart(2, '0');

  // Start with HH:mm or HH:00 based on showMinutes
  let timeString = showMinutes ? `${hours}:${minutes}` : `${hours}:00`;

  // Optionally add :00 for seconds
  if (showSeconds) {
    timeString += ':00';
  }

  return timeString;
};

export default getTimeString;
