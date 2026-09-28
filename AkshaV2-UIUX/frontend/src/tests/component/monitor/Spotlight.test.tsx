import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import Spotlight from '../../../component/monitor/Spotlight';
import { socket } from '../../../router/socket';
import { useApi } from '../../../hooks/useApi';

afterEach(() => cleanup());

/* -------------------------------
   Mock Environment Variables
-------------------------------- */
jest.mock("../../../utils/envHelper", () => ({
  getEnvVar: () => "http://localhost:5000",
}));

/* -------------------------------
   Mock Socket
-------------------------------- */
jest.mock('../../../router/socket', () => ({
  socket: {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  },
}));

/* -------------------------------
   Mock API Hook
-------------------------------- */
jest.mock("../../../hooks/useApi", () => {
  const mockFn = jest.fn().mockResolvedValue({
    data: {
      info: [
        { image: "http://localhost/image1.jpg", Frame_Anomaly: true, Object_Anomaly: false, camera_name: "Camera 1" },
        { image: "http://localhost/image2.jpg", Frame_Anomaly: false, Object_Anomaly: true, camera_name: "Camera 2" }
      ]
    },
  });
  return {
    useApi: () => ({ callApi: mockFn }),
  };
});

/* -------------------------------
   Mock Image Modal Component
-------------------------------- */
jest.mock('../../../component/common/ImageModel', () =>
  ({ open, imgUrl }: any) =>
    open ? <div data-testid="image-modal">{imgUrl}</div> : null
);

describe('Spotlight Component', () => {
  const mockCallApi = useApi().callApi as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders without cameras when no data', async () => {
    mockCallApi.mockResolvedValueOnce({ data: { info: [] } });
    render(<Spotlight />);

    await waitFor(() => {
      expect(screen.queryAllByRole('img')).toHaveLength(0);
    });
  });

  test('renders spotlight cameras from API', async () => {
    const mockCameras = [
      { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: true, Object_Anomaly: false },
      { camera_name: 'Camera 2', image: 'image2.jpg', Frame_Anomaly: false, Object_Anomaly: true },
    ];
    mockCallApi.mockResolvedValueOnce({ data: { info: mockCameras } });

    render(<Spotlight />);

    await waitFor(() => {
      expect(screen.getAllByRole('img')).toHaveLength(2);
      expect(screen.getByText('Camera 1')).toBeInTheDocument();
      expect(screen.getByText('Camera 2')).toBeInTheDocument();
    });
  });

  test('displays auto alert indicator for anomalous cameras', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: true, Object_Anomaly: false } ] }
    });

    render(<Spotlight />);

    await waitFor(() => {
      expect(screen.getAllByText('Auto Alert').length).toBeGreaterThan(0);
    });
  });

  test('does not display auto alert for normal cameras', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: false, Object_Anomaly: false } ] }
    });

    render(<Spotlight />);

    await waitFor(() => {
      expect(screen.queryByText('Auto Alert')).not.toBeInTheDocument();
    });
  });

  /* -------------------------------
     ✔ FIXED ERROR LOGGING TEST
  -------------------------------- */
  test('handles API error gracefully', async () => {
    mockCallApi.mockRejectedValueOnce(new Error("API Error"));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(<Spotlight />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to fetch spotlight cameras",
        expect.any(Error)
      );
    });

    consoleSpy.mockRestore();
  });

  /* -------------------------------
     ✔ FIXED MODAL OPENING TEST
  -------------------------------- */
  test('opens image modal when camera image is clicked', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: false, Object_Anomaly: false } ] }
    });

    render(<Spotlight />);

    const imgs = await screen.findAllByRole('img');
    fireEvent.click(imgs[0]);

    await waitFor(() => {
      expect(screen.getByTestId('image-modal')).toBeInTheDocument();
    });
  });

  test('adjusts grid layout based on camera count', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [
        { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: false, Object_Anomaly: false },
        { camera_name: 'Camera 2', image: 'image2.jpg', Frame_Anomaly: false, Object_Anomaly: false }
      ] }
    });

    render(<Spotlight />);

    await waitFor(() => {
      const container = screen.getByText('Camera 1').closest('.videoContainer2');
      expect(container).toHaveClass('col-lg-6');
      expect(container).toHaveClass('col-xl-6');
    });
  });

  test('handles socket updates', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: false, Object_Anomaly: false } ] }
    });

    render(<Spotlight />);

    await waitFor(() => {
      expect(socket.on).toHaveBeenCalledWith('spotlightAllCamera', expect.any(Function));
    });

    const cb = (socket.on as jest.Mock).mock.calls[0][1];

    cb({
      info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: true, Object_Anomaly: false } ],
    });

    await waitFor(() => {
      expect(screen.getByText('Auto Alert')).toBeInTheDocument();
    });
  });

  test('cleans up socket listener on unmount', () => {
    const { unmount } = render(<Spotlight />);
    unmount();

    expect(socket.off).toHaveBeenCalledWith('spotlightAllCamera');
  });

  test('uses cache-busting URL for images', async () => {
    mockCallApi.mockResolvedValueOnce({
      data: { info: [ { camera_name: 'Camera 1', image: 'image1.jpg', Frame_Anomaly: false, Object_Anomaly: false } ] }
    });

    render(<Spotlight />);

    const img = await screen.findByRole('img');
    expect(img.src).toMatch(/image1\.jpg\?\d+/);
  });
});
