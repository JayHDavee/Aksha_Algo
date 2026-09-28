import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DoughnutChart from '../../../../../component/insights/alertReport/components/DoughnutChart';

// Mock react-chartjs-2
jest.mock('react-chartjs-2', () => ({
  Doughnut: ({ data, options }: any) => (
    <div data-testid="doughnut-chart">
      <div data-testid="chart-data">{JSON.stringify(data)}</div>
      <div data-testid="chart-options">{JSON.stringify(options)}</div>
    </div>
  ),
}));

describe('DoughnutChart Component', () => {
  const mockData = {
    'Camera 1': {
      total_alerts_generated: 5,
      alerts: {},
      object_detection_alerts: {},
      most_active_hour_for_each_object: {},
      peak_alert_time_hour: 12
    },
    'Camera 2': {
      total_alerts_generated: 3,
      alerts: {},
      object_detection_alerts: {},
      most_active_hour_for_each_object: {},
      peak_alert_time_hour: 14
    },
    'Camera 3': {
      total_alerts_generated: 8,
      alerts: {},
      object_detection_alerts: {},
      most_active_hour_for_each_object: {},
      peak_alert_time_hour: 10
    }
  };

  test('renders doughnut chart with correct data', () => {
    render(<DoughnutChart data={mockData} />);
    
    const chartData = screen.getByTestId('chart-data');
    const data = JSON.parse(chartData.textContent || '{}');
    
    expect(data.labels).toEqual(['Camera 1', 'Camera 2', 'Camera 3']);
    expect(data.datasets[0].data).toEqual([5, 3, 8]);
  });

  test('handles empty data', () => {
    const emptyData = {};
    render(<DoughnutChart data={emptyData} />);
    
    const chartData = screen.getByTestId('chart-data');
    const data = JSON.parse(chartData.textContent || '{}');
    
    expect(data.labels).toEqual([]);
    expect(data.datasets[0].data).toEqual([]);
  });

  test('applies correct chart options', () => {
    render(<DoughnutChart data={mockData} />);
    
    const chartOptions = screen.getByTestId('chart-options');
    const options = JSON.parse(chartOptions.textContent || '{}');
    
    expect(options.maintainAspectRatio).toBe(false);
    expect(options.plugins.legend.display).toBe(true);
    expect(options.plugins.legend.position).toBe('bottom');
  });
});
