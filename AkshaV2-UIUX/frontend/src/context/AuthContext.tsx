import { createContext, useContext, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import jwtDecode from 'jwt-decode';
import { useDispatch } from 'react-redux';
import { loginSuccess, logout } from '../global_store/reducers/authReducer';

const AuthContext = createContext<any>(null);

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();

  const publicRoutes = ['/', '/login', '/signup', '/forgotpassword'];

  const signIn = (userData: any) => {
    const { token, email, role } = userData;

    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_email', email);
    localStorage.setItem('auth_role', role);
    localStorage.setItem('isLoggedIn', 'true');

    dispatch(loginSuccess({ token, email, role }));
  };

  const signOut = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_email');
    localStorage.removeItem('auth_role');
    localStorage.removeItem('isLoggedIn');

    dispatch(logout());
    navigate('/');
  };

  // ---------------------------------------------------
  // FIXED loadUser()
  // ---------------------------------------------------
  useEffect(() => {
    const loadUser = () => {
      try {
        const token = localStorage.getItem('auth_token');
        const email = localStorage.getItem('auth_email');
        const role = localStorage.getItem('auth_role');

        // ❌ If user is not logged in → exit safely
        if (!token || !email || !role) {
          setIsLoading(false);
          return; // <-- IMPORTANT FIX
        }

        // Safe decode
        let decoded: any;
        try {
          decoded = jwtDecode(token);
        } catch (e) {
          console.error("Invalid token");
          signOut();
          return;
        }

        // Token expiration check
        if (decoded.exp && Date.now() > decoded.exp * 1000) {
          console.log("Token expired");
          signOut();
          return;
        }

        // Load user to Redux
        dispatch(loginSuccess({ token, email, role }));

      } catch (err) {
        console.error("Auth Load Error:", err);
        signOut();
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);

  // ---------------------------------------------------
  // Route Guard Logic
  // ---------------------------------------------------
  useEffect(() => {
    if (isLoading) return;

    const path = location.pathname.toLowerCase();
    const isPublic = publicRoutes.includes(path);
    const token = localStorage.getItem('auth_token');

    // User not logged in but trying to access protected route
    if (!token && !isPublic) {
      navigate('/');
      return;
    }

    // User logged in but opens login/signup → redirect
    if (token && isPublic) {
      navigate('/monitor');
    }
  }, [isLoading, location.pathname]);

  return (
    <AuthContext.Provider value={{ signIn, signOut, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

export default AuthContext;
