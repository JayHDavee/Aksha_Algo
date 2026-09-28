// ✅ Fix TextEncoder/TextDecoder for some libraries like react-dom/server
import { TextEncoder, TextDecoder } from 'util';
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// ✅ Mock Vite's import.meta.env for Jest (Jest runs in Node, not Vite)
(globalThis as any).import = {
  meta: {
    env: {
      VITE_BASE_URL: 'http://mock-api/',
      VITE_CHECK_FOR_WORKING_DAY: 'check-working-day',
      VITE_GET_EMAIL_DETAILS: 'mock/email/details',
      VITE_USER_LOGIN: 'http://mock-api/login',
      NODE_ENV: 'test',
    },
  },
};

// ✅ jest-dom adds useful DOM matchers
import '@testing-library/jest-dom';

// ✅ Mock window.matchMedia for AntD or MUI
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// ✅ Mock ResizeObserver for AntD charts, tables, etc.
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// ✅ Mock Ant Design message and modal methods to prevent real UI calls
jest.mock('antd', () => {
  const actual = jest.requireActual('antd');
  return {
    ...actual,
    message: {
      success: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    },
    Modal: {
      ...actual.Modal,
      confirm: jest.fn(),
      info: jest.fn(),
      success: jest.fn(),
      warning: jest.fn(),
      error: jest.fn(),
    },
  };
});
