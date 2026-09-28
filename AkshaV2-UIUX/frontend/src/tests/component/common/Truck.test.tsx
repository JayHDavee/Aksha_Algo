import React from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Truck from '../../../component/common/Truck';

const mockProps = {
  heading: 'Truck*',
  text: 'select objects',
  active: true,
  index: 0,
  setTabStore: jest.fn(),
  tabStore: [{ active: false }],
  setOILable: jest.fn(),
  mobile: false,
  ooiLabels: ['label1', 'label2'],
  isOpen: false,
  setIsOpen: jest.fn(),
  menuRef: { current: { id: 'menu' } },
};

describe('Truck Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(<Truck {...mockProps} />);
    expect(getByText('select objects')).toBeInTheDocument();
  });

  it('toggles dropdown on click', async () => {
    const { getByText } = render(<Truck {...mockProps} />);
    await userEvent.click(getByText('select objects'));
    expect(mockProps.setTabStore).toHaveBeenCalled();
  });
});
