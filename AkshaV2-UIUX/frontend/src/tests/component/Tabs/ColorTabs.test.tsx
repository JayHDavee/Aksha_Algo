import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import ColorTabs from '../../../component/Tabs/ColorTabs';

// Mock Redux store
const mockStore = configureStore([]);
let store: any;

// Mock axiosJWT
jest.mock('../../../context/axiosAuthIntercept', () => ({
  get: jest.fn(() => Promise.resolve({})),
}));

// Mock envHelper
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const envMap: Record<string, string> = {
      VITE_BASE_URL: 'http://localhost:3000',
      VITE_CHECK_FOR_WORKING_DAY: '/checkWorkingDay',
    };
    return envMap[key] || '';
  },
}));

describe('ColorTabs Component', () => {
  beforeEach(() => {
    store = mockStore({});
    localStorage.clear();
  });

  it('renders ColorTabs and switches tabs', async () => {
    const tabName = [
      { value: 'one', label: 'Tab One' },
      { value: 'two', label: 'Tab Two' },
    ];

    const pages = [
      { value: 'one', component: <div>Content One</div> },
      { value: 'two', component: <div>Content Two</div> },
    ];

    render(
      <Provider store={store}>
        <MemoryRouter>
          <ColorTabs tabName={tabName} pages={pages} />
        </MemoryRouter>
      </Provider>
    );

    // Check that tabs render
    expect(screen.getByText('Tab One')).toBeInTheDocument();
    expect(screen.getByText('Tab Two')).toBeInTheDocument();

    // Switch to second tab
    const tabTwo = screen.getByText('Tab Two');
    await act(async () => {
      fireEvent.click(tabTwo);
    });

    // Wait for content to appear
    expect(await screen.findByText('Content Two')).toBeInTheDocument();
  });
});
