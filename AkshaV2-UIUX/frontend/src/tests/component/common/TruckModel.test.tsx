import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import userEvent from '@testing-library/user-event';
import TruckModel from '../../../component/common/TruckModel';

const mockStore = configureStore([]);
const store = mockStore({
  investigation: {
    allObjectOfInterestLabels: ['person', 'car', 'bicycle'],
  },
});

const mockProps = {
  setTabStore: jest.fn(),
  tabStore: [{ text: '', active: false }],
  index: 0,
  close: jest.fn(),
  setDefaultval: jest.fn(),
  selectedOption: ['person'],
  setOILable: jest.fn(),
};

describe('TruckModel Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(
      <Provider store={store}>
        <TruckModel {...mockProps} />
      </Provider>
    );
    expect(getByText('person')).toBeInTheDocument();
    expect(getByText('car')).toBeInTheDocument();
    expect(getByText('bicycle')).toBeInTheDocument();
  });

  it('calls showSelected on label click', async () => {
    const { getByText } = render(
      <Provider store={store}>
        <TruckModel {...mockProps} />
      </Provider>
    );
    await userEvent.click(getByText('person'));
    expect(mockProps.setOILable).toHaveBeenCalled();
  });
});
