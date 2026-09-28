import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CustomTable from '../../../../../component/insights/alertReport/components/CustomTable';
import { ReportData } from '../../../../../component/insights/alertReport/types';

describe('CustomTable Component', () => {
  // Updated mock data structure to include `cameras` key
  const mockData: ReportData = {
    cameras: {
      'Camera 1': {
        total_alerts_generated: 5,
        alerts: {
          '2024-01-15 10:00:00': {
            timestamp: '2024-01-15 10:00:00',
            object: 'person',
            link: 'http://example.com/video1',
            my_alert_name: ['Person Detected']
          },
          '2024-01-15 11:00:00': {
            timestamp: '2024-01-15 11:00:00',
            object: 'car',
            link: 'http://example.com/video2',
            my_alert_name: ['Vehicle Detected']
          }
        },
        object_detection_alerts: {
          person: 3,
          car: 2
        },
        most_active_hour_for_each_object: {},
        peak_alert_time_hour: "12"
      },
      'Camera 2': {
        total_alerts_generated: 3,
        alerts: {
          '2024-01-15 12:00:00': {
            timestamp: '2024-01-15 12:00:00',
            object: 'truck',
            link: 'http://example.com/video3',
            my_alert_name: ['Truck Detected']
          }
        },
        object_detection_alerts: {
          truck: 3
        },
        most_active_hour_for_each_object: {},
        peak_alert_time_hour: "14"
      }
    }
  };

  const mockShowModal = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders table headers correctly', () => {
    render(<CustomTable data={mockData} showModal={mockShowModal} />);
    
    expect(screen.getByText('CAMERA')).toBeInTheDocument();
    expect(screen.getByText('DATE')).toBeInTheDocument();
    expect(screen.getByText('TIME')).toBeInTheDocument();
    expect(screen.getByText('ALERT')).toBeInTheDocument();
    expect(screen.getByText('LINK')).toBeInTheDocument();
  });

  test('renders camera names from data', () => {
    render(<CustomTable data={mockData} showModal={mockShowModal} />);
    
    expect(screen.getByText('Camera 1')).toBeInTheDocument();
    expect(screen.getByText('Camera 2')).toBeInTheDocument();
  });

  test('handles empty data gracefully', () => {
    // Updated empty data to include empty cameras object
    const emptyData: ReportData = { cameras: {} };
    render(<CustomTable data={emptyData} showModal={mockShowModal} />);
    
    expect(screen.queryByText('Camera 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Camera 2')).not.toBeInTheDocument();
  });
});
