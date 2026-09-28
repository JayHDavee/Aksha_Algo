import React from 'react';
import { render } from '@testing-library/react';
import CustomCameraModel from '../../../component/common/CustomCameraModel';

const mockProps = {
  index: 0,
  close: jest.fn(),
  selectedCamera: 'Camera 1',
  onCameraChange: jest.fn(),
  allActiveCameras: [{ Camera_Name: 'Camera 1' }, { Camera_Name: 'Camera 2' }],
};

describe('CustomCameraModel Component', () => {
  it('renders list of cameras', () => {
    const { getByText } = render(<CustomCameraModel {...mockProps} />);
    expect(getByText('Camera 1')).toBeInTheDocument();
    expect(getByText('Camera 2')).toBeInTheDocument();
  });

  // Additional tests for click events can be added here
});
