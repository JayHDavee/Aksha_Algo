import React from 'react';
import { render } from '@testing-library/react';
import Messagebox from '../../../component/common/Messagebox';

const mockHandleClose = jest.fn();

describe('Messagebox Component', () => {
  it('renders without crashing with warning', () => {
    const { getByText } = render(
      <Messagebox open={true} handleClose={mockHandleClose} message="Warning message" warning={true} />
    );
    expect(getByText('Warning message')).toBeInTheDocument();
  });

  it('renders without crashing without warning', () => {
    const { getByText } = render(
      <Messagebox open={true} handleClose={mockHandleClose} message="Success message" warning={false} />
    );
    expect(getByText('Success message')).toBeInTheDocument();
  });
});
