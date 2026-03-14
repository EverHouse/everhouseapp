import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface NavigationLoadingContextType {
  isNavigating: boolean;
  startNavigation: () => void;
  endNavigation: () => void;
}

const NavigationLoadingContext = createContext<NavigationLoadingContextType>({
  isNavigating: false,
  startNavigation: () => {},
  endNavigation: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export const useNavigationLoading = () => useContext(NavigationLoadingContext);

interface NavigationLoadingProviderProps {
  children: React.ReactNode;
}

const NAVIGATION_TIMEOUT_MS = 5000;

export const NavigationLoadingProvider: React.FC<NavigationLoadingProviderProps> = ({ children }) => {
  const [isNavigating, setIsNavigating] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearNavigationTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startNavigation = useCallback(() => {
    clearNavigationTimeout();
    setIsNavigating(true);
    timeoutRef.current = setTimeout(() => {
      setIsNavigating(false);
    }, NAVIGATION_TIMEOUT_MS);
  }, [clearNavigationTimeout]);

  const endNavigation = useCallback(() => {
    clearNavigationTimeout();
    setIsNavigating(false);
  }, [clearNavigationTimeout]);

  useEffect(() => {
    return () => clearNavigationTimeout();
  }, [clearNavigationTimeout]);

  return (
    <NavigationLoadingContext.Provider value={{ isNavigating, startNavigation, endNavigation }}>
      {children}
    </NavigationLoadingContext.Provider>
  );
};

export default NavigationLoadingContext;
