import React from 'react';
import { render,screen} from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import { BrowserRouter } from 'react-router-dom';
import Login from '../../pages/Login';
import { AuthProvider } from '../../context/AuthContext'; // <-- import your provider

const mockStore = configureStore([]);

jest.mock('../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const mockEnv: Record<string, string> = {
      VITE_BASE_URL: 'http://localhost:3000',
      VITE_LOGIN_API: '/api/login',
    };
    return mockEnv[key];
  }
}));

describe('Login Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({});
  });

  it('renders login form', () => {
    const { getByPlaceholderText, getByText } = render(
      <Provider store={store}>
        <BrowserRouter>
          <AuthProvider>
            <Login />
          </AuthProvider>
        </BrowserRouter>
      </Provider>
    );

   expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    // Look for the sign in button
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
