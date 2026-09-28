import React from 'react';
import { render } from '@testing-library/react';
import CustomDropdown from '../../../component/common/CustomDropdown';
import { MenuProps } from 'antd';

const mockItems: MenuProps['items'] = [
  {
    key: '1',
    label: 'Option 1',
  },
  {
    key: '2',
    label: 'Option 2',
  },
];

describe('CustomDropdown Component', () => {
  it('renders without crashing', () => {
    const { getByText } = render(
      <CustomDropdown items={mockItems}>
        <span>Dropdown</span>
      </CustomDropdown>
    );
    expect(getByText('Dropdown')).toBeInTheDocument();
  });

  // Additional tests for dropdown menu interactions can be added here
});
