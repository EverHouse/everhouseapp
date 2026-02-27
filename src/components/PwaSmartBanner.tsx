import React, { useState, useEffect, useRef } from 'react';

interface PwaSmartBannerProps {
  appName?: string;
  appDescription?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const PwaSmartBanner: React.FC<PwaSmartBannerProps> = ({
  appName = 'Ever Club',
  appDescription = 'Golf, Wellness & Community'
}) => {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;

    if (isStandalone) return;

    const wasDismissed = sessionStorage.getItem('pwa_banner_dismissed');
    if (wasDismissed) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isIOS) {
      setPlatform('ios');
      setShow(true);
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setPlatform('android');
      setShow(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('pwa_banner_dismissed', '1');
    setTimeout(() => setShow(false), 300);
  };

  const handleAction = async () => {
    if (platform === 'android' && deferredPromptRef.current) {
      await deferredPromptRef.current.prompt();
      const { outcome } = await deferredPromptRef.current.userChoice;
      deferredPromptRef.current = null;
      if (outcome === 'accepted') {
        handleDismiss();
      }
      return;
    }

    const currentUrl = window.location.origin + '/dashboard';
    window.location.href = currentUrl;
  };

  if (!show) return null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9999] transition-all duration-300 ${
        dismissed ? 'opacity-0 -translate-y-full' : 'opacity-100 translate-y-0'
      }`}
    >
      <div className="bg-gray-100/95 backdrop-blur-xl border-b border-gray-200/60 px-3 py-2.5 safe-area-top">
        <div className="flex items-center gap-3 max-w-lg mx-auto">
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-gray-600 text-sm font-medium flex-shrink-0 p-1"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>

          <div className="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 shadow-sm">
            <img
              src="/icon-192.png"
              alt={appName}
              className="w-full h-full object-cover"
            />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{appName}</p>
            <p className="text-xs text-gray-500 truncate">{appDescription}</p>
          </div>

          <button
            onClick={handleAction}
            className="flex-shrink-0 px-4 py-1.5 rounded-full bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600 transition-colors"
          >
            {platform === 'android' ? 'INSTALL' : 'OPEN'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PwaSmartBanner;
