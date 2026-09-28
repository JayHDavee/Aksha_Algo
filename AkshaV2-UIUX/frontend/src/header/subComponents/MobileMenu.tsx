import React from 'react';
import { MenuItem, Menu, Typography } from '@mui/material';

// Define type for each navigation item
interface NavItem {
  name: string;
  icon: string;
  width: number | string;
  height: number | string;
}

// Props interface for MobileMenu component
interface MobileMenuProps {
  anchorElNav: null | HTMLElement;                     // Anchor element for the dropdown menu
  onCloseNavMenu: () => void;                          // Function to close the menu
  navigation: NavItem[];                               // Array of nav items (Monitor, Investigation, Insights)
  onItemSelect: (page: NavItem, index: number, isMobile: boolean) => void; // Handler when a menu item is clicked
}

/**
 * MobileMenu Component
 * Renders a dropdown navigation menu for small screen sizes using Material UI.
 */
const MobileMenu: React.FC<MobileMenuProps> = ({
  anchorElNav,
  onCloseNavMenu,
  navigation,
  onItemSelect,
}) => {
  return (
    <Menu
      id="menu-appbar"
      anchorEl={anchorElNav} // Anchor position of the dropdown
      anchorOrigin={{
        vertical: 'bottom',
        horizontal: 'left',
      }}
      keepMounted
      transformOrigin={{
        vertical: 'top',
        horizontal: 'left',
      }}
      open={Boolean(anchorElNav)} // Menu visibility
      onClose={onCloseNavMenu}
      sx={{
        // Only display the mobile menu on extra-small screens
        display: { xs: 'block', md: 'none' },
      }}
    >
      {/* Loop through the navigation items */}
      {navigation.map((page, index) => (
        <MenuItem
          key={index}
          onClick={() => onItemSelect(page, index, true)} // Pass isMobile=true
        >
          <Typography textAlign="center">
            {/* Icon for each page (Monitor, Investigation, Insights) */}
            <img
              src={page.icon}
              alt="page icon"
              style={{
                width: page.width,
                height: page.height,
              }}
            />
            &nbsp;
            {page.name} -
          </Typography>
        </MenuItem>
      ))}
    </Menu>
  );
};

export default MobileMenu;
