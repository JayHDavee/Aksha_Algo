import React, { MouseEvent } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { IconButton, Avatar } from "@mui/material";
import PersonIcon from '@mui/icons-material/Person';
import ExitToAppIcon from '@mui/icons-material/ExitToApp';
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import Profile from '../component/profile/Profile';
import CustomDropdown from '../component/common/CustomDropdown';
import { logout } from '../global_store/reducers/authReducer';
import userImg from "../assets/images/header/user.png"
import avatarImg from "../assets/images/header/avatar.png"
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
// Define RootState for useSelector if not already typed globally
interface RootState {
  auth: {
    role?: string;
  };
}

/**
 * UserProfileDropDown displays an avatar and dropdown menu for admin users.
 * Allows viewing user details and performing logout.
 */
const UserProfileDropDown: React.FC = () => {
  const {t} = useTranslation();
  const dispatch = useDispatch(); 
  const { signOut } = useAuth();
  const { role } = useSelector((state: RootState) => state.auth || {});

  const siteId = localStorage.getItem('siteId') || "";

  const copySiteId = async () => {
  try {
    await navigator.clipboard.writeText(siteId);
    alert("Site ID copied!");
  } catch (err) {
    console.error("Failed to copy:", err);
  }
};

  /**
   * Handles user logout.
   * - Dispatches Redux logout action
   * - Clears localStorage
   * - Redirects to login page
   */
  const handleLogout = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    dispatch(logout());
    signOut();
  };

  /**
   * Prevents page refresh on anchor click.
   */
  const preventRefresh = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
  };

  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const isAdmin = role === 'admin';

  // Dropdown menu items
  const menu = [
     {
  key: "site-id",
  label: (
    <span
      onClick={copySiteId}
      style={{
       fontSize: "14px",
      fontWeight: 500,
      cursor: "pointer",
      padding: "4px 8px",
      borderRadius: "4px",
      color: "blue",
      }}
    >
      Site ID: {siteId}
      <ContentCopyIcon fontSize="small" />
    </span>
  ),
},
    {
      key: '1',
      label: (
        <Profile>
          <a href="#" className="anchor-style" onClick={preventRefresh}>
            {t("User Details")}
          </a>
        </Profile>
      ),
      icon: <PersonIcon className="icon-styled" />,
    },
    {
      key: '2',
      label: (
        <a href="#" onClick={handleLogout} className="anchor-style">
          {t("Logout")}
        </a>
      ),
      icon: <ExitToAppIcon className="icon-styled" />,
    },
  ];

  const menu2 = [
     {
  key: "site-id",
  label: (
    <span
      onClick={copySiteId}
      style={{
        fontSize: "14px",
      fontWeight: 500,
      cursor: "pointer",
      padding: "4px 8px",
      borderRadius: "4px",
      color: "blue",
      }}
    >
      Site ID: {siteId}
      <ContentCopyIcon fontSize="small" />
    </span>
  ),
},
    {
      key: '2',
      label: (
        <a href="#" onClick={handleLogout} className="anchor-style">
          {t("Logout")}
        </a>
      ),
      icon: <ExitToAppIcon className="icon-styled" />,
    }
  ]

  return (
    <div>

      <CustomDropdown items={isLoggedIn && isAdmin ? menu : menu2}>
        <div className="user-profile-dropdown">
           

           
          <IconButton sx={{ p: 0 }}>
            {/* Company logo */}
            {/* <img
              alt="company logo"
              src={userImg}
              style={{
                maxHeight: 34,
                minHeight: 34,
                minWidth: 72,
                maxWidth: 72,
                objectFit: 'fill',
              }}
            /> */}
            {/* Avatar image */}
            <Avatar
              alt="avatar"
              src={avatarImg}
            />
          </IconButton>
        </div>
      </CustomDropdown>
    </div>
  );
};

export default UserProfileDropDown;
