import React, { createContext, useContext, useState, useCallback } from 'react';

interface BottomNavContextType {
  isAtBottom: boolean;
  setIsAtBottom: (value: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (value: boolean) => void;
}

const BottomNavContext = createContext<BottomNavContextType>({
  isAtBottom: false,
  setIsAtBottom: () => {},
  drawerOpen: false,
  setDrawerOpen: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export const useBottomNav = () => useContext(BottomNavContext);

export const BottomNavProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleSetIsAtBottom = useCallback((value: boolean) => {
    setIsAtBottom(value);
  }, []);

  const handleSetDrawerOpen = useCallback((value: boolean) => {
    setDrawerOpen(value);
  }, []);

  return (
    <BottomNavContext.Provider value={{ isAtBottom, setIsAtBottom: handleSetIsAtBottom, drawerOpen, setDrawerOpen: handleSetDrawerOpen }}>
      {children}
    </BottomNavContext.Provider>
  );
};
