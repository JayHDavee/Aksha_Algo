import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import configureStore from 'redux-mock-store';
import thunk from 'redux-thunk';

import Insights from '../../../container/insights/Insights';

// Mock react-markdown (ESM)
jest.mock('react-markdown', () => (props) => (
  <div data-testid="markdown">{props.children}</div>
));

jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: jest.fn(() => 'http://localhost'),
}));

jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

const mockStore = configureStore([thunk]);

describe('Insights Component', () => {
  it('renders without crashing', () => {
    const store = mockStore({
      isMobileDevice: { is_mobile: false },
      insights: { report: [] },
      snackBar: { toast: { show: false, indicator: 'success', message: '' } }
    });

    const { getByText } = render(
      <MemoryRouter>
        <Provider store={store}>
          <Insights />
        </Provider>
      </MemoryRouter>
    );

    // *** Use actual UI text ***
    expect(getByText(/Activity Tracker/i)).toBeInTheDocument();
    expect(getByText(/Report/i)).toBeInTheDocument();
    expect(getByText(/Tour/i)).toBeInTheDocument();
  });
});
