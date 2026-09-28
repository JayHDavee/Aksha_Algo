import React from 'react';
import { render } from '@testing-library/react';
import CustomDatePicker from '../../../component/common/CustomDatePicker';

const mockDates = [
  {
    startDate: new Date(2023, 0, 1),
    endDate: new Date(2023, 0, 10),
    key: 'selection',
  },
];

const mockOnDateChange = jest.fn();

describe('CustomDatePicker Component', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CustomDatePicker
        dates={mockDates}
        onDateChange={mockOnDateChange}
        index={0}
      />
    );
    expect(container).toBeInTheDocument();
  });

  // Additional tests for date selection and callbacks can be added here
});
