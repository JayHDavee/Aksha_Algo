import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import List from '../../../../container/cameraDirectory/List/List';
import { MemoryRouter } from 'react-router-dom';

// Mock Redux useSelector
jest.mock('react-redux', () => ({
  useSelector: jest.fn(() => ({ is_mobile: false })),
}));
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

// Mock envHelper
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const vars = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_CAMERA: '/camera',
      VITE_CAMERA_UPDATE: '/camera/update/',
      VITE_CAMERA_DELETE: '/camera/delete/',
      VITE_CAMERA_ALL_EMAIL_ALERTS: '/camera/email-all?',
      VITE_CAMERA_ALL_DISPLAY_ALERTS: '/camera/display-all?',
      VITE_START_SURVIELLANCE: '/start',
      VITE_BASE_URL: 'http://localhost:3000',
    };
    return vars[key] || '';
  },
}));

// ⭐ Most important mock: bypass API and return camera list
jest.mock('../../../../hooks/useApi', () => ({
  useApi: () => ({
    callApi: () =>
      Promise.resolve({
        data: {
          cameras: [
            {
              _id: '1',
              Camera_Name: 'Cam 1',
              Rtsp_Link: 'rtsp://test',
              Active: true,
              Email_Auto_Alert: true,
              Display_Auto_Alert: true,
              Email_Alert: true,
              Display_Alert: true,
            },
          ],
        },
      }),
  }),
}));

describe('List Component', () => {
  it('renders camera list after data loads', async () => {
    render(
      <MemoryRouter>
        <List camDirectory={true} setCamDirectory={() => {}} />
      </MemoryRouter>
    );

    // Wait until the loader disappears and data is rendered
    expect(await screen.findByText(/Cam 1/i)).toBeInTheDocument();
  });
});
