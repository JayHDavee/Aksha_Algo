import React from 'react';
import { render } from '@testing-library/react';
import CustomTimePicker from '../../../component/common/CustomTimePicker';
import { Dayjs } from 'dayjs';

const mockOnChange = jest.fn();

describe('CustomTimePicker Component', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CustomTimePicker
        label="Test Time"
        value={null}
        onChange={mockOnChange}
      />
    );
    expect(container).toBeInTheDocument();
  });

  // Additional tests for time change events can be added here
});
