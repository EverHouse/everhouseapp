import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';

const BASE_DIALOG_Z_INDEX = 10100;
const Z_INDEX_INCREMENT = 10;

type DialogVariant = 'danger' | 'warning' | 'info';

interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: DialogVariant;
  isLoading?: boolean;
}

interface ConfirmDialogState extends ConfirmDialogOptions {
  isOpen: boolean;
  resolve: ((value: boolean) => void) | null;
}

const variantStyles = {
  danger: {
    light: 'bg-red-500/15 text-red-600 hover:bg-red-500/25',
    dark: 'bg-red-500/20 text-red-400 hover:bg-red-500/30',
    icon: 'error',
    iconColor: 'text-red-500',
    spinnerBorder: 'border-red-600/30 border-t-red-600 dark:border-red-400/30 dark:border-t-red-400'
  },
  warning: {
    light: 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25',
    dark: 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30',
    icon: 'warning',
    iconColor: 'text-amber-500',
    spinnerBorder: 'border-amber-600/30 border-t-amber-600 dark:border-amber-400/30 dark:border-t-amber-400'
  },
  info: {
    light: 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25',
    dark: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30',
    icon: 'info',
    iconColor: 'text-blue-500',
    spinnerBorder: 'border-blue-600/30 border-t-blue-600 dark:border-blue-400/30 dark:border-t-blue-400'
  }
};

function ConfirmDialogComponent({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  isLoading = false,
  onConfirm,
  onCancel
}: ConfirmDialogOptions & {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const [dialogZIndex, setDialogZIndex] = useState(BASE_DIALOG_Z_INDEX);
  const [isClosing, setIsClosing] = useState(false);

  useScrollLockManager(isOpen, onCancel);

  useEffect(() => {
    if (!isOpen) {
      setIsClosing(false);
      return;
    }

    previousActiveElement.current = document.activeElement as HTMLElement;

    const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
    const newZIndex = BASE_DIALOG_Z_INDEX + (currentCount * Z_INDEX_INCREMENT);
    setDialogZIndex(newZIndex);
    document.body.setAttribute('data-modal-count', String(currentCount + 1));

    setTimeout(() => {
      confirmButtonRef.current?.focus();
    }, 50);

    return () => {
      const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
      if (currentCount <= 1) {
        document.body.removeAttribute('data-modal-count');
      } else {
        document.body.setAttribute('data-modal-count', String(currentCount - 1));
      }

      if (previousActiveElement.current) {
        previousActiveElement.current.focus();
        previousActiveElement.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isLoading) return;
      
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Tab') {
        const focusableSelectors = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelectors);
        if (!focusableElements || focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading]);

  const handleConfirm = useCallback(() => {
    if (isLoading) return;
    setIsClosing(true);
    setTimeout(() => {
      onConfirm();
    }, 250);
  }, [isLoading, onConfirm]);

  const handleCancel = useCallback(() => {
    if (isLoading) return;
    setIsClosing(true);
    setTimeout(() => {
      onCancel();
    }, 250);
  }, [isLoading, onCancel]);

  if (!isOpen) return null;

  const variantConfig = variantStyles[variant];

  const dialogContent = (
    <div
      className={`fixed inset-0 ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain', touchAction: 'none', zIndex: dialogZIndex, height: '100dvh' }}
    >
      <div
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-normal ${
          isClosing ? 'opacity-0' : 'animate-backdrop-fade-in'
        }`}
        aria-hidden="true"
        style={{ touchAction: 'none', height: '100dvh' }}
        onClick={!isLoading ? handleCancel : undefined}
      />

      <div
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ overscrollBehavior: 'contain', height: '100dvh' }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-message"
          className={`relative w-full max-w-sm transform transition-all duration-normal ease-spring-smooth ${
            isClosing ? 'scale-95 opacity-0' : 'animate-modal-slide-up'
          }`}
        >
          <div
            className={`
              rounded-xl p-6 shadow-2xl
              backdrop-blur-xl backdrop-saturate-150
              ${isDark 
                ? 'bg-[#1a1d15]/90 border border-white/10 shadow-black/50' 
                : 'bg-white/90 border border-white/20 shadow-gray-900/20'
              }
            `}
          >
            <div className="flex flex-col items-center text-center">
              <div className={`mb-4 p-3 rounded-full ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                <span 
                  className={`material-symbols-outlined text-3xl ${variantConfig.iconColor}`}
                  aria-hidden="true"
                >
                  {variantConfig.icon}
                </span>
              </div>

              <h2
                id="confirm-dialog-title"
                className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}
              >
                {title}
              </h2>

              <p
                id="confirm-dialog-message"
                className={`text-sm mb-6 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}
              >
                {message}
              </p>

              <div className="flex w-full gap-3">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isLoading}
                  className={`
                    flex-1 px-4 py-3 rounded-xl font-medium text-sm
                    transition-all duration-fast ease-out
                    disabled:opacity-50 disabled:cursor-not-allowed tactile-btn
                    ${isDark 
                      ? 'text-white/70 hover:bg-white/5 active:bg-white/10' 
                      : 'text-primary/70 hover:bg-primary/5 active:bg-primary/10'
                    }
                  `}
                >
                  {cancelText}
                </button>

                <button
                  ref={confirmButtonRef}
                  type="button"
                  onClick={handleConfirm}
                  disabled={isLoading}
                  className={`
                    flex-1 px-4 py-3 rounded-xl font-medium text-sm
                    transition-all duration-fast ease-out
                    disabled:opacity-70 disabled:cursor-not-allowed tactile-btn
                    ${isDark ? variantConfig.dark : variantConfig.light}
                    flex items-center justify-center gap-2
                  `}
                >
                  {isLoading ? (
                    <>
                      <span className={`w-4 h-4 border-2 rounded-full animate-spin ${variantConfig.spinnerBorder}`} />
                      <span>Loading...</span>
                    </>
                  ) : (
                    confirmText
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialogContent, document.body);
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    variant: 'info',
    isLoading: false,
    resolve: null
  });

  const confirm = useCallback((options: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        title: options.title,
        message: options.message,
        confirmText: options.confirmText || 'Confirm',
        cancelText: options.cancelText || 'Cancel',
        variant: options.variant || 'info',
        isLoading: options.isLoading || false,
        resolve
      });
    });
  }, []);

  const setLoading = useCallback((isLoading: boolean) => {
    setState(prev => ({ ...prev, isLoading }));
  }, []);

  const handleConfirm = useCallback(() => {
    state.resolve?.(true);
    setState(prev => ({ ...prev, isOpen: false, resolve: null }));
  }, [state.resolve]);

  const handleCancel = useCallback(() => {
    state.resolve?.(false);
    setState(prev => ({ ...prev, isOpen: false, resolve: null }));
  }, [state.resolve]);

  const ConfirmDialogPortal = useCallback(() => (
    <ConfirmDialogComponent
      isOpen={state.isOpen}
      title={state.title}
      message={state.message}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      variant={state.variant}
      isLoading={state.isLoading}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ), [state, handleConfirm, handleCancel]);

  return {
    confirm,
    setLoading,
    ConfirmDialogComponent: ConfirmDialogPortal
  };
}

export default ConfirmDialogComponent;
