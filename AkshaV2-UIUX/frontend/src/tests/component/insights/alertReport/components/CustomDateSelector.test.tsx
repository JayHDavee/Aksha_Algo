import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import CustomDateSelector from '../../../../../component/insights/alertReport/components/CustomDateSelector';
import dayjs from 'dayjs';

describe('CustomDateSelector Component', () => {
  const mockProps = {
    heading: 'Select Date*',
    text: 'Choose date',
    active: false,
    index: 0,
    onChangeActiveCss: jest.fn(),
    mobile: false,
    value: dayjs('2024-01-15'),
    onChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders component with correct props', () => {
    render(<CustomDateSelector {...mockProps} />);

    expect(screen.getByText('Select Date')).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByText('Choose date')).toBeInTheDocument();
  });

  test('applies active class when active prop is true', () => {
    const { container } = render(<CustomDateSelector {...mockProps} active={true} />);
    const innerContent = container.querySelector('.inner-content');
    expect(innerContent).toHaveClass('activeTab');
  });

  test('opens popover when clicked', async () => {
    render(<CustomDateSelector {...mockProps} />);

    // Click the container that opens popover
    const clickableDiv = screen.getByText('Choose date').parentElement!;
    fireEvent.click(clickableDiv);

    // Wait for popover to appear in the document body
    await waitFor(() => {
      const popover = document.body.querySelector('.MuiPopover-paper');
      expect(popover).toBeInTheDocument();
    });

    // Optional: Check that the StaticDatePicker is inside the popover
    const monthLabel = screen.getByText('January 2024'); // Adjust based on your date
    expect(monthLabel).toBeInTheDocument();
  });

  test('calls onChangeActiveCss when clicked', () => {
    render(<CustomDateSelector {...mockProps} />);

    const clickableDiv = screen.getByText('Choose date').parentElement!;
    fireEvent.click(clickableDiv);

    expect(mockProps.onChangeActiveCss).toHaveBeenCalledWith(0);
  });

  test('handles mobile view correctly', () => {
    render(<CustomDateSelector {...mockProps} mobile={true} />);

    // Heading should not render in mobile
    expect(screen.queryByText('Select Date')).not.toBeInTheDocument();
    expect(screen.getByText('Choose date')).toBeInTheDocument();
  });
});

