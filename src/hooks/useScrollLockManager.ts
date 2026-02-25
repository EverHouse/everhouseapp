import { useCallback, useEffect, useRef } from 'react';

let lockCount = 0;
let savedScrollY = 0;
const lockOwners = new Set<string>();

function generateLockId(): string {
  return `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function isScrollableElement(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const hasScrollableOverflow =
    overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  return hasScrollableOverflow && el.scrollHeight > el.clientHeight;
}

function preventTouchMove(e: TouchEvent) {
  if (!(e.target instanceof HTMLElement)) {
    e.preventDefault();
    return;
  }

  let el: HTMLElement | null = e.target;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.hasAttribute('data-scroll-lock-allow')) return;

    if (isScrollableElement(el)) return;

    el = el.parentElement;
  }

  e.preventDefault();
}

function applyScrollLock() {
  console.log('[ScrollLock] applyScrollLock called, lockCount:', lockCount, 'owners:', lockOwners.size);
  if (lockCount === 1) {
    savedScrollY = window.scrollY;
    document.documentElement.style.setProperty('background-color', '#262626', 'important');
    document.body.style.setProperty('background-color', '#262626', 'important');
    document.documentElement.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.bottom = '0';
    document.body.style.width = '100%';
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.overscrollBehavior = 'none';
    document.addEventListener('touchmove', preventTouchMove, { passive: false });
    console.log('[ScrollLock] APPLIED — body.position:', document.body.style.position, 'html.bg:', document.documentElement.style.backgroundColor);
  } else {
    console.log('[ScrollLock] SKIPPED — lockCount is not 1');
  }
}

function removeScrollLock() {
  if (lockCount === 0 && lockOwners.size === 0) {
    const scrollY = savedScrollY;
    document.documentElement.style.removeProperty('background-color');
    document.body.style.removeProperty('background-color');
    document.documentElement.classList.remove('overflow-hidden');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.bottom = '';
    document.body.style.width = '';
    document.documentElement.style.overscrollBehavior = '';
    document.body.style.overscrollBehavior = '';
    document.removeEventListener('touchmove', preventTouchMove);
    window.scrollTo(0, scrollY);
  }
}

export function acquireScrollLock(ownerId?: string): string {
  const id = ownerId || generateLockId();
  console.log('[ScrollLock] acquireScrollLock called, id:', id, 'already owned:', lockOwners.has(id), 'lockCount:', lockCount);

  if (!lockOwners.has(id)) {
    lockOwners.add(id);
    lockCount++;
    if (lockCount === 1) {
      applyScrollLock();
    }
  }
  return id;
}

export function releaseScrollLock(id: string): void {
  if (lockOwners.has(id)) {
    lockOwners.delete(id);
    lockCount = Math.max(0, lockCount - 1);
    removeScrollLock();
  }
}

export function forceReleaseAllLocks(): void {
  lockOwners.clear();
  lockCount = 0;
  const scrollY = savedScrollY;
  document.documentElement.style.removeProperty('background-color');
  document.body.style.removeProperty('background-color');
  document.documentElement.classList.remove('overflow-hidden');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.bottom = '';
  document.body.style.width = '';
  document.documentElement.style.overscrollBehavior = '';
  document.body.style.overscrollBehavior = '';
  document.removeEventListener('touchmove', preventTouchMove);
  window.scrollTo(0, scrollY);
}

export function getActiveLockCount(): number {
  return lockCount;
}

export function hasActiveLocks(): boolean {
  return lockOwners.size > 0;
}

export function useScrollLockManager(isLocked: boolean, onEscape?: () => void) {
  const lockIdRef = useRef<string | null>(null);

  useEffect(() => {
    console.log('[ScrollLock] useScrollLockManager effect, isLocked:', isLocked, 'currentLockId:', lockIdRef.current);
    if (isLocked) {
      if (!lockIdRef.current) {
        lockIdRef.current = acquireScrollLock();
        console.log('[ScrollLock] Lock acquired:', lockIdRef.current);
      }
    } else {
      if (lockIdRef.current) {
        console.log('[ScrollLock] Releasing lock:', lockIdRef.current);
        releaseScrollLock(lockIdRef.current);
        lockIdRef.current = null;
      }
    }

    return () => {
      if (lockIdRef.current) {
        console.log('[ScrollLock] Cleanup releasing lock:', lockIdRef.current);
        releaseScrollLock(lockIdRef.current);
        lockIdRef.current = null;
      }
    };
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked || !onEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscape();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isLocked, onEscape]);
}

export function useScrollLockControl() {
  const lockIdRef = useRef<string | null>(null);

  const lock = useCallback(() => {
    if (!lockIdRef.current) {
      lockIdRef.current = acquireScrollLock();
    }
  }, []);

  const unlock = useCallback(() => {
    if (lockIdRef.current) {
      releaseScrollLock(lockIdRef.current);
      lockIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (lockIdRef.current) {
        releaseScrollLock(lockIdRef.current);
        lockIdRef.current = null;
      }
    };
  }, []);

  return { lock, unlock };
}

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lockCount === 0 && lockOwners.size === 0) {
      document.documentElement.style.removeProperty('background-color');
      document.body.style.removeProperty('background-color');
      document.documentElement.classList.remove('overflow-hidden');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.bottom = '';
      document.body.style.width = '';
      document.documentElement.style.overscrollBehavior = '';
      document.body.style.overscrollBehavior = '';
      document.removeEventListener('touchmove', preventTouchMove);
    }
  });

  window.addEventListener('beforeunload', () => {
    if (lockOwners.size > 0) {
      forceReleaseAllLocks();
    }
  });
}
