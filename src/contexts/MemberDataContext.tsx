import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthData } from './AuthDataContext';
import type { MemberProfile } from '../types/data';
export interface PaginatedMembersResponse {
  members: MemberProfile[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

export interface FetchMembersOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: 'active' | 'former';
  append?: boolean;
}

interface DirectoryContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  tier?: string;
  rawTier?: string;
  tags?: string[];
  status?: string;
  lifetimeVisits?: number;
  lastBookingDate?: string;
  joinDate?: string;
  mindbodyClientId?: string;
  stripeCustomerId?: string;
  hubspotId?: string;
  manuallyLinkedEmails?: string[];
  billingProvider?: string;
  billing_provider?: string;
  membershipStatus?: string;
  firstLoginAt?: string;
  lastTier?: string;
  billingGroupId?: number | null;
  discountCode?: string;
}

function formatContact(contact: DirectoryContact, defaultStatus: string): MemberProfile {
  return {
    id: contact.id,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
    tier: contact.tier || '',
    rawTier: contact.rawTier,
    tags: contact.tags || [],
    status: typeof contact.status === 'string' ? contact.status : defaultStatus,
    email: contact.email || '',
    phone: contact.phone || '',
    role: 'member',
    lifetimeVisits: contact.lifetimeVisits || 0,
    lastBookingDate: contact.lastBookingDate || null,
    joinDate: contact.joinDate || null,
    mindbodyClientId: contact.mindbodyClientId || null,
    stripeCustomerId: contact.stripeCustomerId || null,
    hubspotId: contact.hubspotId || null,
    manuallyLinkedEmails: contact.manuallyLinkedEmails || [],
    billingProvider: contact.billingProvider || contact.billing_provider || null,
    membershipStatus: contact.membershipStatus || null,
    firstLoginAt: contact.firstLoginAt || null,
    lastTier: contact.lastTier || null,
    billingGroupId: contact.billingGroupId || null,
    discountCode: contact.discountCode || null
  } as MemberProfile;
}

interface MemberDataContextType {
  members: MemberProfile[];
  formerMembers: MemberProfile[];
  fetchFormerMembers: (forceRefresh?: boolean) => Promise<void>;
  fetchMembersPaginated: (options?: FetchMembersOptions) => Promise<PaginatedMembersResponse>;
  membersPagination: { total: number; page: number; totalPages: number; hasMore: boolean } | null;
  isFetchingMembers: boolean;
  updateMember: (member: MemberProfile) => void;
  refreshMembers: () => Promise<{ success: boolean; count: number }>;
}

const MemberDataContext = createContext<MemberDataContextType | undefined>(undefined);

