import React, { useState } from 'react';
import { getBaseTier } from '../../../utils/permissions';
import { getTierColor } from '../../../utils/tierUtils';
import { formatMemberSince } from '../../../utils/dateUtils';
import { apiRequestBlob } from '../../../lib/apiRequest';
import TierBadge from '../../../components/TierBadge';
import ModalShell from '../../../components/ModalShell';
import MetricsGrid from '../../../components/MetricsGrid';
import type { GuestPasses, DashboardWellnessClass, DashboardEvent } from './dashboardTypes';

interface UserLike {
  id?: string | number;
  name?: string;
  email?: string;
  tier?: string;
  role?: string;
  status?: string;
  joinDate?: string;
  lifetimeVisits?: number;
  firstName?: string | null;
}

interface MembershipCardProps {
  user: UserLike | null;
  isDark: boolean;
  isStaffOrAdminProfile: boolean;
  statsData?: { guestPasses: GuestPasses | null; lifetimeVisitCount: number } | null;
  guestPasses: GuestPasses | null;
  tierPermissions: { dailySimulatorMinutes: number; dailyConfRoomMinutes: number };
  simMinutesToday: number;
  confMinutesToday: number;
  nextWellnessClass?: DashboardWellnessClass;
  nextEvent?: DashboardEvent;
  walletPassAvailable: boolean;
  isCardOpen: boolean;
  setIsCardOpen: (v: boolean) => void;
  navigate: (path: string, opts?: { state?: Record<string, unknown> }) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void;
}

