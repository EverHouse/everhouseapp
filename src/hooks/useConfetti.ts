import { useState, useCallback } from 'react';

export const useConfetti = () => {
  const [isActive, setIsActive] = useState(false);

  const trigger = useCallback(() => {
    setIsActive(true);
  }, []);

  const onComplete = useCallback(() => {
    setIsActive(false);
  }, []);

  return { isActive, trigger, onComplete };
};

export default useConfetti;
