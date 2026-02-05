import { Appearance } from '@stripe/stripe-js';

export function getStripeAppearance(isDark: boolean): Appearance {
  if (isDark) {
    return {
      theme: 'night',
      variables: {
        colorPrimary: '#5fa36b',
        colorBackground: '#1a1d12',
        colorText: '#ffffff',
        colorTextSecondary: '#a3a3a3',
        colorDanger: '#ff6b6b',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
        colorIcon: '#5fa36b',
      },
      rules: {
        '.Label': {
          color: '#e5e5e5',
        },
        '.Input': {
          backgroundColor: '#262a1c',
          borderColor: '#3d4230',
          color: '#ffffff',
        },
        '.Input:focus': {
          borderColor: '#5fa36b',
        },
        '.Tab': {
          backgroundColor: '#262a1c',
          borderColor: '#3d4230',
          color: '#e5e5e5',
        },
        '.Tab--selected': {
          backgroundColor: '#1a1d12',
          borderColor: '#5fa36b',
          color: '#ffffff',
        },
        '.TabIcon': {
          color: '#a3a3a3',
        },
        '.TabIcon--selected': {
          color: '#5fa36b',
        },
      },
    };
  }
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: '#31543C',
      colorBackground: '#ffffff',
      colorText: '#31543C',
      colorDanger: '#df1b41',
      fontFamily: 'system-ui, sans-serif',
      borderRadius: '8px',
    },
  };
}
