import React, { useState } from 'react';
import { message } from 'antd';
import Modal from 'react-bootstrap/Modal';
import { useApi } from '../hooks/useApi';

const AdminLogin: React.FC = () => {
  const { callApi } = useApi();

  // Local state management
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Show modal and reset credentials
  const showModal = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setIsModalOpen(true);
    setUsername('');
    setPassword('');
  };

  // Close modal handler
  const handleClose = () => setIsModalOpen(false);

  // Login logic with validation and API call
  const login = async () => {
    if (!username) {
      message.warning('Username is required.');
      return;
    }

    if (!password) {
      message.warning('Password is required.');
      return;
    }

    try {
      const response = await callApi(`${import.meta.env.VITE_USER_LOGIN}`, {
        method: 'POST',
        body: {
          Username: username,
          Password: password,
        },
      });

      if (response?.status === 200) {
        const res = response.data;
        if (res.message === 'Authentication Successful!') {
          message.success(res.message);
          window.localStorage.setItem('isLoggedIn', 'true');
          window.localStorage.setItem(
            'userInfo',
            JSON.stringify({
              Client: res.Client,
              Email: res.Email,
              Username: username,
              Password: password,
            })
          );
          setTimeout(() => {
            setIsModalOpen(false);
            window.location.assign('/monitor');
          }, 1000);
        } else {
          message.warn('Incorrect password');
        }
      } else {
        message.error(response?.data?.message || 'Login failed.');
      }
    } catch (error) {
      message.error('Login failed. Please try again.');
      console.error('Login error:', error);
    }
  };

  return (
    <div>
      <a href="#" onClick={showModal} className="admin-login-custom">
        Admin Login
      </a>

      <Modal show={isModalOpen} onHide={handleClose}>
        <Modal.Header closeButton>
          <Modal.Title>Admin Login</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="profile-model profile-model-custom">
            <div className="flex-main-info flex-main-info-custom">
              <div className="information">
                <div className="flex-input">
                  <label>Username</label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    style={{ marginBottom: 29 }}
                  />
                </div>
                <div className="flex-input">
                  <label>Password</label>
                  <input
                    type="password"
                    className="form-control"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ marginBottom: 29 }}
                  />
                </div>
              </div>
            </div>
            <div className="flex-btn-pass">
              <button
                className="btn btn-reset-pass btn-reset-pass-custom"
                onClick={handleClose}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={login}>
                Login
              </button>
            </div>
          </div>
        </Modal.Body>
      </Modal>
    </div>
  );
};

export default AdminLogin;
