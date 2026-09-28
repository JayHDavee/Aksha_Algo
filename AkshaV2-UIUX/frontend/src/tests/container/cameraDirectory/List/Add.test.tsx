import React from 'react';
import { render } from '@testing-library/react';
import Add from '../../../../container/cameraDirectory/List/Add';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';


jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));
// Mock axiosJWT here ⬇⬇⬇⬇⬇
jest.mock("../../../../context/axiosAuthIntercept", () => ({
  __esModule: true,
  default: {
    get: jest.fn(() =>
      Promise.resolve({
        data: { success: true, labels: [] },
      })
    ),
    post: jest.fn(() =>
      Promise.resolve({
        data: { success: true },
      })
    ),
  },
}));



jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_DELETE_ALERT: '/api/delete-alert',
    };
    return envs[key] || '';
  }),
}));

jest.mock('axios');

const mockStore = configureStore([]);

describe('Add Component', () => {
  const mockProps = {
    setMessage: jest.fn(),
    setOpen: jest.fn(),
    setWarning: jest.fn(),
    showScreen: jest.fn(),
    loadlist: jest.fn(),
    cameradata: {},
    list: [],
    activescreen: '',
    redirectOnSuccess: jest.fn(),
    renderedFrom: '',
    setCamDirectory: jest.fn(),
  };

  // Create initial redux state
  const initialState = {
    isMobileDevice: {
      is_mobile: false,
    },
    // Add more slices if required by Add or Alerts components
  };

  const store = mockStore(initialState);

  it('renders without crashing', () => {
    const { getByText } = render(
      <Provider store={store}>
        <MemoryRouter>
          <Add {...mockProps} />
        </MemoryRouter>
      </Provider>
    );

    expect(getByText(/add features/i)).toBeInTheDocument();
  });
});
