import axios from 'axios';

// Setup global Axios request interceptor
axios.interceptors.request.use(
  (config) => {
    // Get JWT token from environment variable
    const token = import.meta.env.VITE_DEFAULT_JWT_TOKEN;

    if (token) {
      // Attach Authorization header to request
      config.headers = {
        ...config.headers,
        Authorization: `Bearer ${token}`,
      };
    }

    // Optional: log the outgoing request
    // console.log("[Axios Request]", config.url, config.headers);

    return config;
  },
  (error) => {
    // Log request error before it's sent
    console.error("[Axios Request Error]", error);
    return Promise.reject(error);
  }
);

export default axios;
