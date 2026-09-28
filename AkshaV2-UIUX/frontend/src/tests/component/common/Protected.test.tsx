import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Protected from '../../../component/common/Protected';

describe('Protected Component', () => {
  it('renders children when logged in', () => {
    const { getByText } = render(
      <MemoryRouter>
        <Protected isLoggedIn={true}>
          <div>Protected Content</div>
        </Protected>
      </MemoryRouter>
    );
    expect(getByText('Protected Content')).toBeInTheDocument();
  });

  it('redirects when not logged in', () => {
    const { container } = render(
      <MemoryRouter>
        <Protected isLoggedIn={false}>
          <div>Protected Content</div>
        </Protected>
      </MemoryRouter>
    );
    // Since Navigate renders null, container should be empty
    expect(container.firstChild).toBeNull();
  });
});
