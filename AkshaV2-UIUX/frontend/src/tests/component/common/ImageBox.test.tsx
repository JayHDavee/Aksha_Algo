import React from 'react';
import { render } from '@testing-library/react';
import ImageBox from '../../../component/common/ImageBox';

const mockData = {
  base_url: 'http://example.com/image.jpg',
  Results: '0,0 100,0 100,100 0,100',
};

const mockAIPolygon = '50,50 150,50 150,150 50,150';

describe('ImageBox Component', () => {
  it('renders without crashing', () => {
    const { getByAltText } = render(
      <ImageBox data={mockData} aIPolygen={mockAIPolygon} />
    );
    expect(getByAltText('Canvas Frames For Alert')).toBeInTheDocument();
  });
});
