import { useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';

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
  hideTitleBorder = false
}: ModalShellProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!isOpen) return;

    previousActiveElement.current = document.activeElement as HTMLElement;
    
    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissibleRef.current) {
        onCloseRef.current();
      }
    };
    
    // Save current scroll position
    const scrollY = window.scrollY;
    
    document.addEventListener('keydown', handleEscapeKey);
    
    // Lock body scroll - more robust approach for iOS
    document.documentElement.classList.add('overflow-hidden');
    document.body.classList.add('overflow-hidden');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overscrollBehavior = 'none';
    
    // Track modal open state for PullToRefresh
    const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
    document.body.setAttribute('data-modal-count', String(currentCount + 1));
    
    setTimeout(() => {
      modalRef.current?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', handleEscapeKey);
      
      // Decrement modal count for PullToRefresh
      const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
      if (currentCount <= 1) {
        document.body.removeAttribute('data-modal-count');
      } else {
        document.body.setAttribute('data-modal-count', String(currentCount - 1));
      }
      
      // Restore scroll position
      document.documentElement.classList.remove('overflow-hidden');
      document.body.classList.remove('overflow-hidden');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overscrollBehavior = '';
      
      // Restore scroll position after removing fixed positioning
      window.scrollTo(0, scrollY);
      
      if (previousActiveElement.current) {
        previousActiveElement.current.focus();
        previousActiveElement.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const modalContent = (
    <div 
      className={`fixed inset-0 ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain', touchAction: 'none', zIndex: 'var(--z-modal)' }}
    >
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
        style={{ touchAction: 'none' }}
      />
      
      <div 
        className="fixed inset-0 overflow-y-auto"
        style={{ overscrollBehavior: 'contain' }}
        onClick={(e) => {
          if (dismissible && e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <div 
          className="flex min-h-full items-center justify-center p-4"
          onClick={(e) => {
            if (dismissible && e.target === e.currentTarget) {
              onClose();
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
            className={`relative w-full ${sizeClasses[size]} ${isDark ? 'bg-[#1a1d15] border-white/10' : 'bg-white border-gray-200'} rounded-2xl shadow-2xl border ${className}`}
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
                    onClick={onClose}
                    className={`p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
                    aria-label="Close modal"
                  >
                    <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
                  </button>
                )}
              </div>
            )}
            
            <div 
              className={`overflow-y-auto overflow-x-hidden ${title || showCloseButton ? 'max-h-[calc(100dvh-180px)]' : 'max-h-[calc(100dvh-100px)]'}`}
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
