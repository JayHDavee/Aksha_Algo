import React from 'react';
import { render } from '@testing-library/react';
import Login from '../../../container/login/Login';
import { MemoryRouter } from 'react-router-dom';
jest.mock('react-redux', () => {
  const dispatchMock = jest.fn();
  return {
    useDispatch: () => dispatchMock,
    useSelector: jest.fn(),
    __esModule: true,
    getDispatchMock: () => dispatchMock, // expose for tests
  };
});

jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_DELETE_ALERT: '/api/delete-alert',
    };
    return envs[key] || '';
  }),
}));

describe('Login Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );
    expect(getByText(/Welcome back/i)).toBeInTheDocument();
  });

  // Additional tests for input changes, form submission, and password visibility toggling can be added here
});
