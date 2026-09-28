import React from 'react';
import { Snackbar } from '@mui/material';
import { CheckCircleRounded, ErrorOutlined } from '@mui/icons-material';

// Props interface for type safety
interface MessageboxProps {
  open: boolean;                // Controls visibility of snackbar
  handleClose: () => void;     // Function to close the snackbar
  message: string;             // Message to display
  warning?: boolean;           // If true, shows warning icon; otherwise success
}

// Inline style object
const styles = {
  snackbarContent: {
    backgroundColor: '#FFFFFF',
    color: '#000000',
    marginTop: '-1%',
  } as React.CSSProperties,

  icon: {
    marginRight: '8px',
  } as React.CSSProperties,
};

// Messagebox component
const Messagebox: React.FC<MessageboxProps> = ({
  open,
  handleClose,
  message,
  warning = true,
}) => {
  // Choose icon based on warning status
  const Icon = warning ? ErrorOutlined : CheckCircleRounded;
  const iconColor = warning ? '#ffc500' : '#4CAF50';

  return (
    <Snackbar
      open={open}
      autoHideDuration={2000}
      onClose={handleClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      ContentProps={{
        style: styles.snackbarContent,
      }}
      message={
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <Icon style={{ ...styles.icon, color: iconColor }} />
          {message}
        </span>
      }
    />
  );
};

export default Messagebox;