export const MemberDataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const { sessionChecked, actualUser } = useAuthData();
  const actualUserRef = useRef<MemberProfile | null>(null);

  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [formerMembers, setFormerMembers] = useState<MemberProfile[]>([]);
  const [membersPagination, setMembersPagination] = useState<{ total: number; page: number; totalPages: number; hasMore: boolean } | null>(null);
  const [isFetchingMembers, setIsFetchingMembers] = useState(false);

  const formerMembersFetched = useRef(false);
  const formerMembersLastFetch = useRef<number>(0);
  const FORMER_MEMBERS_CACHE_MS = 10 * 60 * 1000;
  const initialMembersFetchedRef = useRef(false);
  const membersFetchUserRoleRef = useRef<string | null>(null);
  const paginatedMembersCache = useRef<Map<string, MemberProfile[]>>(new Map());

  useEffect(() => {
    actualUserRef.current = actualUser;
  }, [actualUser]);

  useEffect(() => {
    const fetchInitialMembers = async () => {
      if (!sessionChecked) return;
      const currentUser = actualUserRef.current;
      if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'staff')) return;
      const currentRole = currentUser.role;
      if (initialMembersFetchedRef.current && membersFetchUserRoleRef.current === currentRole) return;

      setIsFetchingMembers(true);
      try {
        const res = await fetch('/api/members/directory?status=active', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const contacts = Array.isArray(data) ? data : (data.contacts || []);
          const formatted = contacts.map((c: DirectoryContact) => formatContact(c, 'Active'));
          setMembers(formatted);
          initialMembersFetchedRef.current = true;
          membersFetchUserRoleRef.current = currentRole;
          if (data.total && data.totalPages) {
            setMembersPagination({
              total: data.total,
              page: 1,
              totalPages: data.totalPages,
              hasMore: data.hasMore || data.totalPages > 1
            });
          }
        }
      } catch (err: unknown) {
        console.error('Failed to fetch initial members:', err);
      } finally {
        setIsFetchingMembers(false);
      }
    };
    fetchInitialMembers();
  }, [sessionChecked]);

  const fetchFormerMembers = useCallback(async (forceRefresh = false) => {
    const currentUser = actualUserRef.current;
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'staff')) return;
    const now = Date.now();
    if (!forceRefresh) {
      const cacheAge = now - formerMembersLastFetch.current;
      if (formerMembersFetched.current && cacheAge < FORMER_MEMBERS_CACHE_MS) return;
    }
    try {
      const res = await fetch('/api/members/directory?status=former', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted = contacts.map((c: DirectoryContact) => formatContact(c, 'Inactive'));
        setFormerMembers(formatted);
        formerMembersFetched.current = true;
        formerMembersLastFetch.current = now;
      } else {
        console.error('Failed to fetch former members: API returned', res.status);
      }
    } catch (err: unknown) {
      console.error('Failed to fetch former members:', err);
    }
  }, []);

  const refreshMembers = useCallback(async (): Promise<{ success: boolean; count: number }> => {
    const currentUser = actualUserRef.current;
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'staff')) {
      return { success: false, count: 0 };
    }
    try {
      const res = await fetch('/api/members/directory?status=active', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted = contacts.map((c: DirectoryContact) => formatContact(c, 'Active'));
        setMembers(formatted);
        formerMembersFetched.current = false;
        return { success: true, count: formatted.length };
      }
      return { success: false, count: 0 };
    } catch (err: unknown) {
      console.error('Failed to refresh members from database:', err);
      return { success: false, count: 0 };
    }
  }, []);

  const fetchMembersPaginated = useCallback(async (options: FetchMembersOptions = {}): Promise<PaginatedMembersResponse> => {
    const currentUser = actualUserRef.current;
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'staff')) {
      return { members: [], total: 0, page: 1, limit: 50, totalPages: 0, hasMore: false };
    }
    const { page = 1, limit = 50, search = '', status = 'active', append = false } = options;
    setIsFetchingMembers(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        status
      });
      if (search.trim()) params.set('search', search.trim());

      const res = await fetch(`/api/members/directory?${params.toString()}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted = contacts.map((c: DirectoryContact) => formatContact(c, status === 'active' ? 'Active' : 'Inactive'));
        const paginationInfo = {
          total: data.total || formatted.length,
          page: data.page || page,
          totalPages: data.totalPages || 1,
          hasMore: data.hasMore || false
        };
        setMembersPagination(paginationInfo);
        if (status === 'active') {
          if (append && page > 1) {
            setMembers(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const newMembers = formatted.filter((m: MemberProfile) => !existingIds.has(m.id));
              return [...prev, ...newMembers];
            });
          } else if (!append) {
            setMembers(formatted);
          }
        } else if (status === 'former') {
          if (append && page > 1) {
            setFormerMembers(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const newMembers = formatted.filter((m: MemberProfile) => !existingIds.has(m.id));
              return [...prev, ...newMembers];
            });
          } else if (!append) {
            setFormerMembers(formatted);
          }
          formerMembersFetched.current = true;
          formerMembersLastFetch.current = Date.now();
        }
        return {
          members: formatted,
          total: paginationInfo.total,
          page: paginationInfo.page,
          limit: data.limit || limit,
          totalPages: paginationInfo.totalPages,
          hasMore: paginationInfo.hasMore
        };
      }
      return { members: [], total: 0, page, limit, totalPages: 0, hasMore: false };
    } catch (err: unknown) {
      console.error('Failed to fetch paginated members:', err);
      return { members: [], total: 0, page, limit, totalPages: 0, hasMore: false };
    } finally {
      setIsFetchingMembers(false);
    }
  }, []);

  const directoryRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDirectoryRefreshRef = useRef<number>(0);

  useEffect(() => {
    const handleDirectoryUpdate = () => {
      const now = Date.now();
      if (now - lastDirectoryRefreshRef.current < 5000) return;
      if (directoryRefreshTimeoutRef.current) clearTimeout(directoryRefreshTimeoutRef.current);
      directoryRefreshTimeoutRef.current = setTimeout(() => {
        lastDirectoryRefreshRef.current = Date.now();
        refreshMembers();
      }, 500);
    };
    window.addEventListener('directory-update', handleDirectoryUpdate);
    window.addEventListener('member-data-updated', handleDirectoryUpdate);
    return () => {
      window.removeEventListener('directory-update', handleDirectoryUpdate);
      window.removeEventListener('member-data-updated', handleDirectoryUpdate);
      if (directoryRefreshTimeoutRef.current) clearTimeout(directoryRefreshTimeoutRef.current);
    };
  }, [refreshMembers]);

  useEffect(() => {
    const handleTierUpdate = (event: CustomEvent) => {
      const isStaff = actualUserRef.current?.role === 'staff' || actualUserRef.current?.role === 'admin';
      if (isStaff) {
        refreshMembers();
      }
    };
    window.addEventListener('tier-update', handleTierUpdate as EventListener);
    return () => {
      window.removeEventListener('tier-update', handleTierUpdate as EventListener);
    };
  }, [refreshMembers]);

  const updateMember = useCallback((item: MemberProfile) => setMembers(prev => prev.map(m => m.id === item.id ? item : m)), []);

  const contextValue = useMemo(() => ({
    members, formerMembers, fetchFormerMembers, fetchMembersPaginated,
    membersPagination, isFetchingMembers, updateMember, refreshMembers
  }), [members, formerMembers, fetchFormerMembers, fetchMembersPaginated,
    membersPagination, isFetchingMembers, updateMember, refreshMembers]);

  return (
    <MemberDataContext.Provider value={contextValue}>
      {children}
    </MemberDataContext.Provider>
  );
};

export const useMemberData = () => {
  const context = useContext(MemberDataContext);
  if (!context) {
    throw new Error('useMemberData must be used within a MemberDataProvider');
  }
  return context;
};
