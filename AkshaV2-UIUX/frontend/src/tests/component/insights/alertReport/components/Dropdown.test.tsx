import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import Dropdown from '../../../../../component/insights/alertReport/components/Dropdown';

describe('Dropdown Component', () => {
  const mockProps = {
    heading: 'Select Objects',
    active: false,
    options: ['Person', 'Car', 'Truck', 'Bicycle'],
    selectedLabels: [],
    setSelectedLabels: jest.fn(),
    mobile: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders dropdown with heading and default text', () => {
    render(<Dropdown {...mockProps} />);
    
    expect(screen.getByText('Select Objects')).toBeInTheDocument();
    expect(screen.getByText('*')).toBeInTheDocument();
    expect(screen.getByText('select objects')).toBeInTheDocument();
  });

  test('applies active class when active prop is true', () => {
    const { container } = render(<Dropdown {...mockProps} active={true} />);
    expect(container.querySelector('.inner-content')).toHaveClass('activeTab');
  });

  test('toggles dropdown menu when clicked', () => {
    render(<Dropdown {...mockProps} />);
    
    const button = screen.getByText('select objects').parentElement!;
    fireEvent.click(button);

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  test('handles checkbox selection', () => {
    render(<Dropdown {...mockProps} />);
    
    // open menu
    fireEvent.click(screen.getByText('select objects').parentElement!);

    // click wrapper (not checkbox)
    const wrapper = screen.getByText('Person').closest('.form-check')!;
    fireEvent.click(wrapper);

    // setSelectedLabels receives a FUNCTION because of prev => ...
    expect(mockProps.setSelectedLabels).toHaveBeenCalledTimes(1);
    expect(typeof mockProps.setSelectedLabels.mock.calls[0][0]).toBe('function');
  });

  test('handles checkbox deselection', () => {
    const props = {
      ...mockProps,
      selectedLabels: ['Person', 'Car'],
    };

    render(<Dropdown {...props} />);

    // open dropdown
fireEvent.click(screen.getByText(/select objects/i).parentElement!);

    const wrapper = screen.getByText('Person').closest('.form-check')!;
    fireEvent.click(wrapper);

    expect(props.setSelectedLabels).toHaveBeenCalledTimes(1);
    expect(typeof props.setSelectedLabels.mock.calls[0][0]).toBe('function');
  });

  test('displays selected labels inline', () => {
    const props = {
      ...mockProps,
      selectedLabels: ['Person', 'Car'],
    };

    const { container } = render(<Dropdown {...props} />);

    // Check using textContent, not getByText
    expect(container.textContent).toContain('Person,');
    expect(container.textContent).toContain('Car');
  });

  test('handles mobile view correctly', () => {
    render(<Dropdown {...mockProps} mobile={true} />);
    
    expect(screen.queryByText('Select Objects')).not.toBeInTheDocument();
    expect(screen.getByText('select objects')).toBeInTheDocument();
  });

  test('closes dropdown when clicking outside', () => {
    render(<Dropdown {...mockProps} />);

    // open dropdown
    fireEvent.click(screen.getByText('select objects').parentElement!);
    expect(screen.getByRole('list')).toBeInTheDocument();

    // click outside
    fireEvent.click(document.body);

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
