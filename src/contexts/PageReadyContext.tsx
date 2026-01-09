import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface PageReadyContextType {
  isPageReady: boolean;
  setPageReady: (ready: boolean) => void;
  resetPageReady: () => void;
}

const PageReadyContext = createContext<PageReadyContextType>({
  isPageReady: true,
  setPageReady: () => {},
  resetPageReady: () => {},
});

export const usePageReady = () => useContext(PageReadyContext);

export const PageReadyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isPageReady, setIsPageReady] = useState(true);
  const readyTimeoutRef = useRef<number | null>(null);

  const setPageReady = useCallback((ready: boolean) => {
    if (readyTimeoutRef.current) {
      clearTimeout(readyTimeoutRef.current);
      readyTimeoutRef.current = null;
    }
    setIsPageReady(ready);
  }, []);

  const resetPageReady = useCallback(() => {
    if (readyTimeoutRef.current) {
      clearTimeout(readyTimeoutRef.current);
    }
    setIsPageReady(false);
    readyTimeoutRef.current = window.setTimeout(() => {
      setIsPageReady(true);
    }, 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
      }
    };
  }, []);

  return (
    <PageReadyContext.Provider value={{ isPageReady, setPageReady, resetPageReady }}>
      {children}
    </PageReadyContext.Provider>
  );
};

export function usePageLoading() {
  const { setPageReady } = usePageReady();
  
  const startLoading = useCallback(() => {
    setPageReady(false);
  }, [setPageReady]);
  
  const finishLoading = useCallback(() => {
    setPageReady(true);
  }, [setPageReady]);
  
  return { startLoading, finishLoading };
}
