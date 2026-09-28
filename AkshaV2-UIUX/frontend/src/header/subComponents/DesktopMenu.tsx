import React from 'react';
import { Button } from '@mui/material';
import { useTranslation } from 'react-i18next';

// Define the shape of a navigation item
interface NavItem {
  name: string;
  icon: string;
  iconWhite: string;
  width: number | string;
  height: number | string;
  active: boolean;
}

// Define the props for DesktopMenu component
interface DesktopMenuProps {
  navigation: NavItem[]; // Array of nav items (e.g., Monitor, Insights, etc.)
  onMenuChange: (page: NavItem, index: number) => void; // Handler for button click
}

/**
 * DesktopMenu Component
 * Renders horizontal navigation buttons for desktop view using Material UI.
 * Active page is highlighted with different background and icon.
 */
const DesktopMenu: React.FC<DesktopMenuProps> = ({ navigation, onMenuChange }) => {

  const {t} = useTranslation();
  return (
    <>
      {navigation.map((page, index) => (
        <Button
          key={index}
          onClick={() => onMenuChange(page, index)} // Trigger callback when button is clicked
          className={`${page.name.toLowerCase().replace(/\s+/g, "-")}-section`}
          sx={{
            mx: 1,
            px: 2.5,
            py: 1,
            color: page.active ? '#024578' : '#ffffff', // Text color based on active state
            background: page.active ? '#ffffff' : 'transparent',       // Background color based on active state
            textTransform: 'initial',
            fontSize: '16px',
            fontWeight: page.active ? 600 : 500,
            borderRadius: '999px',
            display: 'block',
            transition: 'background-color 0.15s ease, color 0.15s ease',
            '&:hover': {
              background: page.active ? '#ffffff' : 'rgba(255,255,255,0.14)',
            },
          }}
        >
          {/* Render icon based on active state: active pill is white so it needs the
              colored icon; inactive sits on the blue bar so it needs the white icon */}
          <img
            src={page.active ? page.icon : page.iconWhite}
            style={{
              width: page.width,
              height: page.height,
            }}
            alt="page icon"
          />
          &nbsp;
          {t(page.name)}
        </Button>
      ))}
    </>
  );
};

export default DesktopMenu;
