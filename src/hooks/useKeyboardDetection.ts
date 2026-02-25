import { useEffect } from 'react';

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useKeyboardDetection() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    const getHeight = () => viewport?.height ?? window.innerHeight;
    
    let baselineHeight = getHeight();
    let keyboardOpen = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let stabilizationTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHeight = baselineHeight;
    let stableHeightCount = 0;
    
    const THRESHOLD_RATIO = 0.22;
    const MIN_THRESHOLD_PX = 160;
    const STABLE_HEIGHT_CHECKS = 3;
    const STABILIZATION_INTERVAL_MS = 200;

    const evaluateKeyboardState = () => {
      const currentHeight = getHeight();
      const hasEditableFocus = isEditableElement(document.activeElement);
      const heightDiff = baselineHeight - currentHeight;
      const threshold = Math.max(MIN_THRESHOLD_PX, baselineHeight * THRESHOLD_RATIO);
      
      if (!hasEditableFocus) {
        if (keyboardOpen) {
          document.body.classList.remove('keyboard-open');
          keyboardOpen = false;
        }
        baselineHeight = currentHeight;
        lastHeight = currentHeight;
        stableHeightCount = 0;
        return;
      }

      if (heightDiff > threshold) {
        if (!keyboardOpen) {
          document.body.classList.add('keyboard-open');
          keyboardOpen = true;
        }
        stableHeightCount = 0;
      } else {
        if (keyboardOpen) {
          document.body.classList.remove('keyboard-open');
          keyboardOpen = false;
        }
        
        if (Math.abs(currentHeight - lastHeight) < 20) {
          stableHeightCount++;
          if (stableHeightCount >= STABLE_HEIGHT_CHECKS) {
            baselineHeight = currentHeight;
            stableHeightCount = 0;
          }
        } else {
          stableHeightCount = 0;
        }
      }
      
      lastHeight = currentHeight;
    };

    const debouncedEvaluate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(evaluateKeyboardState, 50);
    };

    const startStabilizationCheck = () => {
      if (stabilizationTimer) clearInterval(stabilizationTimer);
      stabilizationTimer = setInterval(evaluateKeyboardState, STABILIZATION_INTERVAL_MS);
    };

    const stopStabilizationCheck = () => {
      if (stabilizationTimer) {
        clearInterval(stabilizationTimer);
        stabilizationTimer = null;
      }
    };

    const handleResize = () => debouncedEvaluate();

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const handleFocusIn = () => {
      startStabilizationCheck();
      setTimeout(evaluateKeyboardState, 300);
      if (!isIOS) {
        setTimeout(() => {
          const el = document.activeElement;
          if (el && isEditableElement(el) && 'scrollIntoView' in el) {
            (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }, 400);
      }
    };

    const handleFocusOut = () => {
      setTimeout(() => {
        if (!isEditableElement(document.activeElement)) {
          stopStabilizationCheck();
          document.body.classList.remove('keyboard-open');
          keyboardOpen = false;
          baselineHeight = getHeight();
          stableHeightCount = 0;
        }
      }, 100);
    };

    const handleOrientationChange = () => {
      stopStabilizationCheck();
      document.body.classList.remove('keyboard-open');
      keyboardOpen = false;
      stableHeightCount = 0;
      setTimeout(() => {
        baselineHeight = getHeight();
        lastHeight = baselineHeight;
      }, 300);
    };

    if (viewport) {
      viewport.addEventListener('resize', handleResize);
    } else {
      window.addEventListener('resize', handleResize);
    }
    
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('orientationchange', handleOrientationChange);

    return () => {
      if (viewport) {
        viewport.removeEventListener('resize', handleResize);
      } else {
        window.removeEventListener('resize', handleResize);
      }
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.body.classList.remove('keyboard-open');
      if (debounceTimer) clearTimeout(debounceTimer);
      stopStabilizationCheck();
    };
  }, []);
}
