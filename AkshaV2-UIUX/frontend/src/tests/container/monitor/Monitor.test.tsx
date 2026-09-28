import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import configureStore from "redux-mock-store";
import thunk from "redux-thunk";


const middlewares = [thunk];
const mockStore = configureStore(middlewares);
jest.mock('socket.io-client', () => {
  const mSocket = {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
  return { io: jest.fn(() => mSocket) }; // <- correct!
});

import Monitor from '../../../container/monitor/Monitor';

// Mock envHelper
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "3000",
      VITE_DELETE_ALERT: "/api/delete-alert",
    };
    return envs[key] || "";
  }),
}));

// Mock axiosAuthIntercept
jest.mock('../../../context/axiosAuthIntercept', () => ({
  get: jest.fn(() => Promise.resolve({ data: {} })),
  post: jest.fn(() => Promise.resolve({ data: {} })),
}));

// Mock Konva
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

describe('Monitor Component', () => {
  it('renders without crashing', () => {
    const store = mockStore({
      snackBar: { toast: { show: false } },
      investigation: { duration: 0 },
    });

    const { getByText } = render(
      <Provider store={store}>
        <MemoryRouter>
          <Monitor />
        </MemoryRouter>
      </Provider>
    );

    // Check UI content
    expect(getByText(/Live/i)).toBeInTheDocument();
    expect(getByText(/Spotlight/i)).toBeInTheDocument();
  });
});
