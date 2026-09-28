import React from 'react';
import { render } from '@testing-library/react';
import NoDataFound from '../../../../container/cameraDirectory/NoDataFound/NoDataFound';

describe('NoDataFound Component', () => {
  it('renders default message when no pageType is provided', () => {
    const { getByText } = render(<NoDataFound />);
    expect(getByText('Oops! No alerts added')).toBeInTheDocument();
    expect(getByText('Alerts created for cameras will appear here')).toBeInTheDocument();
  });

  it('renders alternate message when pageType is provided', () => {
    const { getByText } = render(<NoDataFound pageType="someType" />);
    expect(getByText('You can add alerts after saving the camera')).toBeInTheDocument();
  });
});
