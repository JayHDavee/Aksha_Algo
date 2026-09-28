import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import UserProfileDropDown from '../../header/UserProfileDropDown';

jest.mock('../../utils/envHelper', () => ({
  getEnvVar: jest.fn(() => 'http://localhost'),
}));

// ⭐ Mock useAuth() so AuthProvider is NOT required
jest.mock('../../context/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    user: { name: 'Admin User', role: 'admin', email: 'admin@gmail.com' },
    logout: jest.fn(),
  }),
}));

const mockStore = configureStore([]);

jest.mock('../../component/common/CustomDropdown', () => (props: any) => (
  <div>{props.children}</div>
));

describe('UserProfileDropDown Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({
      auth: { role: 'admin' },
    });
    store.dispatch = jest.fn();
  });

  it('renders user profile dropdown when logged in as admin', () => {
    localStorage.setItem('isLoggedIn', 'true');

    const { getByAltText } = render(
      <Provider store={store}>
        <UserProfileDropDown />
      </Provider>
    );

    expect(getByAltText('avatar')).toBeInTheDocument();
  });

  it('does not render menu items when not logged in or not admin', () => {
    localStorage.removeItem('isLoggedIn');

    // 👇 Mock useAuth() for non-admin case
    jest.mock('../../context/AuthContext', () => ({
      __esModule: true,
      useAuth: () => ({
        user: { name: 'Normal User', role: 'user' },
        logout: jest.fn(),
      }),
    }));

    store = mockStore({
      auth: { role: 'user' },
    });

    const { queryByText } = render(
      <Provider store={store}>
        <UserProfileDropDown />
      </Provider>
    );

    expect(queryByText('User Details')).not.toBeInTheDocument();
    expect(queryByText('Logout')).not.toBeInTheDocument();
  });
});
