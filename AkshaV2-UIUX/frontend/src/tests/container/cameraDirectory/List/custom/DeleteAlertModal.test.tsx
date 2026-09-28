import React from 'react';
import { render, screen } from '@testing-library/react';
import DeleteAlertModal from '../../../../../container/cameraDirectory/List/custom/DeleteAlertModal';

// Mock envHelper
jest.mock('../../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_DELETE_ALERT: '/api/delete-alert',
    };
    return envs[key] || '';
  }),
}));

describe('DeleteAlertModal Component', () => {
  const mockData = {
    _id: 'alert1',
    Alert_Name: 'Test Alert',
    Camera_Name: 'Camera 1',
  };

  const mockOnRefresh = jest.fn();

  it('renders without crashing', () => {
    render(<DeleteAlertModal data={mockData} camera="Camera 1" onRefresh={mockOnRefresh} />);
    
    // Use aria-label instead of title
    const deleteIcon = screen.getByLabelText('Delete Alert');
    expect(deleteIcon).toBeInTheDocument();
  });
});
