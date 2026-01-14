import { useCallback, useEffect, useRef } from 'react';

let lockCount = 0;
let savedScrollY = 0;
const lockOwners = new Set<string>();

function generateLockId(): string {
  return `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function applyScrollLock() {
  if (lockCount === 1) {
    const isAlreadyLocked = document.body.style.position === 'fixed';
    if (!isAlreadyLocked) {
      savedScrollY = window.scrollY;
    }
    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overscrollBehavior = 'none';
  }
}

function removeScrollLock() {
  if (lockCount === 0 && lockOwners.size === 0) {
    const scrollY = savedScrollY;
    document.documentElement.classList.remove('overflow-hidden');
    document.body.classList.remove('overflow-hidden');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.overscrollBehavior = '';
    window.scrollTo(0, scrollY);
  }
}

export function acquireScrollLock(ownerId?: string): string {
  const id = ownerId || generateLockId();
  
  // Skip if body is already fixed (nested modal scenario)
  const isAlreadyLocked = document.body.style.position === 'fixed';
  
  if (!lockOwners.has(id)) {
    lockOwners.add(id);
    lockCount++;
    // Only apply scroll lock if not already locked
    if (!isAlreadyLocked) {
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
  document.documentElement.classList.remove('overflow-hidden');
  document.body.classList.remove('overflow-hidden');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.overscrollBehavior = '';
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
    if (isLocked) {
      if (!lockIdRef.current) {
        lockIdRef.current = acquireScrollLock();
      }
    } else {
      if (lockIdRef.current) {
        releaseScrollLock(lockIdRef.current);
        lockIdRef.current = null;
      }
    }

    return () => {
      if (lockIdRef.current) {
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
      document.documentElement.classList.remove('overflow-hidden');
      document.body.classList.remove('overflow-hidden');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
    }
  });
  
  window.addEventListener('beforeunload', () => {
    if (lockOwners.size > 0) {
      forceReleaseAllLocks();
    }
  });
}
