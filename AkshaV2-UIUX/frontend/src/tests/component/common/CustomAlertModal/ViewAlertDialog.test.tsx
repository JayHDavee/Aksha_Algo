import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ViewAlertDialog from '../../../../component/common/CustomAlertModal/ViewAlertDialog';
import '@testing-library/jest-dom';

const sampleData = {
  Alert_Name: 'Test Alert',
  Alert_Description: 'Motion detection in zone 1',
  Alert_Status: 'Active',
  Camera_Name: ['Cam1', 'Cam2'],
  Days_Active: ['Monday', 'Wednesday'],
  Display_Activation: true,
  Email_Activation: false,
  Start_Time: '2023-01-01T10:00:00Z',
  End_Time: '2023-01-01T18:00:00Z',
  Object_Class: 'Person',
  Holiday_Status: true,
  Workday_Status: false,
  Timestamp: '2023-01-01T09:00:00Z',
};

describe('ViewAlertDialog', () => {
  it('renders without crashing when open', () => {
    render(<ViewAlertDialog open={true} onClose={jest.fn()} viewData={sampleData} />);
    expect(screen.getByText(/Alert Details/i)).toBeInTheDocument();
    expect(screen.getByText(/Test Alert/i)).toBeInTheDocument();
  });

  it('displays "---" for missing values', () => {
    const partialData = {
      Alert_Name: 'Partial Alert',
      Camera_Name: 'Str2'
    };
    render(<ViewAlertDialog open={true} onClose={jest.fn()} viewData={partialData} />);
    expect(screen.getByText(/Alert Name: Partial Alert/i)).toBeInTheDocument();
    expect(screen.getByText(/Alert Description: ---/i)).toBeInTheDocument();
  });

  it('renders "No data available" if viewData is undefined', () => {
    render(<ViewAlertDialog open={true} onClose={jest.fn()} />);
    expect(screen.getByText(/No data available/i)).toBeInTheDocument();
  });

  it('calls onClose when OK button is clicked', () => {
    const handleClose = jest.fn();
    render(<ViewAlertDialog open={true} onClose={handleClose} viewData={sampleData} />);
    fireEvent.click(screen.getByText(/OK/i));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('does not render dialog when open is false', () => {
    const { queryByText } = render(
      <ViewAlertDialog open={false} onClose={jest.fn()} viewData={sampleData} />
    );
    expect(queryByText(/Alert Details/i)).not.toBeInTheDocument();
  });
});
