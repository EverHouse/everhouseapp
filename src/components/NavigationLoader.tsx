import React from 'react';
import { useLocation } from 'react-router-dom';
import { useNavigationLoading } from '../contexts/NavigationLoadingContext';
import { usePageReady } from '../contexts/PageReadyContext';
import WalkingGolferLoader from './WalkingGolferLoader';

const SAFETY_TIMEOUT_MS = 8000;

const NavigationLoader: React.FC = () => {
  return null;
};

export default NavigationLoader;
