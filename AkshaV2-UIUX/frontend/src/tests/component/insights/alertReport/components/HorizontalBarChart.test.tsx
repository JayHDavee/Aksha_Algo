import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import HorizontalBarChart from '../../../../../component/insights/alertReport/components/HorizontalBarChart';

// Mock react-chartjs-2
jest.mock('react-chartjs-2', () => ({
  Bar: ({ data, options }: any) => (
    <div data-testid="horizontal-bar-chart">
      <div data-testid="chart-data">{JSON.stringify(data)}</div>
      <div data-testid="chart-options">{JSON.stringify(options)}</div>
    </div>
  ),
}));

describe('HorizontalBarChart Component', () => {
  // Corrected mock data
  const mockData = {
    cameras: {
      'Camera 1': {
        object_detection_alerts: { person: 5, car: 3 },
        alerts: { '2024-01-15 10:00:00': {} },
      },
      'Camera 2': {
        object_detection_alerts: { car: 7, truck: 2 },
        alerts: { '2024-01-15 11:00:00': {} },
      },
      'Camera 3': {
        object_detection_alerts: {},
        alerts: {},
      },
    },
  };

  test('renders horizontal bar chart with correct data', () => {
    render(<HorizontalBarChart data={mockData} />);
    
    const chartData = screen.getByTestId('chart-data');
    const data = JSON.parse(chartData.textContent || '{}');
    
    // Highest object per camera
    expect(data.labels).toEqual(['person', 'car']);
    expect(data.datasets[0].data).toEqual([5, 7]);
  });

  test('handles empty data gracefully', () => {
    const emptyData = { cameras: {} };
    render(<HorizontalBarChart data={emptyData} />);
    
    const chartData = screen.getByTestId('chart-data');
    const data = JSON.parse(chartData.textContent || '{}');
    
    expect(data.labels).toEqual([]);
    expect(data.datasets[0].data).toEqual([]);
  });

  test('renders custom legend with camera names', () => {
    render(<HorizontalBarChart data={mockData} />);
    
    // Only cameras with non-empty alerts
    expect(screen.getByText('Camera 1')).toBeInTheDocument();
    expect(screen.getByText('Camera 2')).toBeInTheDocument();
  });

  test('does not include cameras without alerts in legend', () => {
    render(<HorizontalBarChart data={mockData} />);
    
    expect(screen.queryByText('Camera 3')).not.toBeInTheDocument();
  });

  test('applies correct chart options', () => {
    render(<HorizontalBarChart data={mockData} />);
    
    const chartOptions = screen.getByTestId('chart-options');
    const options = JSON.parse(chartOptions.textContent || '{}');
    
    expect(options.indexAxis).toBe('y');
    expect(options.maintainAspectRatio).toBe(false);
    expect(options.plugins.legend.display).toBe(false);
  });

  test('displays chart title', () => {
    render(<HorizontalBarChart data={mockData} />);
    
    expect(screen.getByText('Top Most Alerts')).toBeInTheDocument();
  });
});
