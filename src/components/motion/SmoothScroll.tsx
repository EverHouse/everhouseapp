import React, { createContext, useContext, useCallback, useMemo } from 'react';

interface SmoothScrollContextType {
  lenis: null;
  scrollTo: (target: number | string | HTMLElement, options?: { offset?: number; duration?: number }) => void;
  stop: () => void;
  start: () => void;
}

const SmoothScrollContext = createContext<SmoothScrollContextType>({
  lenis: null,
  scrollTo: () => {},
  stop: () => {},
  start: () => {},
});

export const useSmoothScroll = () => useContext(SmoothScrollContext);

interface SmoothScrollProviderProps {
  children: React.ReactNode;
}

export const SmoothScrollProvider: React.FC<SmoothScrollProviderProps> = ({ children }) => {
  const scrollTo = useCallback((target: number | string | HTMLElement, options?: { offset?: number; duration?: number }) => {
    const offset = options?.offset ?? 0;
    
    if (typeof target === 'number') {
      window.scrollTo({ top: target + offset, behavior: 'smooth' });
    } else if (typeof target === 'string') {
      const element = document.querySelector(target);
      if (element) {
        const rect = element.getBoundingClientRect();
        const scrollTop = window.scrollY + rect.top + offset;
        window.scrollTo({ top: scrollTop, behavior: 'smooth' });
      }
    } else if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      const scrollTop = window.scrollY + rect.top + offset;
      window.scrollTo({ top: scrollTop, behavior: 'smooth' });
    }
  }, []);

  const stop = useCallback(() => {
    document.body.style.overflow = 'hidden';
  }, []);

  const start = useCallback(() => {
    document.body.style.overflow = '';
  }, []);

  const value = useMemo(() => ({ lenis: null, scrollTo, stop, start }), [scrollTo, stop, start]);

  return (
    <SmoothScrollContext.Provider value={value}>
      {children}
    </SmoothScrollContext.Provider>
  );
};

export default SmoothScrollProvider;
