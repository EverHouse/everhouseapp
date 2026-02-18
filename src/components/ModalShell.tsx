import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';

const BASE_MODAL_Z_INDEX = 10000;
const Z_INDEX_INCREMENT = 10;

interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  showCloseButton?: boolean;
  dismissible?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  hideTitleBorder?: boolean;
  overflowVisible?: boolean;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl'
};

export function ModalShell({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true,
  dismissible = true,
  size = 'md',
  className = '',
  hideTitleBorder = false,
  overflowVisible = false
}: ModalShellProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const [modalZIndex, setModalZIndex] = useState(BASE_MODAL_Z_INDEX);
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      onCloseRef.current();
    }, 250);
  }, [isClosing]);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useScrollLockManager(isOpen, dismissible ? handleClose : undefined);

  useEffect(() => {
    if (!isOpen) {
      setIsClosing(false);
      return;
    }

    previousActiveElement.current = document.activeElement as HTMLElement;
    
    const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
    const newZIndex = BASE_MODAL_Z_INDEX + (currentCount * Z_INDEX_INCREMENT);
    setModalZIndex(newZIndex);
    document.body.setAttribute('data-modal-count', String(currentCount + 1));
    
    setTimeout(() => {
      modalRef.current?.focus();
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

  if (!isOpen && !isClosing) return null;

  const modalContent = (
    <div 
      className={`fixed inset-0 ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain', touchAction: 'none', zIndex: modalZIndex, height: '100dvh' }}
    >
      <div 
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-normal ${isClosing ? 'opacity-0' : 'animate-backdrop-fade-in'}`}
        aria-hidden="true"
        style={{ touchAction: 'none', height: '100dvh' }}
      />
      
      <div 
        className="fixed inset-0 overflow-y-auto"
        style={{ overscrollBehavior: 'contain', height: '100dvh' }}
        onClick={(e) => {
          if (dismissible && e.target === e.currentTarget) {
            handleClose();
          }
        }}
      >
        <div 
          className="flex min-h-full items-center justify-center p-4"
          onClick={(e) => {
            if (dismissible && e.target === e.currentTarget) {
              handleClose();
            }
          }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full ${sizeClasses[size]} ${isDark ? 'bg-[#1a1d15] border-white/10' : 'bg-white border-gray-200'} rounded-2xl shadow-2xl border transform transition-all duration-normal ease-spring-smooth ${isClosing ? 'scale-95 opacity-0' : 'animate-modal-slide-up'} ${className}`}
          >
            {(title || showCloseButton) && (
              <div className={`flex items-center justify-between p-4 ${hideTitleBorder ? '' : `border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}`}>
                {title && (
                  <h3 
                    id="modal-title"
                    className={`text-xl font-bold ${isDark ? 'text-white' : 'text-primary'}`}
                  >
                    {title}
                  </h3>
                )}
                {showCloseButton && (
                  <button
                    onClick={handleClose}
                    className={`p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
                    aria-label="Close modal"
                  >
                    <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
                  </button>
                )}
              </div>
            )}
            
            <div 
              className={`modal-keyboard-aware ${overflowVisible ? 'overflow-visible' : 'overflow-y-auto overflow-x-hidden'} max-h-[85dvh]`}
              style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', overscrollBehavior: 'contain' }}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

export default ModalShell;
