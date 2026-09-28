import React, { JSX, useState } from 'react';
import {
  Visibility,
  VisibilityOff,
  LockOutlined,
  MailOutline,
  ArrowBack,
  Key,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Container,
  IconButton,
  InputAdornment,
  Paper,
  TextField,
  Typography,
  Snackbar,
  Alert,
} from '@mui/material';
import akshaLogo from '../assets/images/AkshaLogo.png';
import { Link, useNavigate } from 'react-router-dom';
import CryptoJS from 'crypto-js';
import { useApi } from '../hooks/useApi';
import axiosInstance from '../utils/axiosInstance';

export default function ForgotPasswordPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [emailError, setEmailError] = useState(false);
  const [newPasswordError, setNewPasswordError] = useState(false);
  const [confirmPasswordError, setConfirmPasswordError] = useState(false);
  const [passwordMismatchError, setPasswordMismatchError] = useState(false);

  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error' | 'warning'>('success');

  const { callApi } = useApi();
  const navigate = useNavigate();
  const SECRET_KEY = import.meta.env.VITE_PASSWORD_SECRET_KEY || 'default_key';

  const handleSnackbar = (message: string, severity: 'success' | 'error' | 'warning') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  };

  const handleCloseSnackbar = () => {
    setSnackbarOpen(false);
  };

  const handleSubmit = async () => {
    const isEmailEmpty = !email.trim();
    const isNewPasswordEmpty = !newPassword.trim();
    const isConfirmPasswordEmpty = !confirmPassword.trim();
    const doPasswordsMismatch = newPassword !== confirmPassword;

    setEmailError(isEmailEmpty);
    setNewPasswordError(isNewPasswordEmpty);
    setConfirmPasswordError(isConfirmPasswordEmpty);
    setPasswordMismatchError(!isConfirmPasswordEmpty && doPasswordsMismatch);

    if (isEmailEmpty || isNewPasswordEmpty || isConfirmPasswordEmpty || doPasswordsMismatch) {
      handleSnackbar('Please fix the errors before submitting', 'warning');
      return;
    }

    try {
      const hashedPassword = CryptoJS.HmacSHA256(newPassword, SECRET_KEY).toString();

      const response = await axiosInstance.post('/reset-password', {
        email,
        passwordHash: hashedPassword,
      });

      if (response.status === 200) {
        handleSnackbar('Password reset successful! You can now log in.', 'success');
        setTimeout(() => navigate('/login'), 1500); // wait briefly before redirecting
      }
    } catch (err: any) {
      console.error('Reset error:', err);
      handleSnackbar(err.response?.data?.message || 'Something went wrong.', 'error');
    }
  };

  const isFormInvalid =
    !email.trim() || !newPassword.trim() || !confirmPassword.trim() || newPassword !== confirmPassword;

  return (
    <Container
      maxWidth="sm"
      sx={{
        marginTop: 10,
        marginBottom: 10,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Paper elevation={3} sx={{ p: 4, width: '100%', textAlign: 'center' }}>
        <img
          src={akshaLogo}
          alt="Aksha Logo"
          style={{ width: 140, marginBottom: 24 }}
        />

        <Box sx={{ mb: 4 }}>
          <Box
            sx={{
              width: 64,
              height: 64,
              backgroundColor: 'primary.main',
              borderRadius: '50%',
              mx: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              mb: 2,
            }}
          >
            <Key sx={{ color: '#fff', fontSize: 32 }} />
          </Box>
          <Typography variant="h5" fontWeight="bold">
            Reset Password
          </Typography>
          <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
            Enter your email and new password
          </Typography>
        </Box>

        <Box component="form" noValidate autoComplete="off">
          <TextField
            fullWidth
            type="email"
            label="Email Address"
            variant="outlined"
            margin="normal"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(false);
            }}
            error={emailError}
            helperText={emailError ? 'Email is required' : ''}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <MailOutline />
                </InputAdornment>
              ),
            }}
          />

          <TextField
            fullWidth
            type={showNewPassword ? 'text' : 'password'}
            label="New Password"
            variant="outlined"
            margin="normal"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setNewPasswordError(false);
              setPasswordMismatchError(false);
            }}
            error={newPasswordError}
            helperText={newPasswordError ? 'New password is required' : ''}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockOutlined />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    edge="end"
                    size="small"
                  >
                    {showNewPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <TextField
            fullWidth
            type={showConfirmPassword ? 'text' : 'password'}
            label="Confirm Password"
            variant="outlined"
            margin="normal"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setConfirmPasswordError(false);
              setPasswordMismatchError(false);
            }}
            error={confirmPasswordError || passwordMismatchError}
            helperText={
              confirmPasswordError
                ? 'Confirm password is required'
                : passwordMismatchError
                ? 'Passwords do not match'
                : ''
            }
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockOutlined />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    edge="end"
                    size="small"
                  >
                    {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <Button
            fullWidth
            variant="contained"
            color="primary"
            sx={{ mt: 3, py: 1.5 }}
            onClick={handleSubmit}
            disabled={isFormInvalid}
          >
            Reset Password
          </Button>

          <Box textAlign="center" sx={{ mt: 3 }}>
            <Link
              to="/login"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                textDecoration: 'none',
                color: '#1976d2',
              }}
            >
              <ArrowBack sx={{ mr: 0.5 }} fontSize="small" />
              Back to Login
            </Link>
          </Box>
        </Box>
      </Paper>

      {/* Snackbar Message */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={3000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          onClose={handleCloseSnackbar}
          severity={snackbarSeverity}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Container>
  );
}
