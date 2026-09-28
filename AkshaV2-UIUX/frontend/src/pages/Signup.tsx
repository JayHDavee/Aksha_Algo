import React, { useState } from 'react';
import {
  Visibility,
  VisibilityOff,
  MailOutline,
  LockOutlined,
  PersonOutline,
  Business,
  SupervisorAccount,
} from '@mui/icons-material';
import axiosInstance from "../utils/axiosInstance";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Container,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import akshaLogo from '../assets/images/AkshaLogo.png';
import { Link, useNavigate } from 'react-router-dom';
import CryptoJS from 'crypto-js';
import { useApi } from '../hooks/useApi';
import { useTranslation } from 'react-i18next';

interface FormData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
  userType: string;
  companyName: string;
}

const Signup: React.FC = () => {
  const {t} = useTranslation();
  const [formData, setFormData] = useState<FormData>({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    userType: '',
    companyName: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [agreeToTerms, setAgreeToTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' as 'success' | 'error' | 'warning' | 'info' });

  const { callApi } = useApi();
  const navigate = useNavigate();
  const SECRET_KEY = import.meta.env.VITE_PASSWORD_SECRET_KEY || '';

  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: false }));
    if (field === 'password' || field === 'confirmPassword') {
      setPasswordMismatch(false);
    }
  };

  const validateFields = () => {
    const newErrors: Record<string, boolean> = {};
    (Object.keys(formData) as (keyof FormData)[]).forEach((field) => {
      if (!formData[field].trim()) newErrors[field] = true;
    });
    if (formData.password !== formData.confirmPassword) {
      setPasswordMismatch(true);
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0 && !passwordMismatch;
  };

  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleSnackbarClose = () => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  };

  const handleSubmit = async () => {
    const isValid = validateFields();
    if (!isValid) {
      showSnackbar(t("Please fix the errors before submitting"), 'warning');
      return;
    }

    if (!agreeToTerms) {
      showSnackbar(t("Please accept the terms and conditions"), 'warning');
      return;
    }

    const hashedPassword = CryptoJS.HmacSHA256(formData.password, SECRET_KEY).toString();

    const payload = {
      email: formData.email,
      passwordHash: hashedPassword,
      role: formData.userType,
      companyName: formData.companyName,
      username: `${formData.firstName} ${formData.lastName}`,
    };

    try {
      const res = await axiosInstance.post('/register', payload);
      if (res.status === 200) {
        showSnackbar(t("Account created successfully!"), 'success');
        setTimeout(() => navigate('/login'), 1500);
      }
    } catch (err: any) {
      if (err.response) {
        showSnackbar('Error creating account: ' + (err.response.data.message || 'Something went wrong'), 'error');
      } else {
        showSnackbar(t("Network error"), 'error');
      }
    }
  };

  const isFormInvalid =
    !formData.firstName ||
    !formData.lastName ||
    !formData.email ||
    !formData.password ||
    !formData.confirmPassword ||
    !formData.userType ||
    !formData.companyName ||
    formData.password !== formData.confirmPassword ||
    !agreeToTerms;

  return (
    <Container component="main" maxWidth="sm" sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ textAlign: 'center', mt: 4, marginBottom: 5 }}>
          <img src={akshaLogo} alt="Aksha Logo" style={{ width: '140px',height:'140px', marginBottom: 12 }} />
          <Typography variant="h5" fontWeight={300} color="textPrimary">
            {t("Welcome to AI Surveillance Portal")}
          </Typography>
          <Typography variant="subtitle1" color="textSecondary" sx={{ mt: 2 }}>
            {t("Secure. Smart. Real-time Monitoring.")}
          </Typography>
        </Box>

        <Paper elevation={6} sx={{ p: 4, borderRadius: 2, marginBottom: 10 }}>
          <Typography variant="h5" fontWeight={600} gutterBottom textAlign="center">
            {t("Create Account")}
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                label={t("First Name")}
                fullWidth
                value={formData.firstName}
                onChange={(e) => handleInputChange('firstName', e.target.value)}
                error={errors.firstName}
                helperText={errors.firstName && t("First name is required")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <PersonOutline />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Last Name */}
            <Grid item xs={12} sm={6}>
              <TextField
                label={t("Last Name")}
                fullWidth
                value={formData.lastName}
                onChange={(e) => handleInputChange('lastName', e.target.value)}
                error={errors.lastName}
                helperText={errors.lastName && t("Last name is required")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <PersonOutline />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Email */}
            <Grid item xs={12}>
              <TextField
                label={t("Email Address")}
                fullWidth
                type="email"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                error={errors.email}
                helperText={errors.email && t("Email is required")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <MailOutline />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Company Name */}
            <Grid item xs={12}>
              <TextField
                label={t("Company Name")}
                fullWidth
                value={formData.companyName}
                onChange={(e) => handleInputChange('companyName', e.target.value)}
                error={errors.companyName}
                helperText={errors.companyName && t("Company name is required")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <Business />
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Account Type */}
            <Grid item xs={12}>
              <TextField
                select
                label={t("Account Type")}
                fullWidth
                value={formData.userType}
                onChange={(e) => handleInputChange('userType', e.target.value)}
                error={errors.userType}
                helperText={errors.userType && t("Please select account type")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SupervisorAccount />
                    </InputAdornment>
                  ),
                }}
              >
                <MenuItem value="user">{t("User")}</MenuItem>
                <MenuItem value="admin">{t("Admin")}</MenuItem>
              </TextField>
            </Grid>

            {/* Password */}
            <Grid item xs={12}>
              <TextField
                label={t("Password")}
                fullWidth
                type={showPassword ? 'text' : 'password'}
                value={formData.password}
                onChange={(e) => handleInputChange('password', e.target.value)}
                error={errors.password}
                helperText={errors.password && t("Password is required")}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <LockOutlined />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowPassword(!showPassword)}>
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Confirm Password */}
            <Grid item xs={12}>
              <TextField
                label={t("Confirm Password")}
                fullWidth
                type={showConfirmPassword ? 'text' : 'password'}
                value={formData.confirmPassword}
                onChange={(e) => handleInputChange('confirmPassword', e.target.value)}
                error={errors.confirmPassword || passwordMismatch}
                helperText={
                  errors.confirmPassword
                    ? t("Confirm password is required")
                    : passwordMismatch && t("Passwords do not match")
                }
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <LockOutlined />
                    </InputAdornment>
                  ),
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowConfirmPassword(!showConfirmPassword)}>
                        {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
            </Grid>

            {/* Terms and Conditions */}
            <Grid item xs={12}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={agreeToTerms}
                    onChange={(e) => setAgreeToTerms(e.target.checked)}
                    color="primary"
                  />
                }
                label={
                  <Typography variant="body2">
                    {t("I agree to the")}{' '}
                    <Link to="#" style={{ color: '#1976d2' }}>{t("Terms and Conditions")}</Link> {t("and")}{' '}
                    <Link to="#" style={{ color: '#1976d2' }}>{t("Privacy Policy")}</Link>
                  </Typography>
                }
              />
            </Grid>
          </Grid>

          <Grid item xs={12}>
            <Button
              variant="contained"
              fullWidth
              onClick={handleSubmit}
              sx={{ py: 1.5 }}
              disabled={isFormInvalid}
            >
              {t("Create Account")}
            </Button>
          </Grid>
          <Grid item xs={12}>
            <Typography variant="body2" align="center">
              {t("Already have an account?")}{' '}
              <Link to="/login" style={{ color: '#1976d2', textDecoration: 'underline' }}>
                {t("Log in")}
              </Link>
            </Typography>
          </Grid>
        </Paper>

        <Snackbar
          open={snackbar.open}
          autoHideDuration={4000}
          onClose={handleSnackbarClose}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
          <Alert onClose={handleSnackbarClose} severity={snackbar.severity} sx={{ width: '100%' }}>
            {snackbar.message}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
};

export default Signup;
