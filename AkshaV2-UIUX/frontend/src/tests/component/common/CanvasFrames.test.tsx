import React from 'react';
import { render } from '@testing-library/react';
import CanvasFrames from '../../../component/common/CanvasFrames';

describe('CanvasFrames Component', () => {
  it('renders without crashing', () => {
    const { container } = render(<CanvasFrames data={{
        base_url: '',
        Results: ''
    }} aIPolygen={''} />);
    expect(container).toBeInTheDocument();
  });

  // Additional tests for CanvasFrames functionality can be added here
});
