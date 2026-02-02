import { useState, useCallback } from 'react';

interface UseAnimatedRemoveOptions {
  duration?: number;
  onRemove: () => void;
}

export const useAnimatedRemove = ({ duration = 350, onRemove }: UseAnimatedRemoveOptions) => {
  const [isRemoving, setIsRemoving] = useState(false);

  const triggerRemove = useCallback(() => {
    setIsRemoving(true);
    setTimeout(() => {
      onRemove();
    }, duration);
  }, [duration, onRemove]);

  return { isRemoving, triggerRemove };
};

export default useAnimatedRemove;
