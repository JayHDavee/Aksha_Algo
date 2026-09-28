import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import Active from '../../../component/monitor/Active';
import { socket } from '../../../router/socket';
import { useApi } from '../../../hooks/useApi';

// Mock Assets (needed for dynamic button rendering tests)
jest.mock('../../../assets/images/icons/pause.png', () => 'onPauseIcon');
jest.mock('../../../assets/images/icons/play.png', () => 'onPlayIcon');

// Mock socket
jest.mock('../../../router/socket', () => ({
  socket: {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  },
}));

// Mock useApi
const mockCallApi = jest.fn();
jest.mock('../../../hooks/useApi', () => ({
  useApi: () => ({
    callApi: mockCallApi,
  }),
}));

// Mock env helper
const mockBaseUrl = 'http://localhost:3000';
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const env: Record<string, string> = {
      VITE_BASE_URL: mockBaseUrl,
      VITE_ENABLE_CAMERA_MONITOR: '/api/enableCamera',
      VITE_GET_LIVE_CAMERAS: '/api/active/getLiveCamera',
    };
    return env[key];
  },
}));

// Mock child components
jest.mock('../../../component/monitor/Camera', () => ({
  __esModule: true,
  default: ({ camera, liveStatus }: { camera: string; liveStatus: boolean }) => (
    <div data-testid="camera-component" data-live-status={liveStatus ? 'Live' : 'Paused'}>
      {camera}
    </div>
  ),
}));

jest.mock('../../../component/video_menu/MenuOverlay', () => () => (
  <div data-testid="menu-overlay">Menu Overlay</div>
));

jest.mock('../../../component/common/Messagebox', () => ({
  __esModule: true,
  default: ({ open, message }: any) =>
    open ? <div data-testid="message-box">{message}</div> : null,
}));

