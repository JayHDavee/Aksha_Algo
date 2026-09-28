import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdminLogin from '../../header/AdminLogin';

// ✅ Mock envHelper
jest.mock('../../utils/envHelper', () => ({
  getEnvVar: jest.fn(() => 'https://mocked-login-endpoint'),
}));

// ✅ Mock Ant Design message
jest.mock('antd', () => ({
  message: {
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

// ✅ Mock useApi hook
jest.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    callApi: jest.fn(async () => ({
      status: 200,
      data: {
        message: 'Authentication Successful!',
        Client: 'TestClient',
        Email: 'admin@test.com',
      },
    })),
  }),
}));

describe('AdminLogin Component', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('renders Admin Login link', () => {
    const { getByText } = render(<AdminLogin />);
    expect(getByText('Admin Login')).toBeInTheDocument();
  });

  it('opens modal on link click', () => {
    const { getByText, getByPlaceholderText } = render(<AdminLogin />);
    fireEvent.click(getByText('Admin Login'));
    expect(getByPlaceholderText('Username')).toBeInTheDocument();
  });

  it('shows warning if username missing', async () => {
    const { getByText } = render(<AdminLogin />);
    fireEvent.click(getByText('Admin Login'));
    fireEvent.click(getByText('Login'));

    await waitFor(() => {
      expect(require('antd').message.warning).toHaveBeenCalledWith('Username is required.');
    });
  });

  it('shows warning if password missing', async () => {
    const { getByText, getByPlaceholderText } = render(<AdminLogin />);
    fireEvent.click(getByText('Admin Login'));
    fireEvent.change(getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.click(getByText('Login'));

    await waitFor(() => {
      expect(require('antd').message.warning).toHaveBeenCalledWith('Password is required.');
    });
  });

  it('logs in successfully with valid credentials', async () => {
    const { getByText, getByPlaceholderText } = render(<AdminLogin />);
    fireEvent.click(getByText('Admin Login'));
    fireEvent.change(getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.change(getByPlaceholderText('Password'), { target: { value: '1234' } });
    fireEvent.click(getByText('Login'));

    await waitFor(() => {
      expect(require('antd').message.success).toHaveBeenCalledWith('Authentication Successful!');
      expect(localStorage.getItem('isLoggedIn')).toBe('true');
    });
  });
});
