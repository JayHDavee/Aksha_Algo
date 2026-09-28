import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ForgotPasswordPage from '../../pages/ForgotPassword';

// Mock environment variables
jest.mock('../../utils/envHelper', () => ({
  getEnvVar: jest.fn(() => "test_secret_key"),
  getEnv: jest.fn(() => "test_secret_key"),
}));

describe('ForgotPasswordPage Component', () => {
  it('renders forgot password form', () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>
    );

    // Test MUI text fields using label text
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();

    // Safely target the button
    expect(screen.getByRole('button', { name: /reset password/i }))
      .toBeInTheDocument();
  });
});
