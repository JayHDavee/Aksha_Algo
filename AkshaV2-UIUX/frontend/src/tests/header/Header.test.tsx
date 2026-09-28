jest.mock('../../utils/envHelper', () => ({
  getSecretKey: jest.fn(() => 'mock-secret'),
}));

import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import thunk from 'redux-thunk';
import { BrowserRouter } from 'react-router-dom';


import Header from '../../header/Header';

const middlewares = [thunk];
const mockStore = configureStore(middlewares);

jest.mock('../../header/subComponents/UserManual', () => () => <div>UserManual Mock</div>);
jest.mock('../../header/UserProfileDropDown', () => () => <div>UserProfileDropDown Mock</div>);
jest.mock('../../header/subComponents/MobileMenu', () => (props: any) => (
  <div data-testid="mobile-menu-mock" onClick={() => props.onItemSelect({ pageUrl: '/test' }, 0, true)}>MobileMenu Mock</div>
));
jest.mock('../../header/subComponents/DesktopMenu', () => (props: any) => (
  <div data-testid="desktop-menu-mock" onClick={() => props.onMenuChange({ pageUrl: '/test' }, 0)}>DesktopMenu Mock</div>
));
jest.mock('../../header/subComponents/Settingss', () => (props: any) => (
  <button onClick={props.onSettingsClick}>Settingss Mock</button>
));
jest.mock('../../component/common/customDropDown', () => (props: any) => (
  <div>{props.children}</div>
));

describe('Header Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({
      monitor: { notificationsCount: 0 },
      alertReport: { reportData: {}, alertDate: '' },
    });
    jest.spyOn(store, 'dispatch');
  });

  it('renders logo and menus', () => {
    const { getByAltText, getByTestId, getByText } = render(
      <Provider store={store}>
        <BrowserRouter>
          <Header />
        </BrowserRouter>
      </Provider>
    );

    expect(getByAltText('aksha logo')).toBeInTheDocument();
    expect(getByTestId('mobile-menu-mock')).toBeInTheDocument();
    expect(getByTestId('desktop-menu-mock')).toBeInTheDocument();
    expect(getByText('Settingss Mock')).toBeInTheDocument();
    expect(getByText('UserProfileDropDown Mock')).toBeInTheDocument();
    expect(getByText('UserManual Mock')).toBeInTheDocument();
  });
});
