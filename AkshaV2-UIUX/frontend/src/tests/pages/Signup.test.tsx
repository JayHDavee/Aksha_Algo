import React from 'react';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock dependencies that cause runtime issues
jest.mock('../../hooks/useApi', () => ({
  useApi: () => ({ callApi: jest.fn() }),
}));

jest.mock('../../utils/axiosInstance', () => ({
  post: jest.fn(),
}));

jest.mock('../../assets/images/AkshaLogo.png', () => 'mock-logo.png');

jest.mock('../../utils/envHelper', () => ({
  getSecretKey: () => 'mock-secret-key',
}));


import Signup from '../../pages/Signup';

describe('Signup Component', () => {
  it('renders signup form fields correctly', () => {
    render(
      <BrowserRouter>
        <Signup />
      </BrowserRouter>
    );

    // Check presence of form elements
    expect(screen.getByLabelText('First Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Company Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Account Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();

    // Check presence of the main button
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });
});
