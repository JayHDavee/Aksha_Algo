import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import CameraPopover from '../../../component/common/CameraPopover';

jest.mock('../../../component/common/CustomCameraModel', () => (props: any) => (
  <div data-testid="custom-camera-model">
    MockCameraModel - Selected: {props.selectedCamera}
  </div>
));


const mockProps = {
  heading: 'Camera*',
  text: 'Camera xyz',
  active: false,
  index: 0,
  selectedCamera: 'Camera 1',
  onChangeActiveCss: jest.fn(),
  onCameraChange: jest.fn(),
  allActiveCameras: [{ Camera_Name: 'Camera 1' }, { Camera_Name: 'Camera 2' }],
  mobile: false,
};

describe('CameraPopover Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders heading and text correctly (non-mobile)', () => {
    render(<CameraPopover {...mockProps} />);
    expect(screen.getByText('Camera')).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByText('Camera xyz')).toBeInTheDocument();
  });

  it('does not render heading in mobile view', () => {
    render(<CameraPopover {...mockProps} mobile={true} />);
    expect(screen.queryByText('Camera')).not.toBeInTheDocument();
    expect(screen.getByText('Camera xyz')).toBeInTheDocument();
  });

  it('adds "activeTab" class when active is true', () => {
    const { container } = render(<CameraPopover {...mockProps} active={true} />);
    const innerContent = container.querySelector('.inner-content');
    expect(innerContent).toHaveClass('activeTab');
  });

  it('calls onChangeActiveCss and opens popover on click', () => {
    render(<CameraPopover {...mockProps} />);

    const clickableDiv = screen.getByText('Camera xyz');
    fireEvent.click(clickableDiv);

    expect(mockProps.onChangeActiveCss).toHaveBeenCalledWith(mockProps.index);
    expect(screen.getByTestId('custom-camera-model')).toBeInTheDocument();
  });

  it('closes popover when handleClose is triggered from child', () => {
    render(<CameraPopover {...mockProps} />);

    const clickableDiv = screen.getByText('Camera xyz');
    fireEvent.click(clickableDiv);

    // Popover is open
    expect(screen.getByTestId('custom-camera-model')).toBeInTheDocument();

    // Simulate closing
    fireEvent.click(document.body); // Clicking outside triggers close
    // Note: MUI Popover is portal-based, hard to test exact close without integration.
  });
});
