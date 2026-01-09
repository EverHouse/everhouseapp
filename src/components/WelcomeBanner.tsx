import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../contexts/DataContext';
import { useTheme } from '../contexts/ThemeContext';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const WelcomeBanner: React.FC = () => {
  const { user } = useData();
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const [dismissed, setDismissed] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [showIOSModal, setShowIOSModal] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isInStandaloneMode = (window.navigator as any).standalone === true || 
    window.matchMedia('(display-mode: standalone)').matches;

  useEffect(() => {
    if (!user?.email) return;
    const key = `eh_welcome_dismissed_${user.email}`;
    const wasDismissed = localStorage.getItem(key);
    if (!wasDismissed) {
      setIsNew(true);
    }
  }, [user?.email]);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallClick = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }

    if (isIOS) {
      setShowIOSModal(true);
      return;
    }
    
    if (deferredPromptRef.current) {
      await deferredPromptRef.current.prompt();
      const { outcome } = await deferredPromptRef.current.userChoice;
      if (outcome === 'accepted') {
        deferredPromptRef.current = null;
      }
    } else {
      setShowIOSModal(true);
    }
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (user?.email) {
      localStorage.setItem(`eh_welcome_dismissed_${user.email}`, 'true');
    }
    setDismissed(true);
  };

  if (dismissed || !isNew || !user || isInStandaloneMode) return null;

  return (
    <>
      <div 
        onClick={() => handleInstallClick()}
        className={`mb-6 py-2 px-4 rounded-xl flex items-center justify-between gap-3 cursor-pointer transition-transform active:scale-[0.98] ${
          isDark ? 'bg-accent text-brand-green' : 'bg-brand-green text-white'
        }`}
      >
        <div className="flex items-center gap-3 overflow-hidden">
          <span className="material-symbols-outlined text-xl flex-shrink-0">install_mobile</span>
          <span className="text-sm font-bold truncate">
            Add to Home Screen for the best experience
          </span>
        </div>
        
        <button 
          onClick={handleDismiss}
          className={`p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-full transition-colors flex-shrink-0 ${
            isDark ? 'hover:bg-black/10 text-brand-green/70 hover:text-brand-green' : 'hover:bg-white/10 text-white/70 hover:text-white'
          }`}
          aria-label="Dismiss banner"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
        </button>
      </div>

      {showIOSModal && (
        <IOSModal isDark={isDark} onClose={() => setShowIOSModal(false)} />
      )}
    </>
  );
};

const IOSModal: React.FC<{ isDark: boolean; onClose: () => void }> = ({ isDark, onClose }) => {
  useEffect(() => {
    document.documentElement.classList.add('overflow-hidden');
    return () => {
      document.documentElement.classList.remove('overflow-hidden');
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`w-full max-w-sm p-6 rounded-3xl ${isDark ? 'bg-[#1a1a1a]' : 'bg-white'} shadow-2xl`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-brand-green'}`}>
            Add to Home Screen
          </h3>
          <button 
            onClick={onClose}
            className={`p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full ${isDark ? 'text-white/70 hover:text-white' : 'text-gray-500 hover:text-gray-700'}`}
            aria-label="Close install instructions"
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        
        <div className={`${isDark ? 'text-white/80' : 'text-gray-600'}`}>
          <p className="text-sm mb-4">
            Use your browser's menu to add this app to your home screen to receive push notifications regarding your bookings.
          </p>
          
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <span className="text-xs font-bold">1</span>
              </div>
              <p className="text-sm pt-0.5">
                Tap the <strong>Share</strong> button at the bottom of the screen.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <span className="text-xs font-bold">2</span>
              </div>
              <p className="text-sm pt-0.5">
                Scroll down and tap <strong>"Add to Home Screen"</strong>.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <span className="text-xs font-bold">3</span>
              </div>
              <p className="text-sm pt-0.5">
                Turn on the <strong>"Open as Web App"</strong> toggle.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <span className="text-xs font-bold">4</span>
              </div>
              <p className="text-sm pt-0.5">
                Tap <strong>"Add"</strong> to place the icon on your Home Screen.
              </p>
            </div>
          </div>
          
          <p className={`text-sm mt-4 ${isDark ? 'text-accent' : 'text-brand-green'}`}>
            Don't forget to enable push notifications in your profile settings (top right icon)!
          </p>
        </div>
        
        <a
          href="https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios"
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className={`w-full mt-6 py-3 rounded-xl font-bold text-center block ${isDark ? 'bg-accent text-brand-green' : 'bg-brand-green text-white'}`}
        >
          View Full Instructions
        </a>
      </div>
    </div>,
    document.body
  );
};

export default WelcomeBanner;
