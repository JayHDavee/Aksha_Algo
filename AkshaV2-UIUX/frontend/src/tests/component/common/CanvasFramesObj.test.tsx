import React from 'react';
import { render } from '@testing-library/react';
import CanvasFramesObj from '../../../component/common/CanvasFramesObj';

// Mock scrollTo because JSDOM doesn't support it
window.HTMLElement.prototype.scrollTo = jest.fn();

jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_DELETE_ALERT: '/api/delete-alert',
    };
    return envs[key] || '';
  }),
}));

const mockData = {
  base_url: 'http://example.com/image.jpg',
  Results: [
    { x: [0, 10], y: [10, 20], w: [20, 30], h: [30, 40], label: 'object1' },
  ],
};

const mockAIPolygen = '10,10 90,10 90,90 10,90';

describe('CanvasFramesObj Component', () => {
  it('renders without crashing', () => {
    const { getByAltText } = render(
      <CanvasFramesObj data={mockData} aIPolygen={mockAIPolygen} />
    );
    expect(getByAltText('Canvas Frames Object')).toBeInTheDocument();
  });

  // Additional tests for modal open can be added here
});
