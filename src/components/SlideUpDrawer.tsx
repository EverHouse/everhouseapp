import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useScrollLockManager } from '../hooks/useScrollLockManager';

const BASE_DRAWER_Z_INDEX = 10000;
const Z_INDEX_INCREMENT = 10;
const DRAG_THRESHOLD = 100;
const VELOCITY_THRESHOLD = 0.5;

interface SlideUpDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  showCloseButton?: boolean;
  dismissible?: boolean;
  maxHeight?: 'full' | 'large' | 'medium' | 'small';
  className?: string;
  hideHandle?: boolean;
  stickyFooter?: ReactNode;
  onContentScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

const maxHeightClasses = {
  full: 'max-h-[95dvh]',
  large: 'max-h-[85dvh]',
  medium: 'max-h-[70dvh]',
  small: 'max-h-[50dvh]'
};

export function SlideUpDrawer({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true,
  dismissible = true,
  maxHeight = 'large',
  className = '',
  hideHandle = false,
  stickyFooter,
  onContentScroll
}: SlideUpDrawerProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const drawerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const [drawerZIndex, setDrawerZIndex] = useState(BASE_DRAWER_Z_INDEX);
  const [isClosing, setIsClosing] = useState(false);
  
  const [dragState, setDragState] = useState({
    isDragging: false,
    startY: 0,
    currentY: 0,
    startTime: 0
  });

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useScrollLockManager(isOpen, dismissible ? onClose : undefined);

  useEffect(() => {
    if (!isOpen) {
      setIsClosing(false);
      return;
    }

    previousActiveElement.current = document.activeElement as HTMLElement;
    
    const currentCount = parseInt(document.body.getAttribute('data-modal-count') || '0', 10);
    const newZIndex = BASE_DRAWER_Z_INDEX + (currentCount * Z_INDEX_INCREMENT);
    setDrawerZIndex(newZIndex);
    document.body.setAttribute('data-modal-count', String(currentCount + 1));
    
    setTimeout(() => {
      drawerRef.current?.focus();
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

  const handleClose = useCallback(() => {
    if (!dismissible) return;
    setIsClosing(true);
    setTimeout(() => {
      onCloseRef.current();
    }, 250);
  }, [dismissible]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!dismissible) return;
    
    const contentEl = contentRef.current;
    if (contentEl && contentEl.scrollTop > 0) {
      return;
    }
    
    setDragState({
      isDragging: true,
      startY: e.touches[0].clientY,
      currentY: e.touches[0].clientY,
      startTime: Date.now()
    });
  }, [dismissible]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragState.isDragging) return;
    
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - dragState.startY;
    
    if (deltaY > 0) {
      setDragState(prev => ({ ...prev, currentY }));
    }
  }, [dragState.isDragging, dragState.startY]);

  const handleTouchEnd = useCallback(() => {
    if (!dragState.isDragging) return;
    
    const deltaY = dragState.currentY - dragState.startY;
    const deltaTime = Date.now() - dragState.startTime;
    const velocity = deltaY / deltaTime;
    
    if (deltaY > DRAG_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
      handleClose();
    }
    
    setDragState({
      isDragging: false,
      startY: 0,
      currentY: 0,
      startTime: 0
    });
  }, [dragState, handleClose]);

  const dragOffset = dragState.isDragging 
    ? Math.max(0, dragState.currentY - dragState.startY) 
    : 0;

  if (!isOpen) return null;

  const drawerContent = (
    <div 
      className={`fixed inset-0 ${isDark ? 'dark' : ''}`}
      style={{ overscrollBehavior: 'contain', touchAction: 'none', zIndex: drawerZIndex }}
    >
      <div 
        className={`fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-normal ${isClosing ? 'opacity-0' : 'animate-backdrop-fade-in'}`}
        aria-hidden="true"
        style={{ touchAction: 'none' }}
        onClick={dismissible ? handleClose : undefined}
      />
      {/* DEBUG: Red line at fixed bottom:0 to test where viewport ends */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: '3px', background: 'red', zIndex: 999999, pointerEvents: 'none' }} />
      {/* DEBUG: Blue line at -34px from bottom to test safe area */}
      <div style={{ position: 'fixed', bottom: '-34px', left: 0, right: 0, height: '3px', background: 'blue', zIndex: 999999, pointerEvents: 'none' }} />
      {/* DEBUG: Green line at bottom of screen via 100dvh */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: '100dvh', borderBottom: '3px solid lime', zIndex: 999999, pointerEvents: 'none' }} />
      {/* DEBUG: Info overlay */}
      <div style={{ position: 'fixed', top: '60px', left: '10px', background: 'rgba(0,0,0,0.85)', color: '#0f0', fontSize: '11px', padding: '8px', borderRadius: '8px', zIndex: 999999, fontFamily: 'monospace', lineHeight: '1.5', pointerEvents: 'none', maxWidth: '280px' }}
        ref={(el) => {
          if (el) {
            const update = () => {
              const vv = window.visualViewport;
              const body = document.body;
              const html = document.documentElement;
              const bodyCS = window.getComputedStyle(body);
              const htmlCS = window.getComputedStyle(html);
              const wrapper = el.parentElement;
              const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
              el.textContent = [
                `innerH: ${window.innerHeight}`,
                `screen.h: ${window.screen.height}`,
                `vv.h: ${vv?.height} vv.top: ${vv?.offsetTop}`,
                `body.pos: ${bodyCS.position}`,
                `body.top: ${bodyCS.top}`,
                `body.h: ${body.getBoundingClientRect().height}`,
                `html.h: ${html.getBoundingClientRect().height}`,
                `html.bg: ${htmlCS.backgroundColor}`,
                `html.overflow: ${htmlCS.overflow}`,
                `wrapper.h: ${wrapperRect?.height}`,
                `wrapper.bottom: ${wrapperRect?.bottom}`,
                `dvh test: ${CSS.supports('height', '100dvh')}`,
              ].join('\n');
            };
            update();
            setTimeout(update, 500);
          }
        }}
      />
      
      <div 
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'drawer-title' : undefined}
        tabIndex={-1}
        className={`fixed inset-x-0 bottom-0 flex flex-col ${maxHeightClasses[maxHeight]} ${isDark ? 'bg-[#1a1d15]' : 'bg-white'} rounded-t-3xl shadow-2xl transition-transform duration-normal ease-spring-smooth ${isClosing ? 'translate-y-full' : 'animate-slide-up-drawer'} ${className}`}
        style={{
          transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragState.isDragging ? 'none' : undefined
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {!hideHandle && (
          <div className="flex justify-center pt-3 pb-1 cursor-grab active:cursor-grabbing">
            <div className={`w-10 h-1 rounded-full ${isDark ? 'bg-white/20' : 'bg-gray-300'}`} />
          </div>
        )}
        
        {(title || showCloseButton) && (
          <div className={`flex items-center justify-between px-5 py-3 border-b ${isDark ? 'border-white/10' : 'border-gray-200'} shrink-0`}>
            {title ? (
              <h3 
                id="drawer-title"
                className={`text-xl font-bold ${isDark ? 'text-white' : 'text-primary'}`}
              >
                {title}
              </h3>
            ) : <div />}
            {showCloseButton && (
              <button
                onClick={handleClose}
                className={`p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'}`}
                aria-label="Close drawer"
              >
                <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
              </button>
            )}
          </div>
        )}
        
        <div 
          ref={contentRef}
          className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
          data-scroll-lock-allow=""
          style={{ 
            WebkitOverflowScrolling: 'touch', 
            touchAction: 'pan-y',
            overscrollBehavior: 'contain',
            paddingBottom: stickyFooter ? undefined : 'env(safe-area-inset-bottom, 0px)'
          }}
          onScroll={onContentScroll}
        >
          {children}
        </div>
        
        {stickyFooter && (
          <div 
            className={`shrink-0 border-t ${isDark ? 'border-white/10 bg-[#1a1d15]' : 'border-gray-200 bg-white'}`}
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            {stickyFooter}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(drawerContent, document.body);
}

export default SlideUpDrawer;
