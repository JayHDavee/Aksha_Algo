import React from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DatePickerPopover from '../../../component/common/DatePickerPopover';

const mockProps = {
  heading: 'Date*',
  text: '2023-01-01 to 2023-01-10',
  active: true,
  index: 0,
  dates: [
    { startDate: new Date(2023, 0, 1), endDate: new Date(2023, 0, 10), key: 'selection' },
  ],
  onChangeActiveCss: jest.fn(),
  onDateChange: jest.fn(),
  mobile: false,
  minDate: new Date(2022, 11, 20),
  maxDate: new Date(2023, 0, 31),
  months: 2,
  showPreview: true,
};

describe('DatePickerPopover Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(<DatePickerPopover {...mockProps} />);
    expect(getByText('Date')).toBeInTheDocument();
    expect(getByText(mockProps.text)).toBeInTheDocument();
  });

  it('calls onChangeActiveCss on click', async () => {
    const { getByText } = render(<DatePickerPopover {...mockProps} />);
    await userEvent.click(getByText(mockProps.text));
    expect(mockProps.onChangeActiveCss).toHaveBeenCalledWith(mockProps.index);
  });
});
