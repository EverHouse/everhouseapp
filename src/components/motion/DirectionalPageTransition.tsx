import React, { createContext, useContext } from 'react';

export interface TransitionCustom {
  direction: number;
  distance: number;
}

const defaultCustom: TransitionCustom = { direction: 1, distance: 1 };

// eslint-disable-next-line react-refresh/only-export-components
export const TransitionContext = createContext<TransitionCustom>(defaultCustom);

// eslint-disable-next-line react-refresh/only-export-components
export const useTransitionState = () => useContext(TransitionContext);

const supportsViewTransitions = typeof document !== 'undefined' &&
  'startViewTransition' in document;

interface DirectionalPageTransitionProps {
  children: React.ReactNode;
}

const DirectionalPageTransition: React.FC<DirectionalPageTransitionProps> = ({ children }) => {
  return (
    <div className={supportsViewTransitions ? undefined : 'page-fade-in'} style={{ minHeight: '100%' }}>
      {children}
    </div>
  );
};

export default DirectionalPageTransition;
