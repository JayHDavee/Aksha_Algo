import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CustomTableBody from '../../../../../component/insights/alertReport/components/CustomTableBody';

// Mock image imports
jest.mock('../../../../../../assets/images/reportIcons/delivery-truck.png', () => 'delivery-truck.png');
jest.mock('../../../../../../assets/images/reportIcons/person.png', () => 'person.png');
jest.mock('../../../../../../assets/images/reportIcons/car.png', () => 'car.png');

describe('CustomTableBody Component', () => {
  const mockData = {
    'Camera 1': {
      alerts: {
        '2024-01-15 10:00:00': {
          timestamp: '2024-01-15T10:00:00.000Z',
          object: 'person',
          link: 'http://example.com/video1',
          my_alert_name: ['Person Detected']
        },
        '2024-01-15 11:00:00': {
          timestamp: '2024-01-15T11:00:00.000Z',
          object: 'car',
          link: 'http://example.com/video2',
          my_alert_name: ['Vehicle Detected']
        }
      }
    },
    'Camera 2': {
      alerts: {}
    }
  };

  const mockShowModal = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders alerts for camera with data', () => {
  render(
    <table>
      <CustomTableBody data={mockData} camName="Camera 1" showModal={mockShowModal} />
    </table>
  );

  // Camera name
  expect(screen.getByText('Camera 1')).toBeInTheDocument();

  // Check date inside any row
  const dateCells = screen.getAllByText(/15th January 2024/i);
  expect(dateCells.length).toBeGreaterThan(0);

  // Check time inside any row using regex
const timeCells = screen.getAllByText(/15:30/i); 
expect(timeCells.length).toBeGreaterThan(0);

// Optionally also check 16:30
const timeCells2 = screen.getAllByText(/16:30/i); 
expect(timeCells2.length).toBeGreaterThan(0);
});


  test('shows "No Alerts Captured" for camera without alerts', () => {
    render(
      <table>
        <CustomTableBody data={mockData} camName="Camera 2" showModal={mockShowModal} />
      </table>
    );

    expect(screen.getByText('Camera 2')).toBeInTheDocument();
    expect(screen.getByText('No Alerts Captured')).toBeInTheDocument();
  });

  test('renders alert icons correctly', () => {
    render(
      <table>
        <CustomTableBody data={mockData} camName="Camera 1" showModal={mockShowModal} />
      </table>
    );

    const images = screen.getAllByRole('img');
    expect(images.length).toBeGreaterThan(0);
  });

  test('handles expand/collapse functionality', () => {
    render(
      <table>
        <CustomTableBody data={mockData} camName="Camera 1" showModal={mockShowModal} />
      </table>
    );

    const expandButtons = screen.getAllByRole('button'); // multiple Carets possible
    expect(expandButtons.length).toBeGreaterThan(0);

    // Click first button to toggle open/close
    fireEvent.click(expandButtons[0]);
  });

  test('calls showModal when first link is clicked', () => {
    render(
      <table>
        <CustomTableBody data={mockData} camName="Camera 1" showModal={mockShowModal} />
      </table>
    );

    const links = screen.getAllByText('https'); // multiple links possible
    fireEvent.click(links[0]);

    expect(mockShowModal).toHaveBeenCalledWith('http://example.com/video1');
  });
});
