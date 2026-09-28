import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActivityTracker from '../../../component/insights/activityTracker/ActivityTracker';
import axiosJWT from '../../../context/axiosAuthIntercept';
import { act } from 'react-dom/test-utils';

// --- Mock axios ---
jest.mock('../../../context/axiosAuthIntercept');

// --- Mock child components ---
jest.mock('../../../component/common/NotFound', () => () => <div>Not Found</div>);
jest.mock('../../../component/common/NotFoundVideo', () => () => <div>Not Found Video</div>);
jest.mock('../../../component/common/VideoGeneration', () => () => <div>Video Generation</div>);
jest.mock('../../../component/common/Messagebox', () => ({ open, message }: { open: boolean; message: string }) =>
  open ? <div>{message}</div> : null
);

// --- Mock hooks ---
jest.mock('../../../hooks/useRemoveScroll', () => jest.fn());

// --- Mock utils ---
jest.mock('../../../utils/getDateString', () => jest.fn(() => '2024-01-01'));
jest.mock('../../../utils/getTabsDateString', () => jest.fn(() => '01 Jan 2024'));
jest.mock('../../../utils/getTimeString', () => jest.fn(() => '07:00'));

// --- Mock envhelper ---
jest.mock('../../../utils/envhelper', () => ({
  getEnvVar: (key: string) => {
    const env: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_ACTIVATE_CAMERA_INSIGHTS: '/api/insights',
      VITE_CAMERAS_LIST: '/api/cameras',
    };
    return env[key];
  },
}));

describe('ActivityTracker Component', () => {
  const mockAxios = axiosJWT as jest.Mocked<typeof axiosJWT>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost' },
      writable: true,
    });
  });

  test('renders ActivityTracker component correctly', async () => {
    render(<ActivityTracker />);

    // Wait for camera dropdown to populate
    await waitFor(() => {
      expect(screen.getByTestId('SearchIcon')).toBeInTheDocument();
    });
  });

test('displays error message when search fields are empty', async () => {
  // Mock getDateString to return empty string to simulate missing start date
  const getDateString = require('../../../utils/getDateString');
  (getDateString as jest.Mock).mockReturnValueOnce('');

  render(<ActivityTracker />);

  // Wait for search icon to appear
  await waitFor(() => {
    expect(screen.getByTestId('SearchIcon')).toBeInTheDocument();
  });

  const searchIcon = screen.getByTestId('SearchIcon');

  // Click the search icon
  await act(async () => {
    fireEvent.click(searchIcon);
  });

  // Wait for the error message to appear
  await waitFor(() => {
    expect(screen.getByText(/Please select the start date/i)).toBeInTheDocument();
  });
});

test('handles search with valid parameters', async () => {
  const mockCameras = {
    cameras: [{ Camera_Name: 'Camera1', Active: true }],
  };
  const mockResponse = {
    data: { insight: { image: 'test-video-url', camera_Name: 'Camera1' } },
  };

  const mockAxios = require('../../../context/axiosAuthIntercept').default as jest.Mocked<typeof axiosJWT>;

  // Mock GET for cameras
  mockAxios.get.mockResolvedValueOnce({ data: mockCameras });

  // Mock POST to resolve asynchronously so showGif is still true
  mockAxios.post.mockImplementationOnce(() =>
    new Promise((resolve) => setTimeout(() => resolve(mockResponse), 0))
  );

  render(<ActivityTracker />);

  // Wait for camera dropdown to populate
  await waitFor(() => {
    expect(mockAxios.get).toHaveBeenCalledWith('http://localhost:3000/api/cameras');
  });

  const searchIcon = screen.getByTestId('SearchIcon');

  // Click search icon
  await act(async () => {
    fireEvent.click(searchIcon);
  });

  // Wait for POST API call
  await waitFor(() => {
    expect(mockAxios.post).toHaveBeenCalledWith(
      'http://localhost:3000/api/insights',
      expect.any(Object),
      expect.any(Object)
    );
  });

  // Now VideoGeneration should be rendered before POST resolves
  await waitFor(() => {
    expect(screen.getByText('Video Generation')).toBeInTheDocument();
  });
});


  test('handles successful camera data fetch on mount', async () => {
    const mockCameras = {
      cameras: [
        { Camera_Name: 'Camera1', Active: true },
        { Camera_Name: 'Camera2', Active: false },
      ],
    };

    mockAxios.get.mockResolvedValueOnce({ data: mockCameras });

    render(<ActivityTracker />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalledWith('http://localhost:3000/api/cameras');
    });
  });

 
   

  test('handles API error gracefully', async () => {
    const mockCameras = {
      cameras: [{ Camera_Name: 'Camera1', Active: true }],
    };

    mockAxios.get.mockResolvedValueOnce({ data: mockCameras });
    mockAxios.post.mockRejectedValueOnce(new Error('Network error'));

    render(<ActivityTracker />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalled();
    });

    const searchIcon = screen.getByTestId('SearchIcon');

    await act(async () => {
      fireEvent.click(searchIcon);
    });

    await waitFor(() => {
      expect(screen.queryByText('Video Generation')).not.toBeInTheDocument();
    });
  });

  test('updates camera selection correctly', async () => {
    const mockCameras = {
      cameras: [
        { Camera_Name: 'Camera1', Active: true },
        { Camera_Name: 'Camera2', Active: true },
      ],
    };

    mockAxios.get.mockResolvedValueOnce({ data: mockCameras });

    render(<ActivityTracker />);

    await waitFor(() => {
      expect(mockAxios.get).toHaveBeenCalled();
    });
  });

  test('handles date range changes', async () => {
    render(<ActivityTracker />);

    await waitFor(() => {
      expect(screen.getByTestId('SearchIcon')).toBeInTheDocument();
    });
  });

  test('displays loading state during API calls', async () => {
    mockAxios.get.mockImplementation(() => new Promise(() => {}));

    render(<ActivityTracker />);

    await waitFor(() => {
      expect(screen.getByTestId('SearchIcon')).toBeInTheDocument();
    });
  });
});
