// src/tests/component/profile/Profile.test.tsx
import React from 'react';
import { render } from '@testing-library/react';
import { getEnvVar } from '../../../utils/envHelper';
import Profile from '../../../component/profile/Profile';
import axios from 'axios';


jest.mock('axios');
jest.mock('../../../utils/envHelper', () => ({
  getEnvVar: (key: string) => {
    const envMap: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_PROFILE_API: '/api/profile',
    };
    return envMap[key] || '';
  },
}));

jest.mock('antd', () => ({
  message: {
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Profile Component', () => {
  beforeEach(() => {
    window.localStorage.setItem(
      'userInfo',
      JSON.stringify({
        Client: 'Test Client',
        Email: 'test@example.com',
        Username: 'testuser',
        Password: 'password123',
      })
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it('renders Profile component and opens modal on click', () => {
    const { getByText, getByPlaceholderText } = render(
      <Profile>
        <button>Open Profile</button>
      </Profile>
    );

    const openButton = getByText('Open Profile');
    openButton.click();

    expect(getByPlaceholderText('Full name')).toBeInTheDocument();
    expect(getByPlaceholderText('Admin Email address')).toBeInTheDocument();
  });

  it('fetches email details on mount', () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        success: true,
        notification_email: ['notify@example.com'],
        alert_report_email: ['alert@example.com'],
        bot_token: 'token123',
        chat_ids: ['chat1', 'chat2'],
        new_email: 'new@example.com',
        genai_features: true,
      },
    });

    render(
      <Profile>
        <button>Open Profile</button>
      </Profile>
    );

    expect(axios.get).toHaveBeenCalled();
  });
});
