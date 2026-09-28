import React from 'react';
import { render } from '@testing-library/react';
import NotFoundVideo from '../../../component/common/NotFoundVideo';

describe('NotFoundVideo Component', () => {
  it('renders without crashing', () => {
    const { getByAltText, getByText } = render(<NotFoundVideo />);
    expect(getByAltText('not found')).toBeInTheDocument();
    expect(getByText('No frames found')).toBeInTheDocument();
  });
});
