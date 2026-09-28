import React from 'react';
import { render } from '@testing-library/react';
import CanvasFramesAuto from '../../../component/common/CanvasFramesAuto';

const mockData = {
  base_url: 'http://example.com/image.jpg',
  Results: '0,0 100,0 100,100 0,100',
};

const mockAIPolygen = '10,10 90,10 90,90 10,90';

describe('CanvasFramesAuto Component', () => {
  it('renders without crashing', () => {
    const { getByAltText } = render(
      <CanvasFramesAuto data={mockData} aIPolygen={mockAIPolygen} />
    );
    expect(getByAltText('Canvas Frames Auto')).toBeInTheDocument();
  });

  // Additional tests for SVG rendering and encoding can be added here
});
