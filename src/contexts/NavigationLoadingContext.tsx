import React, { createContext, useContext, useState, useCallback } from 'react';

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

export const useNavigationLoading = () => useContext(NavigationLoadingContext);

interface NavigationLoadingProviderProps {
  children: React.ReactNode;
}

export const NavigationLoadingProvider: React.FC<NavigationLoadingProviderProps> = ({ children }) => {
  const [isNavigating, setIsNavigating] = useState(false);

  const startNavigation = useCallback(() => {
    setIsNavigating(true);
  }, []);

  const endNavigation = useCallback(() => {
    setIsNavigating(false);
  }, []);

  return (
    <NavigationLoadingContext.Provider value={{ isNavigating, startNavigation, endNavigation }}>
      {children}
    </NavigationLoadingContext.Provider>
  );
};

export default NavigationLoadingContext;
