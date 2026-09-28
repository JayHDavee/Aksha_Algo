import React from 'react';

interface SettingsProps {
  onSettingsClick: () => void; // Callback triggered on settings icon click
}

/**
 * Settingss Component
 * Renders a settings icon if the user is logged in.
 * Highlights the icon if on the '/cameraDirectory' route.
 */
const Settingss: React.FC<SettingsProps> = ({ onSettingsClick }) => {
  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const isCameraDirectoryPath = window.location.pathname === '/cameraDirectory';

  return (
    <>
      {/* Only show settings icon if user is logged in */}
      {isLoggedIn && (
        <div className='camera-directory-section'>
          {/* Settings icon */}
          <i
            className="bx bx-camera mx-2 setting-icon-style"
            aria-label="Settings"
            onClick={onSettingsClick}
          />

          {/* Highlight indicator below the icon when on the camera directory route */}
          {isCameraDirectoryPath && (
            <div className="setting-active-link" />
          )}
        </div>
      )}
    </>
  );
};

export default Settingss;
