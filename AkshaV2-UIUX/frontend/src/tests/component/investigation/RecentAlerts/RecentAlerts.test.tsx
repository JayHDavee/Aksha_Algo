import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import RecentAlerts from '../../../../component/investigation/RecentAlerts/RecentAlerts';
import axiosJWT from '../../../../context/axiosAuthIntercept';

const mockStore = configureStore([]);

// Mock envHelper
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "3000",
      VITE_ALERTS: "/api/alerts",
      VITE_UPDATE_USER_FEEDBACK: "/api/feedback",
      VITE_CAMERAS_LIST: "/api/cameras",
    };
    return envs[key] || "";
  }),
}));

// Mock child components
jest.mock('../../../../component/investigation/RecentAlerts/CameraAlertBox', () => (props: any) => (
  <div data-testid="camera-alert-box">CameraAlertBox Component</div>
));
jest.mock('../../../../component/common/NotFound', () => () => <div>No Alerts Found</div>);
jest.mock('../../../../hooks/useRemoveScroll', () => () => {});

// Mock Axios
jest.mock('../../../../context/axiosAuthIntercept', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

describe('RecentAlerts Component', () => {
  let store: any;

  beforeEach(() => {
    jest.clearAllMocks();

    store = mockStore({
      investigation: {
        durationTime: '1',
      },
    });

    // Mock GET request to fetch recent alerts
    (axiosJWT.get as jest.Mock).mockResolvedValue({
      data: {
        alert: [
          {
            cameraName: 'Camera 1',
            info: [
              { _id: '1', images: ['image1.jpg', 'image2.jpg'], UserFeedback: false },
            ],
          },
        ],
      },
    });
  });

  it('renders RecentAlerts component with loading and alert boxes', async () => {
    const { getByTestId, queryByText } = render(
      <Provider store={store}>
        <RecentAlerts />
      </Provider>
    );

    // Wait for the CameraAlertBox to render after mock data resolves
    await waitFor(() => expect(getByTestId('camera-alert-box')).toBeInTheDocument());

    // Make sure "No Alerts Found" is NOT rendered
    expect(queryByText('No Alerts Found')).not.toBeInTheDocument();
  });
});
