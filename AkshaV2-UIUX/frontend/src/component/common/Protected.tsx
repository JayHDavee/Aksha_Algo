import React from "react";
import { Navigate } from "react-router-dom";
 

// Props interface
interface ProtectedProps {
  isLoggedIn: boolean;              // If false, redirect to login
  children: React.ReactElement;    // The component(s) wrapped by <Protected>
}

// (Optional) Inline styles structure if needed later
const styles = {
  // Example style usage if you add a loading state or fallback
  wrapper: {} as React.CSSProperties,
};

// Protected route wrapper
const Protected: React.FC<ProtectedProps> = ({ isLoggedIn, children }) => {
  /*
    - If not logged in, redirect to "/"
    - 'replace' ensures the user can't navigate back
  */
  if (!isLoggedIn) {
    return <Navigate to="/" replace />;
  }

  // If logged in, render the protected children
  return children;
};

export default Protected;
