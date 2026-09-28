import React from 'react';
import { render } from '@testing-library/react';
import CustomizedSnackbars from '../../../component/common/CustomizedSnackbars';

describe('CustomizedSnackbars Component', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <CustomizedSnackbars show={true} message="Test message" indicator="success" />
    );
    expect(container).toBeInTheDocument();
  });

  // Additional tests for snackbar visibility and message can be added here
});