describe('Active Component', () => {
  const mockCameras = [
    { _id: '1', Camera_Name: 'Camera 1', Active: true, Live: true, Surveillance_Status: 'start', image: 'image1.jpg' },
    { _id: '2', Camera_Name: 'Camera 2', Active: true, Live: false, Surveillance_Status: 'start', image: 'image2.jpg' },
    { _id: '3', Camera_Name: 'Camera 3 (Inactive)', Active: false, Live: true, Surveillance_Status: 'start', image: 'image3.jpg' },
    { _id: '4', Camera_Name: 'Camera 4 (Stopped)', Active: true, Live: false, Surveillance_Status: 'stop', image: 'image4.jpg' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

// --- Remaining tests (1, 2, 3, 4, 5, 8) are passed and remain unchanged ---

  test('1. Fetches data on mount and renders active cameras', async () => {
    mockCallApi.mockResolvedValueOnce({ data: { info: mockCameras } });
    
    render(<Active />);

    expect(mockCallApi).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/active/getLiveCamera`,
        { method: 'GET' }
    );

    const cameras = await screen.findAllByTestId('camera-component');
    expect(cameras).toHaveLength(3);
    expect(screen.queryByText('Camera 3 (Inactive)')).not.toBeInTheDocument();
  });

  test('2. Pauses a LIVE camera: calls API, updates state, and shows success message', async () => {
    mockCallApi.mockResolvedValueOnce({ data: { info: [mockCameras[0]] } });
    mockCallApi.mockResolvedValueOnce({});

    render(<Active />);

    const pauseButtonImg = await screen.findByAltText('pause video');
    fireEvent.click(pauseButtonImg.closest('button')!);

    await waitFor(() => {
      expect(mockCallApi).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/enableCamera?Live=false&Camera_Name=Camera 1`,
        { method: 'GET' }
      );
    });

    expect(screen.getByTestId('message-box')).toHaveTextContent(
      "Camera 'Camera 1' is paused successfully."
    );
    expect(screen.getByAltText('play video')).toBeInTheDocument();
  });

  test('3. Resumes a PAUSED camera: calls API, updates state, and shows success message', async () => {
    mockCallApi.mockResolvedValueOnce({ data: { info: [mockCameras[1]] } });
    mockCallApi.mockResolvedValueOnce({});

    render(<Active />);

    const playButtonImg = await screen.findByAltText('play video');
    fireEvent.click(playButtonImg.closest('button')!);

    await waitFor(() => {
      expect(mockCallApi).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/enableCamera?Live=true&Camera_Name=Camera 2`,
        { method: 'GET' }
      );
    });

    expect(screen.getByTestId('message-box')).toHaveTextContent(
      "Camera 'Camera 2' is resumed successfully."
    );
    expect(screen.getByAltText('pause video')).toBeInTheDocument();
  });

  test('4. Handles API error during initial camera fetch gracefully', async () => {
    mockCallApi.mockRejectedValueOnce(new Error('Initial Fetch Failed'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(<Active />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error fetching live camera data:',
        expect.any(Error)
      );
    });

    expect(screen.queryByTestId('camera-component')).not.toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  test('5. Handles socket updates and renders new camera state', async () => {
    const initialCameras = [mockCameras[0]];
    mockCallApi.mockResolvedValueOnce({ data: { info: initialCameras } });

    render(<Active />);
    
    await waitFor(() => expect(screen.getByTestId('camera-component')).toHaveTextContent('Camera 1'));

    let socketCallback: Function | null = null;
    (socket.on as jest.Mock).mock.calls.forEach(call => {
        if (call[0] === 'liveAllCamera') {
            socketCallback = call[1];
        }
    });

    const updatedCameras = [{ ...mockCameras[0], Live: false }];
    
    act(() => {
      if (socketCallback) {
        socketCallback({ info: updatedCameras });
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('camera-component')).toHaveAttribute('data-live-status', 'Paused');
      expect(screen.getByAltText('play video')).toBeInTheDocument();
    });
  });

  // --- FIXES APPLIED TO TESTS 6 AND 7 ---

  test('6. Applies correct CSS class for "stop" and Paused status', async () => {
    // Data: Camera 1 (Live: true, Status: start) and Camera 4 (Stopped, index 3)
    mockCallApi.mockResolvedValueOnce({ data: { info: [mockCameras[0], mockCameras[3]] } }); // <-- Corrected index 3 for Camera 4

    render(<Active />);
    
    await waitFor(() => {
        // Fix: Use getByText with the selector to target the <p> element, then use .closest() for CSS check
        
        // Camera 1 (Default: Live, Status: start) -> Should have 'bottom-content'
        const cam1TextElement = screen.getByText('Camera 1', { selector: 'p' });
        expect(cam1TextElement.closest('.bottom-content')).toBeInTheDocument();
        expect(cam1TextElement.closest('.bottom-content2')).not.toBeInTheDocument();

        // Camera 4 (Stopped: Live: false, Status: stop) -> Should have 'bottom-content2'
        const cam4TextElement = screen.getByText('Camera 4 (Stopped)', { selector: 'p' });
        expect(cam4TextElement.closest('.bottom-content2')).toBeInTheDocument();
        expect(cam4TextElement.closest('.bottom-content')).not.toBeInTheDocument();
    });
  });

  test('7. Applies correct CSS class for a Paused camera (Live: false)', async () => {
    // Data: Camera 2 (Live: false, Status: start)
    mockCallApi.mockResolvedValueOnce({ data: { info: [mockCameras[1]] } });

    render(<Active />);

    await waitFor(() => {
        // Fix: Use getByText with the selector to target the <p> element
        const cam2TextElement = screen.getByText('Camera 2', { selector: 'p' });

        // Status is 'start', but cam.Live === false, so getContainerStopCamName returns 'bottom-content2'
        expect(cam2TextElement.closest('.bottom-content2')).toBeInTheDocument();
        expect(cam2TextElement.closest('.bottom-content')).not.toBeInTheDocument();
    });
  });

  test('8. Cleans up socket listener on unmount', async () => {
    mockCallApi.mockResolvedValueOnce({ data: { info: [] } });

    let liveAllCameraHandler: Function | null = null;
    (socket.on as jest.Mock).mockImplementation((event, handler) => {
      if (event === 'liveAllCamera') {
        liveAllCameraHandler = handler;
      }
    });

    const { unmount } = render(<Active />);

    await waitFor(() => expect(socket.on).toHaveBeenCalled());
    
    unmount();

    expect(socket.off).toHaveBeenCalledWith('liveAllCamera', liveAllCameraHandler);
  });

});