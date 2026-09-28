import React from 'react';
import { render } from '@testing-library/react';
import VideoGeneration from '../../../component/common/VideoGeneration';

describe('VideoGeneration Component', () => {
  it('renders without crashing', () => {
    const { getByAltText, getByText } = render(<VideoGeneration />);
    expect(getByAltText('not found')).toBeInTheDocument();
    expect(getByText('Video is being generated')).toBeInTheDocument();
  });
});
