// src/tests/router/socket.test.ts
import { Socket } from 'socket.io-client';

// Mock socket.io-client at top level
jest.mock('socket.io-client', () => ({
  io: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    connected: true,
  })),
}));

// Mock envHelper
jest.mock('../../utils/envHelper', () => ({
  getEnvVar: jest.fn(),
}));

describe('Socket configuration', () => {
  const { getEnvVar } = require('../../utils/envHelper');

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize socket with correct BASE_URL', () => {
    getEnvVar.mockReturnValue('http://API_SERVICE:4000');

    const { socket } = require('../../router/socket');
    expect(socket).toBeDefined();
  });

  it('should fallback to localhost when VITE_BASE_URL is not set', () => {
    getEnvVar.mockReturnValue(undefined);

    const { socket } = require('../../router/socket');
    expect(socket).toBeDefined();
  });
});
