import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface ThemeContextType {
  effectiveTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType>({
  effectiveTheme: 'dark'
});

export const useTheme = () => useContext(ThemeContext);

const getSystemPreference = (): 'light' | 'dark' => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const getDevPreviewThemeOverride = (): 'light' | 'dark' | null => {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  const href = window.location.href;
  const decodedHref = decodeURIComponent(href);
  
  if ((hash.includes('/dev-preview/') || decodedHref.includes('/dev-preview/')) && 
      (hash.includes('-dark') || decodedHref.includes('-dark'))) {
    return 'dark';
  }
  if ((hash.includes('/dev-preview/') || decodedHref.includes('/dev-preview/')) && 
      (hash.includes('-light') || decodedHref.includes('-light'))) {
    return 'light';
  }
  return null;
};

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => {
    const devOverride = getDevPreviewThemeOverride();
    return devOverride ?? getSystemPreference();
  });

  useEffect(() => {
    const devOverride = getDevPreviewThemeOverride();
    if (devOverride) {
      setEffectiveTheme(devOverride);
      return;
    }
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setEffectiveTheme(e.matches ? 'dark' : 'light');
    };
    
    setEffectiveTheme(mediaQuery.matches ? 'dark' : 'light');
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (effectiveTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [effectiveTheme]);

  return (
    <ThemeContext.Provider value={{ effectiveTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export default ThemeContext;
