import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useUserStore } from '../stores/userStore';

import type { MemberProfile } from '../types/data';

interface AuthDataContextType {
  user: MemberProfile | null;
  actualUser: MemberProfile | null;
  viewAsUser: MemberProfile | null;
  isViewingAs: boolean;
  isLoading: boolean;
  sessionChecked: boolean;
  sessionVersion: number;
  login: (email: string) => Promise<void>;
  loginWithMember: (member: MemberProfile) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setViewAsUser: (member: MemberProfile) => Promise<void>;
  clearViewAsUser: () => void;
}

const AuthDataContext = createContext<AuthDataContextType | undefined>(undefined);

export const AuthDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const storeUser = useUserStore((s) => s.user);
  const [actualUser, setActualUser] = useState<MemberProfile | null>(null);
  const [viewAsUser, setViewAsUserState] = useState<MemberProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [sessionChecked, setSessionChecked] = useState(false);
  const sessionCheckDone = useRef(false);
  const loginInProgressRef = useRef(false);
  const actualUserRef = useRef<MemberProfile | null>(null);
  const sessionLoadingComplete = useRef(false);

  const prevActualUserIdRef = useRef<string | null>(null);
  const prevActualUserRoleRef = useRef<string | null>(null);
  const prevActualUserEmailRef = useRef<string | null>(null);

  const isViewingAs = viewAsUser !== null;
  const user = viewAsUser || actualUser;

  const safeSetIsLoadingFalse = useCallback(() => {
    if (!sessionLoadingComplete.current) {
      sessionLoadingComplete.current = true;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (storeUser && !actualUser) {
      setActualUser(storeUser as MemberProfile);
      safeSetIsLoadingFalse();
    }
  }, [storeUser, actualUser, safeSetIsLoadingFalse]);

  useEffect(() => {
    actualUserRef.current = actualUser;
    prevActualUserIdRef.current = actualUser?.id || null;
    prevActualUserRoleRef.current = actualUser?.role || null;
    prevActualUserEmailRef.current = actualUser?.email || null;
  }, [actualUser]);

  useEffect(() => {
    if (sessionCheckDone.current) return;
    sessionCheckDone.current = true;

    const initializeUser = async () => {
      const isDevPreview = window.location.pathname.includes('/dev-preview/') ||
                           window.location.hash.includes('/dev-preview/');
      const isScreenshotMode = isDevPreview;

      if (isScreenshotMode) {
        const isAdminPreview = window.location.pathname.includes('/dev-preview/admin') ||
                               window.location.hash.includes('/dev-preview/admin');

        if (isAdminPreview) {
          const devTestStaff: MemberProfile = {
            id: 'dev-test-staff',
            name: 'Dev Test Staff',
            tier: 'Staff',
            tags: [],
            status: 'Active' as const,
            email: 'dev-staff@evenhouse.local',
            phone: '',
            jobTitle: 'Staff Member',
            role: 'admin',
            mindbodyClientId: '',
            lifetimeVisits: 0,
            lastBookingDate: undefined
          };
          setActualUser(devTestStaff);
          setSessionChecked(true);
          safeSetIsLoadingFalse();
          console.log('[SCREENSHOT MODE] Auto-logged in as test staff/admin');
          return;
        }

        const devTestMember: MemberProfile = {
          id: 'dev-test-member',
          name: 'Dev Test Member',
          tier: 'Premium',
          tags: [],
          status: 'Active' as const,
          email: 'dev-test@evenhouse.local',
          phone: '',
          jobTitle: '',
          role: 'member',
          mindbodyClientId: '',
          lifetimeVisits: 10,
          lastBookingDate: undefined
        };
        setActualUser(devTestMember);
        setSessionChecked(true);
        safeSetIsLoadingFalse();
        console.log('[SCREENSHOT MODE] Auto-logged in as test member');
        return;
      }

      try {
        const sessionRes = await fetch('/api/auth/session', {
          credentials: 'include'
        });

        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();

          if (sessionData.authenticated && sessionData.member) {
            const sessionEmail = sessionData.member.email?.toLowerCase();
            const savedMember = localStorage.getItem('eh_member');
            const cachedEmail = savedMember ? JSON.parse(savedMember)?.email?.toLowerCase() : null;
            const currentStoreUser = useUserStore.getState().user;
            const storeEmail = currentStoreUser?.email?.toLowerCase();

            if ((cachedEmail && cachedEmail !== sessionEmail) || (storeEmail && storeEmail !== sessionEmail)) {
              localStorage.removeItem('eh_member');
              useUserStore.getState().clearUser();
            }

            const sessionProfile: MemberProfile = {
              id: sessionData.member.id,
              name: [sessionData.member.firstName, sessionData.member.lastName].filter(Boolean).join(' ') || sessionData.member.email || 'Member',
              tier: sessionData.member.tier || 'Social',
              tags: sessionData.member.tags || [],
              status: 'Active' as const,
              email: sessionData.member.email,
              phone: sessionData.member.phone || '',
              jobTitle: sessionData.member.jobTitle || '',
              role: sessionData.member.role || 'member',
              mindbodyClientId: sessionData.member.mindbodyClientId || '',
              lifetimeVisits: 0,
              lastBookingDate: undefined,
              dateOfBirth: sessionData.member.dateOfBirth || null
            };

            localStorage.setItem('eh_member', JSON.stringify(sessionProfile));
            setActualUser(sessionProfile);
            useUserStore.getState().setUser(sessionProfile);
            loginInProgressRef.current = false;
            setSessionChecked(true);
            safeSetIsLoadingFalse();
            return;
          }
        }

        if (sessionRes.status === 401 || sessionRes.status === 403) {
          if (!loginInProgressRef.current) {
            localStorage.removeItem('eh_member');
            useUserStore.getState().clearUser();
            setActualUser(null);
          }
          loginInProgressRef.current = false;
          setSessionChecked(true);
          safeSetIsLoadingFalse();
          return;
        }
      } catch (sessionErr: unknown) {
        console.error('Failed to verify session:', sessionErr);
      }

      const currentStoreUser = useUserStore.getState().user;
      if (currentStoreUser) {
        setActualUser(currentStoreUser as MemberProfile);
        setSessionChecked(true);
        safeSetIsLoadingFalse();
        return;
      }

      const savedMember = localStorage.getItem('eh_member');
      if (savedMember) {
        try {
          const member = JSON.parse(savedMember);
          setActualUser(member);
          useUserStore.getState().setUser(member);
        } catch (err: unknown) {
          localStorage.removeItem('eh_member');
        }
      }
      loginInProgressRef.current = false;
      setSessionChecked(true);
      safeSetIsLoadingFalse();
    };

    initializeUser();
  }, [safeSetIsLoadingFalse]);

  const setViewAsUser = useCallback(async (member: MemberProfile) => {
    if (actualUser?.role === 'admin') {
      try {
        const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/details`, { credentials: 'include' });
        if (res.ok) {
          const details = await res.json();
          const fullMember: MemberProfile = {
            ...member,
            tier: member.tier || details.tier,
            tags: member.tags?.length ? member.tags : details.tags,
            lifetimeVisits: details.lifetimeVisits || 0,
            lastBookingDate: details.lastBookingDate || undefined,
            mindbodyClientId: details.mindbodyClientId || ''
          };
          flushSync(() => {
            setViewAsUserState(fullMember);
          });
        } else {
          flushSync(() => {
            setViewAsUserState(member);
          });
        }
      } catch (err: unknown) {
        console.error('Failed to fetch member details:', err);
        flushSync(() => {
          setViewAsUserState(member);
        });
      }
    }
  }, [actualUser?.role]);

  const clearViewAsUser = useCallback(() => {
    flushSync(() => {
      setViewAsUserState(null);
    });
  }, []);

  const login = useCallback(async (email: string) => {
    const res = await fetch('/api/auth/verify-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to verify membership');
    }

    const { member } = await res.json();

    const memberProfile: MemberProfile = {
      id: member.id,
      name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || 'Member',
      tier: member.tier || 'Core',
      tags: member.tags || [],
      status: 'Active',
      email: member.email,
      phone: member.phone || '',
      jobTitle: member.jobTitle || '',
      role: member.role || 'member',
      mindbodyClientId: member.mindbodyClientId || '',
      lifetimeVisits: member.lifetimeVisits || 0,
      lastBookingDate: member.lastBookingDate || undefined
    };

    if (!sessionChecked) {
      loginInProgressRef.current = true;
    }
    localStorage.setItem('eh_member', JSON.stringify(memberProfile));
    setActualUser(memberProfile);
    useUserStore.getState().setUser(memberProfile);
    setSessionVersion(v => v + 1);
  }, [sessionChecked]);

  const loginWithMember = useCallback((member: MemberProfile) => {
    const memberProfile: MemberProfile = {
      id: member.id,
      name: [(member as any).firstName, (member as any).lastName].filter(Boolean).join(' ') || member.email || 'Member',
      tier: member.tier || 'Core',
      tags: member.tags || [],
      status: 'Active',
      email: member.email,
      phone: member.phone || '',
      jobTitle: member.jobTitle || '',
      role: member.role || 'member',
      mindbodyClientId: member.mindbodyClientId || '',
      lifetimeVisits: member.lifetimeVisits || 0,
      lastBookingDate: member.lastBookingDate || undefined
    };

    if (!sessionChecked) {
      loginInProgressRef.current = true;
    }
    localStorage.setItem('eh_member', JSON.stringify(memberProfile));
    setActualUser(memberProfile);
    useUserStore.getState().setUser(memberProfile);
    setSessionVersion(v => v + 1);
  }, [sessionChecked]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (err: unknown) {
      console.error('Server logout failed:', err);
    }
    loginInProgressRef.current = false;
    localStorage.removeItem('eh_member');
    useUserStore.getState().clearUser();
    setActualUser(null);
    setViewAsUserState(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!actualUser?.email) return;

    try {
      const res = await fetch('/api/auth/verify-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: actualUser.email })
      });

      if (res.ok) {
        const { member } = await res.json();
        const memberProfile: MemberProfile = {
          id: member.id,
          name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || 'Member',
          tier: member.tier || 'Core',
          tags: member.tags || [],
          status: 'Active',
          email: member.email,
          phone: member.phone || '',
          jobTitle: member.jobTitle || '',
          role: member.role || 'member',
          mindbodyClientId: member.mindbodyClientId || '',
          lifetimeVisits: member.lifetimeVisits || 0,
          lastBookingDate: member.lastBookingDate || undefined
        };

        localStorage.setItem('eh_member', JSON.stringify(memberProfile));
        setActualUser(memberProfile);
      }
    } catch (err: unknown) {
      console.error('Failed to refresh user data:', err);
    }
  }, [actualUser?.email]);




  const refreshUserRef = useRef<() => Promise<void>>(undefined);
  useEffect(() => {
    refreshUserRef.current = async () => {
      const currentEmail = actualUserRef.current?.email;
      if (!currentEmail) return;
      try {
        const res = await fetch('/api/auth/verify-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: currentEmail })
        });
        if (res.ok) {
          const { member } = await res.json();
          const memberProfile: MemberProfile = {
            id: member.id,
            name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || 'Member',
            tier: member.tier || 'Core',
            tags: member.tags || [],
            status: 'Active',
            email: member.email,
            phone: member.phone || '',
            jobTitle: member.jobTitle || '',
            role: member.role || 'member',
            mindbodyClientId: member.mindbodyClientId || '',
            lifetimeVisits: member.lifetimeVisits || 0,
            lastBookingDate: member.lastBookingDate || undefined
          };
          localStorage.setItem('eh_member', JSON.stringify(memberProfile));
          setActualUser(memberProfile);
        }
      } catch (err: unknown) {
        console.error('Failed to refresh user data:', err);
      }
    };
  }, []);

  useEffect(() => {
    const handleMemberStatsUpdate = (event: CustomEvent) => {
      const memberEmail = event.detail?.memberEmail;
      const currentEmail = actualUserRef.current?.email;
      if (!currentEmail) return;
      if (memberEmail && currentEmail.toLowerCase() === memberEmail.toLowerCase()) {
        refreshUserRef.current?.();
      }
    };

    window.addEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    return () => {
      window.removeEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleTierUpdate = (event: CustomEvent) => {
      const memberEmail = event.detail?.memberEmail;
      const currentEmail = actualUserRef.current?.email;
      if (currentEmail && memberEmail && currentEmail.toLowerCase() === memberEmail.toLowerCase()) {
        refreshUserRef.current?.();
      }
    };

    window.addEventListener('tier-update', handleTierUpdate as EventListener);
    return () => {
      window.removeEventListener('tier-update', handleTierUpdate as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleBillingUpdate = () => {
      const isStaff = actualUserRef.current?.role === 'staff' || actualUserRef.current?.role === 'admin';
      if (isStaff) {
        window.dispatchEvent(new CustomEvent('billing-data-refresh'));
      }
    };

    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
    };
  }, []);

  const contextValue = React.useMemo(() => ({
    user, actualUser, viewAsUser, isViewingAs,
    isLoading, sessionChecked, sessionVersion,
    login, loginWithMember, logout, refreshUser,
    setViewAsUser, clearViewAsUser
  }), [
    user, actualUser, viewAsUser, isViewingAs,
    isLoading, sessionChecked, sessionVersion,
    login, loginWithMember, logout, refreshUser,
    setViewAsUser, clearViewAsUser
  ]);

  return (
    <AuthDataContext.Provider value={contextValue}>
      {children}
    </AuthDataContext.Provider>
  );
};

export const useAuthData = () => {
  const context = useContext(AuthDataContext);
  if (!context) {
    throw new Error('useAuthData must be used within an AuthDataProvider');
  }
  return context;
};
