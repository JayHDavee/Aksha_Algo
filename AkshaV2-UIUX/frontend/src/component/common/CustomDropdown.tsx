import React from 'react';
import { Dropdown, Space, MenuProps } from 'antd';

// Props interface
interface CustomDropdownProps {
  items: MenuProps['items'];
  children: React.ReactNode;
}

// Inline styles (currently minimal)
const styles = {
  link: {
    cursor: 'pointer',
    textDecoration: 'none',
  } as React.CSSProperties,
};

// CustomDropdown component using Ant Design
const CustomDropdown: React.FC<CustomDropdownProps> = ({ items, children }) => {
  return (
    <Dropdown
      menu={{
        items,
      }}
    >
      {/* Prevent default anchor behavior */}
      <a onClick={(e) => e.preventDefault()} style={styles.link}>
        <Space>{children}</Space>
      </a>
    </Dropdown>
  );
};

export default CustomDropdown;
