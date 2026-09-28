import React from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TimePickerPopover from '../../../component/common/TimePickerPopover';

const mockProps = {
  heading: 'Time*',
  text: '07 - 19',
  active: true,
  index: 0,
  mobile: false,
  starTime: '07:00',
  endTime: '19:00',
  setStartTime: jest.fn(),
  setEndTime: jest.fn(),
  onChangeActiveCss: jest.fn(),
};

describe('TimePickerPopover Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(<TimePickerPopover {...mockProps} />);
    expect(getByText('Time')).toBeInTheDocument();
    expect(getByText(mockProps.text)).toBeInTheDocument();
  });

  it('calls onChangeActiveCss on click', async () => {
    const { getByText } = render(<TimePickerPopover {...mockProps} />);
    await userEvent.click(getByText(mockProps.text));
    expect(mockProps.onChangeActiveCss).toHaveBeenCalledWith(mockProps.index);
  });
});
