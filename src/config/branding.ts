export const BRAND = {
  name: 'Ever Club',
  legalName: 'Ever Members Club',
  tagline: 'A new kind of members club — rooted in golf, built for community.',
  
  logos: {
    monogram: {
      dark: '/images/everclub-logo-dark.webp',
      white: '/images/everclub-logo-light.webp',
    },
    mascot: {
      dark: '/assets/logos/mascot-dark.webp',
      white: '/assets/logos/mascot-white.webp',
    },
    wordmark: {
      dark: '/images/everclub-logo-dark.webp',
      white: '/images/everclub-logo-light.webp',
    },
  },
  
  colors: {
    primary: '#293515',
    accent: '#C4A962',
    background: {
      light: '#F2F2EC',
      dark: '#0f120a',
    },
  },
};

export type LogoType = 'monogram' | 'mascot' | 'wordmark';
export type LogoVariant = 'dark' | 'white';

export function getLogo(type: LogoType, variant: LogoVariant): string {
  return BRAND.logos[type][variant];
}

export function getLogoForContext(options: {
  isMemberRoute: boolean;
  isDarkBackground: boolean;
}): string {
  const { isMemberRoute, isDarkBackground } = options;
  const type: LogoType = isMemberRoute ? 'mascot' : 'wordmark';
  const variant: LogoVariant = isDarkBackground ? 'white' : 'dark';
  return getLogo(type, variant);
}
