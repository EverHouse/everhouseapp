import React, { createContext, useContext, useState, useCallback } from 'react';

interface BottomNavContextType {
  isAtBottom: boolean;
  setIsAtBottom: (value: boolean) => void;
}

const BottomNavContext = createContext<BottomNavContextType>({
  isAtBottom: false,
  setIsAtBottom: () => {},
});

export const useBottomNav = () => useContext(BottomNavContext);

export const BottomNavProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAtBottom, setIsAtBottom] = useState(false);

  const handleSetIsAtBottom = useCallback((value: boolean) => {
    setIsAtBottom(value);
  }, []);

  return (
    <BottomNavContext.Provider value={{ isAtBottom, setIsAtBottom: handleSetIsAtBottom }}>
      {children}
    </BottomNavContext.Provider>
  );
};
