import { useCallback, useMemo } from 'react';
import { haptic, type HapticType } from '../utils/haptics';

export function useHaptics() {
  const light = useCallback(() => haptic.light(), []);
  const medium = useCallback(() => haptic.medium(), []);
  const heavy = useCallback(() => haptic.heavy(), []);
  const success = useCallback(() => haptic.success(), []);
  const warning = useCallback(() => haptic.warning(), []);
  const error = useCallback(() => haptic.error(), []);
  const selection = useCallback(() => haptic.selection(), []);

  const trigger = useCallback((type: HapticType) => {
    haptic[type]?.();
  }, []);

  return useMemo(() => ({
    light,
    medium,
    heavy,
    success,
    warning,
    error,
    selection,
    trigger
  }), [light, medium, heavy, success, warning, error, selection, trigger]);
}

export default useHaptics;
