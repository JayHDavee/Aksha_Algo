import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AlertConfigurationModal from "../../../../component/common/CustomAlertModal/AlertConfigurationModal";
import '@testing-library/jest-dom';

// Mock react-konva to avoid requiring canvas in Jest
jest.mock('react-konva', () => ({
  Stage: () => <div>MockStage</div>,
  Layer: () => <div>MockLayer</div>,
  Line: () => <div>MockLine</div>,
  Rect: () => <div>MockRect</div>,
}));

const defaultProps = {
  modalStatus: true,
  handleClose: jest.fn(),
  calledInsideMenu: false,
  modalopened: 'add',
  submittype: 'add',
  alert_name: 'Test Alert',
  alert_description: 'Testing alert description',
  selectedCamera: 'Camera1',

  cameralist: [{ Camera_Name: 'Camera1' }],
  selectedObjectofInter: 'person',
  listofobjectlabels: ['person', 'vehicle'],
  No_Object_Status: false,
  working_day: true,
  holiday: false,
  weeks: [
    { id: 1, name: 'Mon', selected: true },
    { id: 2, name: 'Tue', selected: false },
  ],
  start_time: '10:00',
  end_time: '18:00',
  isMobileDevice: false,
  add_camera_img: [],
  viewdata: { Camera_Name: 'Camera1' },
  viewimagedata: {},
  listOfCamera: [],
  camera_img: null,
  aipollygon: '',
  editImageAOI: false,
  isClose: false,
  hangleEditImageAOI: jest.fn(),
  handleChangeStartTime: jest.fn(),
  handleChangeEndTime: jest.fn(),
  handleAlertName: jest.fn(),
  handleAlertDescription: jest.fn(),
  handleChangeCamera: jest.fn(),
  handleSelectAllCameras: jest.fn(),
  handleChangeObjectofInter: jest.fn(),
  handleObjectCheckChange: jest.fn(),
  handleChangeFrequency: jest.fn(),
  handleChangeWeek: jest.fn(),
  setAIPolygen: jest.fn(),
  showstep0: jest.fn(),
  showstep1: jest.fn(),
  showstep2: jest.fn(),
  submit_button: jest.fn(),
  activeStep: 0,
  selectedFrequency: 'Daily',
};

describe('AlertConfigurationModal Component', () => {
  test('renders modal when modalStatus is true', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    // Fixed: Allow multiple "Alert Details" matches
    expect(screen.getAllByText(/Alert Details/i).length).toBeGreaterThan(0);
  });

  test('shows alert name and description input', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Eg. Vehicle entry/i)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Alert on vehicle entry in premises/i)
    ).toBeInTheDocument();
  });

  test('calls handleAlertName when alert name is changed', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    const input = screen.getByPlaceholderText(/Eg. Vehicle entry/i);
    fireEvent.change(input, { target: { value: 'Updated Name' } });
    expect(defaultProps.handleAlertName).toHaveBeenCalled();
  });

  test('renders object of interest select with correct options', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    const select = screen.getByDisplayValue('person');
    expect(select).toBeInTheDocument();
    expect(screen.getByText('vehicle')).toBeInTheDocument();
  });

  test('renders "No Person Alert" checkbox if selectedObjectofInter is person', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    expect(screen.getByText(/No Person Alert/i)).toBeInTheDocument();
  });

 test('calls handleObjectCheckChange when No Person checkbox is clicked', () => {
  render(<AlertConfigurationModal {...defaultProps} />);

  // Find all checkbox inputs
  const checkboxes = screen.getAllByRole('checkbox');
  // Pick the one closest to "No Person Alert"
  const checkbox = checkboxes.find(cb =>
    cb.parentElement?.textContent?.match(/No Person Alert/i)
  );

  expect(checkbox).toBeDefined();
  if (checkbox) {
    fireEvent.click(checkbox);
    expect(defaultProps.handleObjectCheckChange).toHaveBeenCalled();
  }
});



  test('calls handleClose on CancelRounded click', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelBtn);
    expect(defaultProps.handleClose).toHaveBeenCalled();
  });

  test('renders camera dropdown options from cameralist', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    expect(screen.getByText('Camera1')).toBeInTheDocument();
  });

  test('shows Save & Continue button on step 0', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    const saveBtn = screen.getByRole('button', { name: /Save & Continue/i });
    expect(saveBtn).toBeInTheDocument();
  });

  test('step navigation: calls showstep1 when clicking next', () => {
    render(<AlertConfigurationModal {...defaultProps} />);
    const nextBtn = screen.getByRole('button', { name: /Save & Continue/i });
    fireEvent.click(nextBtn);
    expect(defaultProps.showstep1).toHaveBeenCalled();
  });
});
