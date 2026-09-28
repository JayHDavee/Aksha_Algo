import { createContext, useContext, useEffect, useState } from 'react';
import axiosJWT from './axiosAuthIntercept';

interface FeatureFlags {
  PPE_DETECTION: boolean;
  JEWELRY_DETECTION: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  PPE_DETECTION: false,
  JEWELRY_DETECTION: false,
};

const FeatureFlagsContext = createContext<FeatureFlags>(DEFAULT_FLAGS);

interface FeatureFlagsProviderProps {
  children: React.ReactNode;
}

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

export const FeatureFlagsProvider = ({ children }: FeatureFlagsProviderProps) => {
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);

  useEffect(() => {
    axiosJWT
      .get(`${VITE_base_url}/api/feature-flags`)
      .then(({ data }) => {
        setFlags({
          PPE_DETECTION: Boolean(data?.PPE_DETECTION),
          JEWELRY_DETECTION: Boolean(data?.JEWELRY_DETECTION),
        });
      })
      .catch(() => {
        // Feature flags stay off by default if the endpoint is unreachable —
        // fail closed, never surface a flagged feature by accident.
      });
  }, []);

  return (
    <FeatureFlagsContext.Provider value={flags}>
      {children}
    </FeatureFlagsContext.Provider>
  );
};

export const useFeatureFlags = () => useContext(FeatureFlagsContext);

export default FeatureFlagsContext;
