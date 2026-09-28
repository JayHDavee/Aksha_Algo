import axios from 'axios';

console.log('Using base URL:', import.meta.env.VITE_AUTHENCTICATE_USER);

const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_AUTHENCTICATE_USER, // Use the new base URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export default axiosInstance;
