import { useCallback } from 'react';
import axios from 'axios';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  headers?: Record<string, string>;
  timeout? : any;
}

/**
 * Hook to make authenticated API calls using Axios with consistent options.
 */
export const useApi = () => {
  /**
   * Generic API call handler using axiosJWT (with token).
   *
   * @param url - Full API URL to call.
   * @param options - Method, headers, body, etc.
   * @returns A Promise resolving to the Axios response.
   */
  const callApi = useCallback(
    async (
      url: string,
      options: RequestOptions = {}
    ): Promise<any> => {
      const {
        method = 'POST',
        body = {},
        headers = { 'Content-Type': 'application/json'  },
        timeout = 10000
      } = options;

      const config = { headers , timeout };
      //   console.log('body', body);
      // console.log(headers, timeout);
      try {
        if (method === 'GET') {
          return await axios.get(url, config);
        } else if (method === 'POST') {
          return await axios.post(url, body, config);
        } else if (method === 'PUT') {
          return await axios.put(url, body, config);
        } else if (method === 'DELETE') {
          return await axios.delete(url, config);
        }
      } catch (error) {
        console.error(`[useApi] ${method} ${url} failed:`, error);
        throw error;
      }
    },
    []
  );

  return { callApi };
};
