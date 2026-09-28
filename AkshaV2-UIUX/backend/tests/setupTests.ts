import { jest } from '@jest/globals';

// Mock external dependencies here, e.g., database, axios, etc.
jest.mock('axios', () => ({
  post: jest.fn(() => Promise.resolve({ data: 'mocked response' })),
}));

// Mock any other modules as needed
