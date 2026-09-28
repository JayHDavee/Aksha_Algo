// src/tests/context/axiosAuthIntercept.test.ts

// ✅ Define these at the top before any imports
let registeredFulfilled: any;
let registeredRejected: any;
const mockUse = jest.fn((fulfilled: any, rejected: any) => {
  registeredFulfilled = fulfilled;
  registeredRejected = rejected;
});

// ✅ Mock axios BEFORE importing the interceptor
jest.doMock('axios', () => ({
  interceptors: {
    request: {
      use: mockUse,
    },
  },
}));

// ✅ Mock envHelper BEFORE importing anything that uses it
const mockGetEnvVar = jest.fn();
jest.doMock('../../utils/envHelper', () => ({
  getEnvVar: mockGetEnvVar,
}));

// ✅ Import AFTER mocks (so actual files use mocks)
const axios = require('axios');
const { getEnvVar } = require('../../utils/envHelper');
require('../../context/axiosAuthIntercept'); // interceptor registration

// ✅ Tests
describe('Axios Interceptor', () => {
  it('should register interceptor on import', () => {
    expect(mockUse).toHaveBeenCalledTimes(1);
    expect(typeof registeredFulfilled).toBe('function');
    expect(typeof registeredRejected).toBe('function');
  });

  it('should add Authorization header if token exists', () => {
    mockGetEnvVar.mockReturnValue('test-token');
    const config = { headers: {} };
    const newConfig = registeredFulfilled(config);
    expect(newConfig.headers.Authorization).toBe('Bearer test-token');
  });

  it('should not add Authorization header if token does not exist', () => {
    mockGetEnvVar.mockReturnValue('');
    const config = { headers: {} };
    const newConfig = registeredFulfilled(config);
    expect(newConfig.headers.Authorization).toBeUndefined();
  });

  it('should reject promise on error', async () => {
    const error = new Error('Request error');
    await expect(registeredRejected(error)).rejects.toThrow('Request error');
  });
});
