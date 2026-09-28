import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import MenuOverlay from '../../../component/video_menu/MenuOverlay';
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

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


const mockStore = configureStore([]);
const store = mockStore({
  isMobileDevice: { is_mobile: false }, // mock your Redux state here
});

describe('MenuOverlay Component', () => {
  const mockInfo = {
    Camera_Name: 'Camera 1',
    Rtsp_Link: 'rtsp://example.com/stream',
    Surveillance_Status: 'start',
    FPS: 30,
  };

  const mockSetShowFunctionDropdown = jest.fn();
  const mockSetMessage = jest.fn();
  const mockSetOpen = jest.fn();

  it('renders MenuOverlay and toggles dropdown', () => {
    const { getByRole } = render(
      <Provider store={store}>
        <MenuOverlay
          info={mockInfo}
          showFunctionDropdown={false}
          setShowFunctionDropdown={mockSetShowFunctionDropdown}
          setMessage={mockSetMessage}
          setOpen={mockSetOpen}
        />
      </Provider>
    );

    const button = getByRole('button');
    expect(button).toBeInTheDocument();

    button.click();
    expect(mockSetShowFunctionDropdown).toHaveBeenCalledWith(true);
  });
});
