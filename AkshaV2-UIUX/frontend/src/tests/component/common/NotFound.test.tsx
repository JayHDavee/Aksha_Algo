import React from 'react';
import { render } from '@testing-library/react';
import NotFound from '../../../component/common/NotFound';

describe('NotFound Component', () => {
  it('renders without crashing', () => {
    const { getByAltText, getByText } = render(<NotFound />);
    expect(getByAltText('error img')).toBeInTheDocument();
    expect(getByText('No alerts found')).toBeInTheDocument();
  });
});
