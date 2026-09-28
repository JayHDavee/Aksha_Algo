// src/utils/envHelper.ts (for Jest)
export const getSecretKey = (): string => 'mock-secret';

export const getEnvVar = (key: string): string => {
  const mockEnv: Record<string, string> = {
    VITE_BASE_URL: 'http://localhost:5173',
    VITE_CAMERA: '/api/camera',
    VITE_ALERT: '/api/alert',
    VITE_ALERT_CREATE: '/api/alert/create',
    VITE_ALERT_UPDATE: '/api/alert/update',
    VITE_START_SURVEILLANCE: '/start',
    // add other keys your code uses
  };
  return mockEnv[key] || '';
};
