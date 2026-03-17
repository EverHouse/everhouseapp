import React from 'react';
import type { BannerAnnouncement } from './dashboardTypes';

interface PasskeyNudgeProps {
  isDark: boolean;
  showPasskeyNudge: boolean;
  setShowPasskeyNudge: (v: boolean) => void;
  startNavigation: () => void;
  navigate: (path: string, opts?: { state?: Record<string, unknown> }) => void;
}

export const PasskeyNudge: React.FC<PasskeyNudgeProps> = ({
  isDark, showPasskeyNudge, setShowPasskeyNudge, startNavigation, navigate,
}) => {
  if (!showPasskeyNudge) return null;

  return (
    <div className={`mb-4 py-3 px-4 rounded-xl flex items-start justify-between gap-3 animate-pop-in ${isDark ? 'bg-emerald-500/15 border border-emerald-500/30' : 'bg-emerald-50 border border-emerald-200'}`}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className={`material-symbols-outlined text-xl flex-shrink-0 mt-0.5 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>fingerprint</span>
        <div className="min-w-0 flex-1">
          <h4 className={`font-bold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>Skip the code next time</h4>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>Set up Face ID or Touch ID for instant sign-in.</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { localStorage.setItem('eh_passkey_nudge_dismissed', '1'); startNavigation(); navigate('/profile', { state: { scrollToPasskeys: true } }); }}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
        >
          Set up
        </button>
        <button
          onClick={() => { setShowPasskeyNudge(false); localStorage.setItem('eh_passkey_nudge_dismissed', '1'); }}
          className={`p-1 rounded-lg transition-colors ${isDark ? 'text-white/50 hover:text-white/80 hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
        >
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
    </div>
  );
};

interface BannerAlertProps {
  isDark: boolean;
  bannerAnnouncement?: BannerAnnouncement;
  bannerDismissed: boolean;
  isBannerInitiallyDismissed: boolean;
  bannerExiting: boolean;
  setBannerExiting: (v: boolean) => void;
  setBannerDismissed: (v: boolean) => void;
  bannerExitTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  userEmail?: string;
  startNavigation: () => void;
  navigate: (path: string) => void;
}

export const BannerAlert: React.FC<BannerAlertProps> = ({
  isDark, bannerAnnouncement, bannerDismissed, isBannerInitiallyDismissed,
  bannerExiting, setBannerExiting, setBannerDismissed, bannerExitTimer,
  userEmail, startNavigation, navigate,
}) => {
  if (!bannerAnnouncement || bannerDismissed || isBannerInitiallyDismissed) return null;

  return (
    <div className={`mb-4 py-3 px-4 rounded-xl flex items-start justify-between gap-3 transition-all duration-normal ease-spring-smooth ${bannerExiting ? 'opacity-0 scale-95 max-h-0 mb-0 py-0 overflow-hidden' : 'animate-pop-in max-h-[200px]'} ${isDark ? 'bg-lavender/20 border border-lavender/30' : 'bg-lavender/30 border border-lavender/40'}`}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className={`material-symbols-outlined text-xl flex-shrink-0 mt-0.5 ${isDark ? 'text-lavender' : 'text-primary'}`}>campaign</span>
        <div className="min-w-0 flex-1">
          <h4 className={`font-bold text-sm ${isDark ? 'text-white' : 'text-primary'}`}>{bannerAnnouncement.title}</h4>
          {bannerAnnouncement.desc && (
            <p className={`text-xs mt-0.5 line-clamp-2 ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{bannerAnnouncement.desc}</p>
          )}
          <button
            onClick={() => {
              if (bannerAnnouncement.linkType === 'external' && bannerAnnouncement.linkTarget) {
                window.open(bannerAnnouncement.linkTarget, '_blank');
              } else if (bannerAnnouncement.linkType === 'events') {
                startNavigation(); navigate('/events');
              } else if (bannerAnnouncement.linkType === 'wellness') {
                startNavigation(); navigate('/wellness');
              } else if (bannerAnnouncement.linkType === 'golf') {
                startNavigation(); navigate('/book');
              } else {
                startNavigation(); navigate('/updates?tab=announcements');
              }
            }}
            className={`text-xs font-semibold mt-2 flex items-center gap-1 ${isDark ? 'text-lavender' : 'text-primary'}`}
          >
            Learn more
            <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </button>
        </div>
      </div>
      <button 
        onClick={() => {
          if (userEmail && bannerAnnouncement.id) {
            localStorage.setItem(`eh_banner_dismissed_${userEmail}`, bannerAnnouncement.id);
          }
          setBannerExiting(true);
          bannerExitTimer.current = setTimeout(() => {
            setBannerDismissed(true);
            bannerExitTimer.current = null;
          }, 250);
        }}
        className={`p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-full transition-colors flex-shrink-0 ${isDark ? 'hover:bg-white/10 text-white/60 hover:text-white' : 'hover:bg-black/10 text-primary/60 hover:text-primary'}`}
        aria-label="Dismiss banner"
      >
        <span className="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>
  );
};

interface MembershipStatusAlertProps {
  isDark: boolean;
  userStatus?: string;
}

export const MembershipStatusAlert: React.FC<MembershipStatusAlertProps> = ({ userStatus }) => {
  if (!userStatus || ['active', 'trialing', 'past_due'].includes(userStatus.toLowerCase())) return null;

  return (
    <div className="mb-4 p-4 rounded-xl bg-red-500/90 border border-red-600 animate-pop-in">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-2xl text-white">warning</span>
        <div className="flex-1">
          <h4 className="font-bold text-white text-sm">Membership Not Active</h4>
          <p className="text-white/90 text-xs mt-0.5">
            Your membership status is currently {userStatus.toLowerCase()}. Some features are unavailable until your membership is reactivated.
          </p>
        </div>
      </div>
    </div>
  );
};
