import React, { useState, FormEvent } from 'react';
import {
  Visibility,
  VisibilityOff,
  MailOutline,
  LockOutlined,
  Login as LoginIcon,
} from '@mui/icons-material';
import {
  Avatar,
  Box,
  Button,
  Container,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
  Grid,
  Snackbar,
  Alert,
} from '@mui/material';
import axiosInstance from '../utils/axiosInstance';
import akshaLogo from '../assets/images/AkshaLogo.png';
import { Link, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import CryptoJS from 'crypto-js';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../context/AuthContext';
import { loginSuccess } from '../global_store/reducers/authReducer';
import { useTranslation } from 'react-i18next';

const Login: React.FC = () => {
  const { t } = useTranslation();
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [emailError, setEmailError] = useState(false);
  const [passwordError, setPasswordError] = useState(false);

  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'error' | 'warning' | 'info'>('info');

  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { callApi } = useApi();
  const { signIn } = useAuth();

  const SECRET_KEY = import.meta.env.VITE_PASSWORD_SECRET_KEY;

  const showToast = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  };

  const handleCloseSnackbar = () => {
    setSnackbarOpen(false);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const isEmailEmpty = !email.trim();
    const isPasswordEmpty = !password.trim();

    setEmailError(isEmailEmpty);
    setPasswordError(isPasswordEmpty);

    if (isEmailEmpty || isPasswordEmpty) {
      showToast(t('Please fill in both email and password'), 'warning');
      return;
    }

    if (!SECRET_KEY) {
      showToast(t('Encryption key is not configured'), 'error');
      return;
    }

    const passwordHash = CryptoJS.HmacSHA256(password, SECRET_KEY).toString();

    try {
      const res = await axiosInstance.post('/login', {
        email,
        passwordHash,
      });

      const { token, email: userEmail, role, siteId } = res.data;

      const {
              Client = "developer",
              Email = "cctv.alerts@algoanalytics.com"
      } = res;
           
            

      if (res.status === 200) {
        showToast(t('Login successful!'), 'success');
        localStorage.setItem('siteId',siteId);
        localStorage.setItem('isLoggedIn', 'true');
          if (Client && Email && email && password) {
                const userObj = { Client, Email, Username: email, Password: password };
                localStorage.setItem("userInfo", JSON.stringify(userObj));
                console.log("User info stored:", userObj);
        } else {
                console.warn("Cannot store user info, missing fields:", { Client, Email, email, password });
        }

        dispatch(
          loginSuccess({
            token,
            email: userEmail,
            role,
          })

        );
        signIn({ token, email: userEmail, role });
              

        setTimeout(() => navigate('/monitor'), 500); // delay to let user see success message
      }
    } catch (err: any) {
      console.error('Login error:', err);
      showToast(err.response?.data?.message || t('Login failed'), 'error');
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Snackbar (MUI Toast) */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={3000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert onClose={handleCloseSnackbar} severity={snackbarSeverity} sx={{ width: '100%' }}>
          {snackbarMessage}
        </Alert>
      </Snackbar>

      {/* Logo & Branding */}
      <Box sx={{ textAlign: 'center', mt: 4 }}>
        <Box
          component="img"
          src={akshaLogo}
          alt="Aksha Logo"
          sx={{
            width: 140,
            height: 'auto',
            maxWidth: '100%',
            objectFit: 'contain',
            mb: 1.5,
          }}
        />
        <Typography variant="h5" fontWeight={300} color="textPrimary">
          {t("Welcome to AI Surveillance Portal")}
        </Typography>
        <Typography variant="subtitle1" color="textSecondary" sx={{ mt: 2 }}>
          {t("Secure. Smart. Real-time Monitoring.")}
        </Typography>
      </Box>

      {/* Login Box */}
      <Box
        sx={{
          flexGrow: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 3,
          marginBottom: 20,
        }}
      >
        <Container component="main" maxWidth="xs">
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              boxShadow: 3,
              p: 4,
              borderRadius: 2,
              backgroundColor: 'white',
            }}
          >
            <Avatar sx={{ m: 1, bgcolor: 'primary.main' }}>
              <LoginIcon />
            </Avatar>
            <Typography component="h5" variant="h6">
              {t("Sign In to Your Account")}
            </Typography>

            <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
              <TextField
                fullWidth
                label={t("Email Address")}
                variant="outlined"
                margin="normal"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(false);
                }}
                error={emailError}
                helperText={emailError ? t("Email is required") : ''}
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
                label={t("Password")}
                variant="outlined"
                margin="normal"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(false);
                }}
                error={passwordError}
                helperText={passwordError ? t("Password is required") : ''}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <LockOutlined />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                        size="small"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />

              <Box sx={{ textAlign: 'right', mt: 1 }}>
                <Link to="/forgotpassword" style={{ textDecoration: 'none', color: '#1976d2' }}>
                  {t("Forgot password?")}
                </Link>
              </Box>

              <Button
                type="submit"
                fullWidth
                variant="contained"
                color="primary"
                disabled={!email.trim() || !password.trim()}
                sx={{ mt: 3, mb: 2, py: 1.5 }}
              >
                {t("Sign In")}
              </Button>

              <Grid container justifyContent="center">
                <Grid item>
                  <Typography variant="body2">
                    {t("Don’t have an account?")}{' '}
                    <Link to="/signup" style={{ color: '#1976d2' }}>
                      {t("Sign up")}
                    </Link>
                  </Typography>
                </Grid>
              </Grid>
            </Box>
          </Box>
        </Container>
      </Box>
    </Box>
  );
};

export default Login;
