import React, { createContext, useContext } from 'react';

export interface TransitionCustom {
  direction: number;
  distance: number;
}

const defaultCustom: TransitionCustom = { direction: 1, distance: 1 };

export const TransitionContext = createContext<TransitionCustom>(defaultCustom);

export const useTransitionState = () => useContext(TransitionContext);

interface DirectionalPageTransitionProps {
  children: React.ReactNode;
}

const DirectionalPageTransition: React.FC<DirectionalPageTransitionProps> = ({ children }) => {
  return (
    <div className="page-fade-in" style={{ minHeight: '100%' }}>
      {children}
    </div>
  );
};

export default DirectionalPageTransition;
