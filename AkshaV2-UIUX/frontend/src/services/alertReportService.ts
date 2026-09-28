import { useApi } from '../hooks/useApi';


/**
 * Fetches the daily alert report for the given date.
 *
 * @param formattedDate - Date string in "YYYY-MM-DD" format
 * @returns API response promise
 */
export const getDailyAlertReport = async (formattedDate: string) => {
  const { callApi } = useApi();
  const baseUrl = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;
  const endpoint = `${baseUrl}${import.meta.env.VITE_INSIGHT_REPORT}`;

  return await callApi(endpoint, {
    method: 'POST',
    body: { date: formattedDate },
  });
};
