// ✅ src/tests/services/alertReportService.test.ts

// ✅ Mock envHelper BEFORE importing anything that uses it
jest.mock('../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envMap: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_INSIGHT_REPORT: '/api/report/daily',
      VITE_PASSWORD_SECRET_KEY: 'mock-key',
    };
    return envMap[key] || '';
  }),
}));

// ✅ Mock useApi BEFORE import
jest.mock('../../hooks/useApi', () => ({
  useApi: jest.fn(),
}));

import { getDailyAlertReport } from '../../services/alertReportService';
import { useApi } from '../../hooks/useApi';
import { getEnvVar } from '../../utils/envHelper';

describe('getDailyAlertReport', () => {
  const mockCallApi = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // ✅ Mock window.location.hostname
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
    });

    // ✅ Mock useApi
    (useApi as jest.Mock).mockReturnValue({
      callApi: mockCallApi,
    });
  });

  it('should call callApi with correct URL and body', async () => {
    const mockResponse = { data: 'report' };
    mockCallApi.mockResolvedValueOnce(mockResponse);

    const date = '2025-07-23';
    const result = await getDailyAlertReport(date);

    expect(mockCallApi).toHaveBeenCalledWith(
      'http://localhost:3000/api/report/daily',
      {
        method: 'POST',
        body: { date },
      }
    );

    expect(result).toBe(mockResponse);
  });

  it('should throw an error if callApi fails', async () => {
    const mockError = new Error('API failed');
    mockCallApi.mockRejectedValueOnce(mockError);

    await expect(getDailyAlertReport('2025-07-23')).rejects.toThrow('API failed');
  });
});
