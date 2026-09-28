import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from "react-redux";
import configureStore from "redux-mock-store";
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const mockEnv: Record<string, string> = {
      VITE_BASE_URL: 'https://mock-base-url/',
      VITE_CHECK_FOR_WORKING_DAY: 'check-day',
    };
    return mockEnv[key] || '';
  },
}));

jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));


import CameraDirectory from '../../../container/cameraDirectory/CameraDirectory';
import { MemoryRouter } from 'react-router-dom';

// Create mock store
const mockStore = configureStore([]);
const store = mockStore({
  isMobileDevice: { is_mobile: false },
  // add other slices your component uses
});
describe('CameraDirectory Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(
    <Provider store={store}>
      <MemoryRouter>
        <CameraDirectory />
      </MemoryRouter>
    </Provider>
    );
    expect(getByText(/camera directory/i)).toBeInTheDocument();
  });

  // Additional tests for interactions and state can be added here
});
