import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import thunk from 'redux-thunk';

import Investigation from '../../../container/investigation/Investigation';

// Mock envHelper
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_DELETE_ALERT: '/api/delete-alert',
    };
    return envs[key] || '';
  }),
}));

// Mock react-konva
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

const mockStore = configureStore([thunk]);

describe('Investigation Component', () => {
  it('renders without crashing', () => {
    const store = mockStore({
      isMobileDevice: { is_mobile: false },

      investigation: {
        isCoordinatesSelected: false,
        allCameraNames: [
          { id: 1, name: "Camera 1", Active: true },
          { id: 2, name: "Camera 2", Active: false },
        ],
      },

      snackBar: {
        toast: { show: false, indicator: 'success', message: '' },
      },
    });

    const { getAllByText } = render(
      <Provider store={store}>
        <MemoryRouter>
          <Investigation />
        </MemoryRouter>
      </Provider>
    );

    // Use getAllByText to avoid multiple-elements error
    expect(getAllByText(/Object of Interest/i).length).toBeGreaterThan(0);
    expect(getAllByText(/Recent Alerts/i).length).toBeGreaterThan(0);
    expect(getAllByText(/My Alerts/i).length).toBeGreaterThan(0);
    expect(getAllByText(/Auto Alerts/i).length).toBeGreaterThan(0);
  });
});
