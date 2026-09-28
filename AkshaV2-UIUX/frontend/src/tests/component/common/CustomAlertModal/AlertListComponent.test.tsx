import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AlertListComponent, { AlertListComponentProps } from '../../../../component/common/CustomAlertModal/AlertListComponent';
import '@testing-library/jest-dom';

jest.mock('../../../../container/cameraDirectory/NoDataFound/NoDataFound', () => () => (
  <div>No Data Found</div>
));

jest.mock('../../../../container/cameraDirectory/List/custom/DeleteAlertModal', () => () => (
  <div data-testid="delete-modal">Delete Alert Modal</div>
));

const mockAlert = {
  _id: 'alert-1',
  Alert_Name: 'Test Alert',
  Camera_Name: 'Camera1',
  Email_Activation: true,
  Display_Activation: false,
};

const defaultProps: AlertListComponentProps = {
  pageType: '',
  screenType: 'edit',
  style: {},
  alertlist: [mockAlert],
  tableloader: false,
  noAvailableStatus: false,
  props_camera: 'camera-id',
  setMessage: jest.fn(),
  setOpen: jest.fn(),
  setWarning: jest.fn(),
  onChangeSingleEmailAlerts: jest.fn(),
  onChangeSingleDisplayAlerts: jest.fn(),
  showeditmodal: jest.fn(),
  showviewdetailsmodal: jest.fn(),
  getalertlist: jest.fn(),
  handleShow: jest.fn(),
};

describe('AlertListComponent', () => {

  it('renders table with alert rows', () => {
    render(<AlertListComponent {...defaultProps} />);

    expect(screen.getByText('Test Alert')).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(2);

    expect(screen.getByTestId('delete-modal')).toBeInTheDocument();
  });

  it('calls showeditmodal when edit icon is clicked', () => {
    render(<AlertListComponent {...defaultProps} />);

    const editIcon = screen.getByLabelText('Edit Alert');
    fireEvent.click(editIcon.closest('a')!);

    expect(defaultProps.showeditmodal).toHaveBeenCalledWith(mockAlert);
  });

  it('calls showviewdetailsmodal when view icon is clicked', () => {
    render(<AlertListComponent {...defaultProps} />);

    const viewIcon = screen.getByLabelText('View Alert');
    fireEvent.click(viewIcon.closest('a')!);

    expect(defaultProps.showviewdetailsmodal).toHaveBeenCalledWith(mockAlert);
  });

it('calls handleShow when Add Alert button is clicked', () => {
  render(<AlertListComponent {...defaultProps} pageType="add" />);

  const addBtn = screen.getByRole('button', { name: /add alert/i });
  fireEvent.click(addBtn);

  expect(defaultProps.handleShow).toHaveBeenCalled();
});

 it('disables checkboxes in view mode', () => {
  render(<AlertListComponent {...defaultProps} pageType="view" />);

  const checkboxes = screen.getAllByRole('checkbox');
  checkboxes.forEach(cb => {
    expect(cb).toBeDisabled();
  });
});


  it('shows CircularProgress when tableloader is true', () => {
    render(<AlertListComponent {...defaultProps} tableloader={true} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders NoDataFound when empty and noAvailableStatus is true', () => {
    render(<AlertListComponent {...defaultProps} alertlist={[]} noAvailableStatus={true} />);
    expect(screen.getByText('No Data Found')).toBeInTheDocument();
  });

  it('renders Loading.. when empty and noAvailableStatus is false', () => {
    render(<AlertListComponent {...defaultProps} alertlist={[]} noAvailableStatus={false} />);
    expect(screen.getByText('Loading..')).toBeInTheDocument();
  });

  it('calls onChangeSingleEmailAlerts when email checkbox toggled', () => {
    render(<AlertListComponent {...defaultProps} />);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    expect(defaultProps.onChangeSingleEmailAlerts).toHaveBeenCalledWith(mockAlert);
  });

  it('calls onChangeSingleDisplayAlerts when display checkbox toggled', () => {
    render(<AlertListComponent {...defaultProps} />);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    expect(defaultProps.onChangeSingleDisplayAlerts).toHaveBeenCalledWith(mockAlert);
  });
});
