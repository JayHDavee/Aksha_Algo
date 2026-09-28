import { renderHook } from '@testing-library/react-hooks';
import { useApi } from '../../hooks/useApi';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// --- Mock envhelper ---
jest.mock('../../utils/envhelper', () => ({
  getEnvVar: (key: string) => {
    const env: Record<string, string> = {
      VITE_BASE_URL: 'https://example.com',
      VITE_ENABLE_CAMERA_MONITOR: '/api/enableCamera',
      VITE_GET_LIVE_CAMERAS: '/api/active/getLiveCamera',
    };
    return env[key];
  },
}));

describe('useApi hook', () => {
  const url = 'https://example.com/api';
  const body = { test: 'data' };
  const headers = { 'Custom-Header': 'value' };
  const timeout = 5000;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should perform a GET request with default config', async () => {
    const response = { data: 'GET success' };
    mockedAxios.get.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useApi());
    const res = await result.current.callApi(url, { method: 'GET', headers, timeout });

    expect(mockedAxios.get).toHaveBeenCalledWith(url, { headers, timeout });
    expect(res).toBe(response);
  });

  it('should perform a POST request with body and headers', async () => {
    const response = { data: 'POST success' };
    mockedAxios.post.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useApi());
    const res = await result.current.callApi(url, { method: 'POST', body, headers, timeout });

    expect(mockedAxios.post).toHaveBeenCalledWith(url, body, { headers, timeout });
    expect(res).toBe(response);
  });

  it('should perform a PUT request with body and headers', async () => {
    const response = { data: 'PUT success' };
    mockedAxios.put.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useApi());
    const res = await result.current.callApi(url, { method: 'PUT', body, headers });

    expect(mockedAxios.put).toHaveBeenCalledWith(url, body, { headers, timeout: 10000 }); // default timeout
    expect(res).toBe(response);
  });

  it('should perform a DELETE request with headers', async () => {
    const response = { data: 'DELETE success' };
    mockedAxios.delete.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useApi());
    const res = await result.current.callApi(url, { method: 'DELETE', headers });

    expect(mockedAxios.delete).toHaveBeenCalledWith(url, { headers, timeout: 10000 }); // default timeout
    expect(res).toBe(response);
  });

  it('should use default POST if no method is provided', async () => {
    const response = { data: 'Default POST success' };
    mockedAxios.post.mockResolvedValueOnce(response);

    const { result } = renderHook(() => useApi());
    const res = await result.current.callApi(url, { body });

    expect(mockedAxios.post).toHaveBeenCalledWith(url, body, {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
      timeout: 10000,
    });
    expect(res).toBe(response);
  });

  it('should throw error on request failure', async () => {
    const error = new Error('Request failed');
    mockedAxios.get.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useApi());
    await expect(result.current.callApi(url, { method: 'GET' })).rejects.toThrow('Request failed');
  });
});
