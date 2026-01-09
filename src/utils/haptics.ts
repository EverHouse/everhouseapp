const prefersReducedMotion = () => {
  try {
    return typeof window !== 'undefined' && 
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const canVibrate = () => 
  typeof navigator !== 'undefined' && 'vibrate' in navigator;

export const haptic = {
  light: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate(10);
    }
  },
  medium: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate(15);
    }
  },
  heavy: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate(25);
    }
  },
  success: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate([10, 50, 10]);
    }
  },
  warning: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate([15, 30, 15, 30, 15]);
    }
  },
  error: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate([30, 50, 30]);
    }
  },
  selection: () => {
    if (canVibrate() && !prefersReducedMotion()) {
      navigator.vibrate(5);
    }
  }
};

export type HapticType = keyof typeof haptic;

export const triggerHaptic = (type: HapticType) => {
  haptic[type]?.();
};
