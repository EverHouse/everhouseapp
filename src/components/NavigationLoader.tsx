import React from 'react';
import { useLocation } from 'react-router-dom';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { usePageReady } from '../contexts/PageReadyContext';
import WalkingGolferLoader from './WalkingGolferLoader';

const SAFETY_TIMEOUT_MS = 8000;

const NavigationLoader: React.FC = () => {
  const { isNavigating, endNavigation } = useNavigationLoading();
  const { isPageReady, resetPageReady } = usePageReady();
  const location = useLocation();
  const prevPathRef = React.useRef(location.pathname);
  const hasNavigatedRef = React.useRef(false);

  React.useEffect(() => {
    if (location.pathname !== prevPathRef.current) {
      prevPathRef.current = location.pathname;
      hasNavigatedRef.current = true;
      resetPageReady();
    }
  }, [location.pathname, resetPageReady]);

  React.useEffect(() => {
    if (isNavigating && hasNavigatedRef.current && isPageReady) {
      hasNavigatedRef.current = false;
      endNavigation();
    }
  }, [isNavigating, isPageReady, endNavigation]);

  React.useEffect(() => {
    if (isNavigating) {
      const safetyTimer = setTimeout(() => {
        hasNavigatedRef.current = false;
        endNavigation();
      }, SAFETY_TIMEOUT_MS);
      return () => clearTimeout(safetyTimer);
    }
  }, [isNavigating, endNavigation]);

  if (!isNavigating) return null;

  return (
    <WalkingGolferLoader 
      isVisible={isNavigating} 
      onFadeComplete={endNavigation}
    />
  );
};

export default NavigationLoader;