export const MembershipCard: React.FC<MembershipCardProps> = ({
  user, isDark, isStaffOrAdminProfile, statsData, guestPasses, tierPermissions,
  simMinutesToday, confMinutesToday, nextWellnessClass, nextEvent,
  walletPassAvailable, isCardOpen, setIsCardOpen, navigate, showToast,
}) => {
  if (isStaffOrAdminProfile || !user) return null;

  const isExpired = user.status === 'Expired';
  const isVisitor = user.role === 'visitor';
  const tierColors = isVisitor ? { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE' } : getTierColor(user.tier || '');
  const cardBgColor = isExpired ? '#6B7280' : tierColors.bg;
  const cardTextColor = isExpired ? '#F9FAFB' : tierColors.text;
  const baseTier = isVisitor ? 'visitor' : (getBaseTier(user.tier || '') || '');
  const useDarkLogo = isExpired || ['Social', 'Premium', 'VIP'].includes(baseTier);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 mb-6">
        <div 
          onClick={() => setIsCardOpen(true)} 
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsCardOpen(true); } }}
          className={`relative h-56 lg:h-full lg:min-h-56 w-full rounded-xl overflow-hidden cursor-pointer transition-all duration-emphasis ease-out group animate-content-enter-delay-2 active:scale-[0.98] hover:scale-[1.015] hover:shadow-2xl ${isExpired ? 'grayscale-[30%]' : ''}`}
        >
          <div className="absolute inset-0" style={{ backgroundColor: cardBgColor }}></div>
          <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0.05) 100%)' }}></div>
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")` }}></div>
          <div className="absolute inset-0 border border-white/30 rounded-xl backdrop-blur-xl" style={{ boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.2)' }}></div>
          <div className="absolute inset-0 overflow-hidden rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-normal pointer-events-none">
            <div className="holographic-shimmer absolute -inset-full"></div>
          </div>
          <div className="absolute inset-0 p-6 flex flex-col justify-between z-10">
            <div className="flex justify-between items-start">
              <img src={useDarkLogo ? "/images/everclub-logo-dark.webp" : "/images/everclub-logo-light.webp"} className={`h-10 w-auto ${isExpired ? 'opacity-50' : 'opacity-90'}`} alt="" />
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: `${cardTextColor}99` }}>Ever Club</span>
                {isExpired && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500 text-white">
                    Expired
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <TierBadge tier={user.tier} size="sm" role={user.role} membershipStatus={user.status} />
              </div>
              <h3 className="text-xl font-display font-bold tracking-wide" style={{ color: cardTextColor, textShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>{user.name}</h3>
              {isExpired ? (
                <p className="text-xs mt-2 text-red-200">Membership expired - Contact us to renew</p>
              ) : (
                <>
                  {user.joinDate && (
                    <p className="text-xs mt-2" style={{ color: `${cardTextColor}80` }}>Joined {formatMemberSince(user.joinDate)}</p>
                  )}
                  {(() => {
                    const visitCount = statsData?.lifetimeVisitCount ?? user.lifetimeVisits;
                    return visitCount !== undefined ? (
                      <p className="text-xs" style={{ color: `${cardTextColor}80` }}>{visitCount} {visitCount === 1 ? 'lifetime visit' : 'lifetime visits'}</p>
                    ) : null;
                  })()}
                </>
              )}
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity duration-normal z-20 p-4 pointer-events-none">
            <div className="w-full py-2 px-4 rounded-xl bg-black/40 backdrop-blur-md border border-white/20 text-center" style={{ boxShadow: '0 -4px 16px rgba(0,0,0,0.1)' }}>
              <span className="font-bold text-sm text-white/90">{isExpired ? 'Renew Membership' : 'View Membership Details'}</span>
            </div>
          </div>
        </div>

        <div className="h-full animate-content-enter-delay-1">
          <MetricsGrid
            simulatorMinutesUsed={simMinutesToday}
            simulatorMinutesAllowed={tierPermissions.dailySimulatorMinutes}
            conferenceMinutesUsed={confMinutesToday}
            conferenceMinutesAllowed={tierPermissions.dailyConfRoomMinutes}
            nextWellnessClass={nextWellnessClass ? { title: nextWellnessClass.title, date: nextWellnessClass.date } : undefined}
            nextEvent={nextEvent ? { title: nextEvent.title, date: nextEvent.event_date } : undefined}
            onNavigate={navigate}
            className="h-full"
          />
        </div>
      </div>

      <MembershipDetailsModal
        user={user}
        isCardOpen={isCardOpen}
        setIsCardOpen={setIsCardOpen}
        isStaffOrAdminProfile={isStaffOrAdminProfile}
        tierPermissions={tierPermissions}
        guestPasses={guestPasses}
        walletPassAvailable={walletPassAvailable}
        showToast={showToast}
      />
    </>
  );
};

interface MembershipDetailsModalProps {
  user: UserLike | null;
  isCardOpen: boolean;
  setIsCardOpen: (v: boolean) => void;
  isStaffOrAdminProfile: boolean;
  tierPermissions: { dailySimulatorMinutes: number; dailyConfRoomMinutes: number };
  guestPasses: GuestPasses | null;
  walletPassAvailable: boolean;
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void;
}

const MembershipDetailsModal: React.FC<MembershipDetailsModalProps> = ({
  user, isCardOpen, setIsCardOpen, isStaffOrAdminProfile, tierPermissions, guestPasses, walletPassAvailable, showToast,
}) => {
  const [walletLoading, setWalletLoading] = useState(false);

  if (!user) return null;

  const isExpiredModal = user.status === 'Expired';
  const isVisitorModal = user.role === 'visitor' || !user.tier;
  const tierColors = isVisitorModal ? { bg: '#EFF6FF', text: '#2563EB', border: '#BFDBFE' } : getTierColor(user.tier);
  const cardBgColor = isExpiredModal ? '#6B7280' : (isStaffOrAdminProfile ? '#293515' : tierColors.bg);
  const cardTextColor = isExpiredModal ? '#F9FAFB' : (isStaffOrAdminProfile ? '#F2F2EC' : tierColors.text);

  return (
    <ModalShell 
      isOpen={isCardOpen && !!user} 
      onClose={() => setIsCardOpen(false)}
      showCloseButton={false}
      size="sm"
      className="!bg-transparent !border-0 !shadow-none"
    >
      <div className="flex flex-col items-center">
        <div className={`w-full rounded-xl relative overflow-hidden shadow-2xl flex flex-col ${isExpiredModal ? 'grayscale-[30%]' : ''}`} style={{ backgroundColor: cardBgColor }}>
          
          <button onClick={() => setIsCardOpen(false)} className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center z-10" style={{ backgroundColor: `${cardTextColor}33`, color: cardTextColor }} aria-label="Close card">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>

          <div className="pt-6 px-6 pb-4 text-center" style={{ backgroundColor: cardBgColor }}>
            <h2 className="text-2xl font-bold mb-3" style={{ color: cardTextColor }}>{(user.name || '').includes('@') ? 'Member' : user.name}</h2>
            
            <div className="flex items-center justify-center gap-2 flex-wrap mb-2">
              <TierBadge tier={user.tier} size="md" role={user.role} membershipStatus={user.status} />
              {isExpiredModal && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500 text-white">
                  Expired
                </span>
              )}
            </div>
            {isExpiredModal && (
              <div className="mt-4 p-3 rounded-xl bg-red-500/20 border border-red-500/30">
                <p className="text-sm text-red-200 text-center mb-2">Your membership has expired</p>
                <a 
                  href="/contact" 
                  className="block w-full py-2 px-4 bg-red-500 hover:bg-red-600 text-white text-sm font-bold rounded-lg text-center transition-colors"
                >
                  Contact Us to Renew
                </a>
              </div>
            )}
          </div>

          {!isExpiredModal && user.id && (
            <div className="px-6 pb-2 flex flex-col items-center" style={{ backgroundColor: cardBgColor }}>
              <div className="bg-white p-2.5 rounded-xl shadow-md flex items-center justify-center" style={{ width: '55%', aspectRatio: '1' }}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`MEMBER:${user.id}`)}`}
                  alt="Member QR Code"
                  className="w-full h-full"
                />
              </div>
              <p className="text-xs mt-1.5 opacity-50" style={{ color: cardTextColor }}>Show for quick check-in</p>
            </div>
          )}

          <div className="px-6 pb-6" style={{ backgroundColor: cardBgColor }}>
            <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: `${cardTextColor}10` }}>
              <h3 className="text-sm font-bold uppercase tracking-wider opacity-60 mb-3" style={{ color: cardTextColor, fontFamily: 'var(--font-label)', letterSpacing: '0.1em' }}>Membership Benefits</h3>
              
              {user.joinDate && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>badge</span>
                    <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Member Since</span>
                  </div>
                  <span className="font-semibold text-sm" style={{ color: cardTextColor }}>{formatMemberSince(user.joinDate)}</span>
                </div>
              )}
              
              {tierPermissions.dailySimulatorMinutes > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>sports_golf</span>
                    <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Simulator</span>
                  </div>
                  <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                    {tierPermissions.dailySimulatorMinutes === Infinity ? 'Unlimited' : `${tierPermissions.dailySimulatorMinutes} min`}
                  </span>
                </div>
              )}
              
              {tierPermissions.dailyConfRoomMinutes > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>meeting_room</span>
                    <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Daily Conference</span>
                  </div>
                  <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                    {tierPermissions.dailyConfRoomMinutes === Infinity ? 'Unlimited' : `${tierPermissions.dailyConfRoomMinutes} min`}
                  </span>
                </div>
              )}
              
              {guestPasses && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-lg opacity-60" style={{ color: cardTextColor }}>group_add</span>
                    <span className="text-sm opacity-80" style={{ color: cardTextColor }}>Guest Passes</span>
                  </div>
                  <span className="font-semibold text-sm" style={{ color: cardTextColor }}>
                    {guestPasses.passes_remaining} / {guestPasses.passes_total} remaining
                  </span>
                </div>
              )}
            </div>
          </div>

          {!isExpiredModal && walletPassAvailable && (
            <div className="px-6 pb-6 flex justify-center" style={{ backgroundColor: cardBgColor }}>
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  if (walletLoading) return;
                  setWalletLoading(true);
                  try {
                    const response = await apiRequestBlob('/api/member/wallet-pass');
                    if (!response.ok || !response.blob) {
                      showToast(response.error || 'Failed to download wallet pass', 'error');
                      return;
                    }
                    const url = URL.createObjectURL(response.blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'EverClub-Pass.pkpass';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showToast('Wallet pass downloaded — open it to add to Apple Wallet', 'success', 5000);
                  } catch {
                    showToast('Failed to download wallet pass', 'error');
                  } finally {
                    setWalletLoading(false);
                  }
                }}
                disabled={walletLoading}
                className={`inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg text-sm font-semibold transition-all duration-200 ${walletLoading ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-90 active:scale-[0.98]'}`}
                style={{
                  backgroundColor: '#000000',
                  color: '#FFFFFF',
                  minWidth: '240px',
                }}
                aria-label="Add to Apple Wallet"
              >
                {walletLoading ? (
                  <span className="animate-spin material-symbols-outlined text-[24px]">progress_activity</span>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white">
                    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                  </svg>
                )}
                <span>
                  <span style={{ fontSize: '10px', fontWeight: 400, display: 'block', lineHeight: 1.2 }}>Add to</span>
                  <span style={{ fontSize: '16px', fontWeight: 600, display: 'block', lineHeight: 1.2 }}>Apple Wallet</span>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
};
