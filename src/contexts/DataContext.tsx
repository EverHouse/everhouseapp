import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { formatDateShort, formatTime12Hour } from '../utils/dateUtils';
import { useUserStore } from '../stores/userStore';
import { getCached, fetchAndCache, startBackgroundSync } from '../lib/backgroundSync';
import type { CafeItem, EventSource, EventData, Announcement, MemberProfile, Booking } from '../types/data';
import { 
  INITIAL_CAFE, 
  INITIAL_EVENTS, 
  INITIAL_ANNOUNCEMENTS, 
  INITIAL_MEMBERS, 
  INITIAL_BOOKINGS 
} from '../data/defaults';

export type { CafeItem, EventSource, EventData, Announcement, MemberProfile, Booking };

// Pagination response type for paginated member fetching
export interface PaginatedMembersResponse {
  members: MemberProfile[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

// Options for paginated member fetching
export interface FetchMembersOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: 'active' | 'former';
  append?: boolean; // If true, appends to existing cache instead of replacing
}

interface DataContextType {
  user: MemberProfile | null;
  actualUser: MemberProfile | null;
  viewAsUser: MemberProfile | null;
  isViewingAs: boolean;
  cafeMenu: CafeItem[];
  events: EventData[];
  announcements: Announcement[];
  members: MemberProfile[];
  formerMembers: MemberProfile[];
  bookings: Booking[];
  isLoading: boolean;
  isDataReady: boolean;
  sessionChecked: boolean;
  sessionVersion: number;
  fetchFormerMembers: (forceRefresh?: boolean) => Promise<void>;
  
  // Paginated member fetching
  fetchMembersPaginated: (options?: FetchMembersOptions) => Promise<PaginatedMembersResponse>;
  membersPagination: { total: number; page: number; totalPages: number; hasMore: boolean } | null;
  isFetchingMembers: boolean;
  
  // Auth Actions
  login: (email: string) => Promise<void>;
  loginWithMember: (member: any) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  
  // View As Actions
  setViewAsUser: (member: MemberProfile) => Promise<void>;
  clearViewAsUser: () => void;

  // Data Actions
  addCafeItem: (item: CafeItem) => Promise<void>;
  updateCafeItem: (item: CafeItem) => Promise<void>;
  deleteCafeItem: (id: string) => Promise<void>;
  refreshCafeMenu: () => Promise<void>;
  
  addEvent: (event: Partial<EventData>) => Promise<void>;
  updateEvent: (event: EventData) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  syncEventbrite: () => Promise<void>;

  addAnnouncement: (ann: Announcement) => Promise<void>;
  updateAnnouncement: (ann: Announcement) => Promise<void>;
  deleteAnnouncement: (id: string) => Promise<void>;

  updateMember: (member: MemberProfile) => void;
  refreshMembers: () => Promise<{ success: boolean; count: number }>;

  addBooking: (booking: Booking) => void;
  deleteBooking: (id: string) => void;
}

const DataContext = createContext<DataContextType | undefined>(undefined);


export const DataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  const storeUser = useUserStore((s) => s.user);
  const setStoreUser = useUserStore((s) => s.setUser);
  const clearStoreUser = useUserStore((s) => s.clearUser);
  const isHydrated = useUserStore((s) => s.isHydrated);
  
  const [actualUser, setActualUser] = useState<MemberProfile | null>(null);
  const [viewAsUser, setViewAsUserState] = useState<MemberProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [sessionChecked, setSessionChecked] = useState(false);
  const sessionCheckDone = useRef(false);
  const loginInProgressRef = useRef(false);
  const actualUserRef = useRef<MemberProfile | null>(null);
  const formerMembersFetched = useRef(false);
  const formerMembersLastFetch = useRef<number>(0);
  const FORMER_MEMBERS_CACHE_MS = 10 * 60 * 1000; // 10 minutes
  const [cafeMenuLoaded, setCafeMenuLoaded] = useState(false);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [announcementsLoaded, setAnnouncementsLoaded] = useState(false);
  const [cafeMenu, setCafeMenu] = useState<CafeItem[]>(INITIAL_CAFE);
  const [events, setEvents] = useState<EventData[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>(INITIAL_ANNOUNCEMENTS);
  const [members, setMembers] = useState<MemberProfile[]>(INITIAL_MEMBERS);
  const [formerMembers, setFormerMembers] = useState<MemberProfile[]>([]);
  const [bookings, setBookings] = useState<Booking[]>(INITIAL_BOOKINGS);
  const [membersPagination, setMembersPagination] = useState<{ total: number; page: number; totalPages: number; hasMore: boolean } | null>(null);
  const [isFetchingMembers, setIsFetchingMembers] = useState(false);
  const paginatedMembersCache = useRef<Map<string, MemberProfile[]>>(new Map());
  
  const isDataReady = !isLoading && sessionChecked && cafeMenuLoaded && eventsLoaded && announcementsLoaded;
  
  const isViewingAs = viewAsUser !== null;
  const user = viewAsUser || actualUser;

  useEffect(() => {
    if (storeUser && !actualUser) {
      setActualUser(storeUser as MemberProfile);
      setIsLoading(false);
    }
  }, [storeUser, actualUser]);

  // Keep ref in sync with actualUser state for use in callbacks
  useEffect(() => {
    actualUserRef.current = actualUser;
  }, [actualUser]);

  useEffect(() => {
    if (sessionCheckDone.current) return;
    sessionCheckDone.current = true;
    
    const initializeUser = async () => {
      // Screenshot token bypass for visual verification (dev only)
      // Check for dev-preview in pathname or hash
      const isDevPreview = window.location.pathname.includes('/dev-preview/') || 
                           window.location.hash.includes('/dev-preview/');
      
      const isScreenshotMode = isDevPreview;
      
      if (isScreenshotMode) {
        // Detect if it's an admin/staff preview route
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
          setIsLoading(false);
          setCafeMenuLoaded(true);
          setEventsLoaded(true);
          setAnnouncementsLoaded(true);
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
        setIsLoading(false);
        setCafeMenuLoaded(true);
        setEventsLoaded(true);
        setAnnouncementsLoaded(true);
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
            // Reset ref now that probe completed successfully
            loginInProgressRef.current = false;
            setSessionChecked(true);
            setIsLoading(false);
            return;
          }
        }
        
        if (sessionRes.status === 401 || sessionRes.status === 403) {
          // Only clear user if no login happened during the async check
          if (!loginInProgressRef.current) {
            localStorage.removeItem('eh_member');
            useUserStore.getState().clearUser();
            setActualUser(null);
          }
          // Reset the ref now that probe is complete
          loginInProgressRef.current = false;
          setSessionChecked(true);
          setIsLoading(false);
          return;
        }
      } catch (sessionErr) {
        console.error('Failed to verify session:', sessionErr);
      }
      
      const currentStoreUser = useUserStore.getState().user;
      if (currentStoreUser) {
        setActualUser(currentStoreUser as MemberProfile);
        setSessionChecked(true);
        setIsLoading(false);
        return;
      }
      
      const savedMember = localStorage.getItem('eh_member');
      if (savedMember) {
        try {
          const member = JSON.parse(savedMember);
          setActualUser(member);
          useUserStore.getState().setUser(member);
        } catch (err) {
          localStorage.removeItem('eh_member');
        }
      }
      // Reset the ref now that probe is complete
      loginInProgressRef.current = false;
      setSessionChecked(true);
      setIsLoading(false);
    };
    
    initializeUser();
  }, []);
  
  // View As Functions - only for admins (not staff)
  // Uses flushSync to ensure state updates are synchronous before navigation
  const setViewAsUser = useCallback(async (member: MemberProfile) => {
    if (actualUser?.role === 'admin') {
      try {
        const res = await fetch(`/api/members/${encodeURIComponent(member.email)}/details`, { credentials: 'include' });
        if (res.ok) {
          const details = await res.json();
          // HubSpot is the source of truth for tier and tags, so prioritize member values
          // The details from database may be stale, only use as fallback
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
      } catch (err) {
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

  // Fetch members from HubSpot for admin/staff users
  // Optimization: Only fetch first page (200 members) initially for faster load
  // Full member list loads on-demand via fetchMembersPaginated when accessing directory
  useEffect(() => {
    const fetchInitialMembers = async () => {
      if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) return;
      
      try {
        // Fetch all active members from database (up to 500)
        const res = await fetch('/api/members/directory?status=active', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const contacts = Array.isArray(data) ? data : (data.contacts || []);
          const formatted: MemberProfile[] = contacts.map((contact: any) => ({
            id: contact.id,
            name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
            tier: contact.tier || '',
            rawTier: contact.rawTier,
            tags: contact.tags || [],
            status: typeof contact.status === 'string' ? contact.status : 'Active',
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
            billingProvider: contact.billingProvider || contact.billing_provider || null
          }));
          setMembers(formatted);
          
          // Store pagination info for incremental loading
          if (data.total && data.totalPages) {
            setMembersPagination({
              total: data.total,
              page: 1,
              totalPages: data.totalPages,
              hasMore: data.hasMore || data.totalPages > 1
            });
          }
        }
      } catch (err) {
        console.error('Failed to fetch initial members:', err);
      }
    };
    fetchInitialMembers();
  }, [actualUser]);

  // Function to fetch former/inactive members on demand with 10-minute cache
  // Uses actualUserRef to avoid stale closure issues when session loads after mount
  const fetchFormerMembers = useCallback(async (forceRefresh = false) => {
    const currentUser = actualUserRef.current;
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'staff')) return;
    
    const now = Date.now();
    
    // Skip fetch if cache is valid AND we're not forcing a refresh
    if (!forceRefresh) {
      const cacheAge = now - formerMembersLastFetch.current;
      const cacheValid = formerMembersFetched.current && cacheAge < FORMER_MEMBERS_CACHE_MS;
      
      if (cacheValid) {
        return;
      }
    }
    
    try {
      const res = await fetch('/api/members/directory?status=former', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted: MemberProfile[] = contacts.map((contact: any) => ({
          id: contact.id,
          name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
          tier: contact.tier || '',
          rawTier: contact.rawTier,
          tags: contact.tags || [],
          status: typeof contact.status === 'string' ? contact.status : 'Inactive',
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
          billingProvider: contact.billingProvider || contact.billing_provider || null
        }));
        setFormerMembers(formatted);
        formerMembersFetched.current = true;
        formerMembersLastFetch.current = now;
      } else {
        console.error('Failed to fetch former members: API returned', res.status);
      }
    } catch (err) {
      console.error('Failed to fetch former members:', err);
    }
  }, []);

  const refreshMembers = useCallback(async (): Promise<{ success: boolean; count: number }> => {
    if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) {
      return { success: false, count: 0 };
    }
    
    try {
      const res = await fetch('/api/members/directory?status=active', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted: MemberProfile[] = contacts.map((contact: any) => ({
          id: contact.id,
          name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
          tier: contact.tier || '',
          rawTier: contact.rawTier,
          tags: contact.tags || [],
          status: typeof contact.status === 'string' ? contact.status : 'Active',
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
          billingProvider: contact.billingProvider || contact.billing_provider || null
        }));
        setMembers(formatted);
        formerMembersFetched.current = false;
        return { success: true, count: formatted.length };
      }
      return { success: false, count: 0 };
    } catch (err) {
      console.error('Failed to refresh members from database:', err);
      return { success: false, count: 0 };
    }
  }, [actualUser]);

  // Paginated member fetching with local cache that grows as pages are fetched
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
      
      if (search.trim()) {
        params.set('search', search.trim());
      }
      
      const res = await fetch(`/api/members/directory?${params.toString()}`, { credentials: 'include' });
      
      if (res.ok) {
        const data = await res.json();
        const contacts = Array.isArray(data) ? data : (data.contacts || []);
        const formatted: MemberProfile[] = contacts.map((contact: any) => ({
          id: contact.id,
          name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
          tier: contact.tier || '',
          rawTier: contact.rawTier,
          tags: contact.tags || [],
          status: typeof contact.status === 'string' ? contact.status : (status === 'active' ? 'Active' : 'Inactive'),
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
          billingProvider: contact.billingProvider || contact.billing_provider || null
        }));
        
        // Update pagination info
        const paginationInfo = {
          total: data.total || formatted.length,
          page: data.page || page,
          totalPages: data.totalPages || 1,
          hasMore: data.hasMore || false
        };
        setMembersPagination(paginationInfo);
        
        // Update the appropriate members state based on status
        if (status === 'active') {
          if (append && page > 1) {
            // Append to existing members (for "load more" functionality)
            setMembers(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const newMembers = formatted.filter(m => !existingIds.has(m.id));
              return [...prev, ...newMembers];
            });
          } else if (!append) {
            // Replace members (for new search or page 1)
            setMembers(formatted);
          }
        } else if (status === 'former') {
          if (append && page > 1) {
            setFormerMembers(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const newMembers = formatted.filter(m => !existingIds.has(m.id));
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
    } catch (err) {
      console.error('Failed to fetch paginated members:', err);
      return { members: [], total: 0, page, limit, totalPages: 0, hasMore: false };
    } finally {
      setIsFetchingMembers(false);
    }
  }, []);

  // Start background sync
  useEffect(() => {
    startBackgroundSync();
  }, []);

  // Fetch cafe menu with background sync
  useEffect(() => {
    const formatCafeData = (data: any[]) => data.map((item: any) => ({
      id: item.id.toString(),
      category: item.category,
      name: item.name,
      price: parseFloat(item.price) || 0,
      desc: item.description || '',
      icon: item.icon || '',
      image: item.image_url || ''
    }));

    const isValidCafeData = (data: any): data is any[] => {
      return Array.isArray(data) && data.length > 0 && data[0]?.name;
    };

    const cached = getCached<any[]>('cafe_menu');
    if (isValidCafeData(cached)) {
      setCafeMenu(formatCafeData(cached));
    }

    fetchAndCache<any[]>('cafe_menu', '/api/cafe-menu', (data) => {
      if (isValidCafeData(data)) {
        setCafeMenu(formatCafeData(data));
      }
      setCafeMenuLoaded(true);
    }).then(() => {
      setCafeMenuLoaded(true);
    }).catch(() => {
      setCafeMenuLoaded(true);
    });

    if (cached?.length) {
      setCafeMenuLoaded(true);
    }
  }, []);

  // Function to refresh announcements
  const refreshAnnouncements = useCallback(async () => {
    try {
      const res = await fetch('/api/announcements?active_only=true');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAnnouncements(data);
        }
      }
    } catch (err) {
      console.error('Failed to fetch announcements:', err);
    }
  }, []);

  // Fetch announcements from API (active only - already filtered and priority-sorted by API)
  useEffect(() => {
    const fetchAnnouncements = async () => {
      try {
        const res = await fetch('/api/announcements?active_only=true');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setAnnouncements(data);
          }
        }
      } catch (err) {
        console.error('Failed to fetch announcements:', err);
      } finally {
        setAnnouncementsLoaded(true);
      }
    };
    fetchAnnouncements();
  }, []);

  // Listen for real-time announcement updates via WebSocket
  useEffect(() => {
    const handleAnnouncementUpdate = () => {
      refreshAnnouncements();
    };
    
    window.addEventListener('announcement-update', handleAnnouncementUpdate);
    return () => {
      window.removeEventListener('announcement-update', handleAnnouncementUpdate);
    };
  }, [refreshAnnouncements]);

  const refreshCafeMenu = useCallback(async () => {
    const formatCafeData = (data: any[]) => data.map((item: any) => ({
      id: item.id.toString(),
      category: item.category,
      name: item.name,
      price: parseFloat(item.price) || 0,
      desc: item.description || '',
      icon: item.icon || '',
      image: item.image_url || ''
    }));
    try {
      const res = await fetch('/api/cafe-menu');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setCafeMenu(formatCafeData(data));
        }
      }
    } catch {}
  }, []);

  // Listen for real-time cafe menu updates via WebSocket
  useEffect(() => {
    const handleCafeMenuUpdate = () => {
      refreshCafeMenu();
    };
    
    window.addEventListener('cafe-menu-update', handleCafeMenuUpdate);
    return () => {
      window.removeEventListener('cafe-menu-update', handleCafeMenuUpdate);
    };
  }, [refreshCafeMenu]);

  // Listen for real-time directory updates via WebSocket (staff-only, for member sync)
  useEffect(() => {
    const handleDirectoryUpdate = () => {
      refreshMembers();
    };
    
    window.addEventListener('directory-update', handleDirectoryUpdate);
    window.addEventListener('member-data-updated', handleDirectoryUpdate);
    return () => {
      window.removeEventListener('directory-update', handleDirectoryUpdate);
      window.removeEventListener('member-data-updated', handleDirectoryUpdate);
    };
  }, [refreshMembers]);

  // Listen for member stats updates (visit counts, guest passes) - refresh current user if it's their data
  // Use a ref to avoid dependency on refreshUser which changes every render
  const refreshUserRef = useRef<() => Promise<void>>();
  useEffect(() => {
    refreshUserRef.current = async () => {
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
      } catch (err) {
        console.error('Failed to refresh user data:', err);
      }
    };
  }, [actualUser?.email]);

  useEffect(() => {
    const handleMemberStatsUpdate = (event: CustomEvent) => {
      const memberEmail = event.detail?.memberEmail;
      const currentEmail = actualUser?.email;
      if (!currentEmail) return; // Guard: don't refresh if logged out
      if (memberEmail && currentEmail.toLowerCase() === memberEmail.toLowerCase()) {
        refreshUserRef.current?.();
      }
    };
    
    window.addEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    return () => {
      window.removeEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    };
  }, [actualUser?.email]);

  // Listen for tier assignment updates via WebSocket
  useEffect(() => {
    const handleTierUpdate = (event: CustomEvent) => {
      const memberEmail = event.detail?.memberEmail;
      const currentEmail = actualUser?.email;
      const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';
      
      // If the current user's tier was updated, refresh their profile
      if (currentEmail && memberEmail && currentEmail.toLowerCase() === memberEmail.toLowerCase()) {
        refreshUserRef.current?.();
      }
      
      // If staff, also refresh the members list to reflect the change
      if (isStaff) {
        refreshMembers();
      }
    };
    
    window.addEventListener('tier-update', handleTierUpdate as EventListener);
    return () => {
      window.removeEventListener('tier-update', handleTierUpdate as EventListener);
    };
  }, [actualUser?.email, actualUser?.role, refreshMembers]);

  // Listen for billing updates via WebSocket (staff only - refresh billing data)
  useEffect(() => {
    const handleBillingUpdate = () => {
      const isStaff = actualUser?.role === 'staff' || actualUser?.role === 'admin';
      if (isStaff) {
        // Dispatch a custom event that billing components can listen to for refreshing their data
        window.dispatchEvent(new CustomEvent('billing-data-refresh'));
      }
    };
    
    window.addEventListener('billing-update', handleBillingUpdate as EventListener);
    return () => {
      window.removeEventListener('billing-update', handleBillingUpdate as EventListener);
    };
  }, [actualUser?.role]);

  // Fetch events with background sync
  useEffect(() => {
    const normalizeCategory = (cat: string | null | undefined): string => {
      if (!cat) return 'Social';
      const lower = cat.toLowerCase();
      const categoryMap: Record<string, string> = {
        'wellness': 'Wellness',
        'social': 'Social',
        'dining': 'Dining',
        'sport': 'Sport',
        'sports': 'Sport',
      };
      return categoryMap[lower] || cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
    };

    const formatEventData = (data: any[]) => data.map((event: any) => ({
      id: event.id.toString(),
      source: event.source === 'eventbrite' ? 'eventbrite' : 'internal',
      externalLink: event.eventbrite_url || undefined,
      title: event.title,
      category: normalizeCategory(event.category),
      date: formatDateShort(event.event_date),
      time: event.start_time ? formatTime12Hour(event.start_time) : 'TBD',
      location: event.location || 'Ever House',
      image: event.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
      description: event.description || '',
      attendees: [],
      capacity: event.max_attendees || undefined,
      ticketsSold: undefined
    })) as EventData[];

    const cached = getCached<any[]>('events');
    if (cached?.length) {
      setEvents(formatEventData(cached));
    }

    fetchAndCache<any[]>('events', '/api/events', (data) => {
      // Always set events from API response, even if empty - this clears hardcoded placeholder data
      if (Array.isArray(data)) {
        setEvents(data.length ? formatEventData(data) : []);
      }
      setEventsLoaded(true);
    });
  }, []);

  // Auth Logic - verify member email
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
    
    // Only set ref if session check is still in progress (race protection)
    if (!sessionChecked) {
      loginInProgressRef.current = true;
    }
    localStorage.setItem('eh_member', JSON.stringify(memberProfile));
    setActualUser(memberProfile);
    useUserStore.getState().setUser(memberProfile);
    setSessionVersion(v => v + 1);
  }, [sessionChecked]);

  const loginWithMember = useCallback((member: any) => {
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
    
    // Only set ref if session check is still in progress (race protection)
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
    } catch (err) {
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
    } catch (err) {
      console.error('Failed to refresh user data:', err);
    }
  }, [actualUser?.email]);

  // Cafe Actions (optimistic UI)
  const addCafeItem = useCallback(async (item: CafeItem) => {
    const tempId = `temp-${Date.now()}`;
    const optimisticItem = { ...item, id: tempId };
    
    setCafeMenu(prev => {
      const snapshot = [...prev];
      return [...prev, optimisticItem];
    });
    
    try {
      const res = await fetch('/api/cafe-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: item.category,
          name: item.name,
          price: item.price,
          description: item.desc,
          icon: item.icon,
          image_url: item.image
        })
      });
      if (res.ok) {
        const newItem = await res.json();
        setCafeMenu(prev => prev.map(i => i.id === tempId ? {
          id: newItem.id.toString(),
          category: newItem.category,
          name: newItem.name,
          price: parseFloat(newItem.price) || 0,
          desc: newItem.description || '',
          icon: newItem.icon || '',
          image: newItem.image_url || ''
        } : i));
      } else {
        setCafeMenu(prev => prev.filter(i => i.id !== tempId));
      }
    } catch (err) {
      console.error('Failed to add cafe item:', err);
      setCafeMenu(prev => prev.filter(i => i.id !== tempId));
    }
  }, []);
  
  const updateCafeItem = useCallback(async (item: CafeItem) => {
    setCafeMenu(prev => prev.map(i => i.id === item.id ? item : i));
    
    try {
      const res = await fetch(`/api/cafe-menu/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: item.category,
          name: item.name,
          price: item.price,
          description: item.desc,
          icon: item.icon,
          image_url: item.image
        })
      });
      if (!res.ok) {
        refreshCafeMenu();
      }
    } catch (err) {
      console.error('Failed to update cafe item:', err);
      refreshCafeMenu();
    }
  }, [refreshCafeMenu]);
  
  const deleteCafeItem = useCallback(async (id: string) => {
    setCafeMenu(prev => prev.filter(i => i.id !== id));
    
    try {
      const res = await fetch(`/api/cafe-menu/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        refreshCafeMenu();
      }
    } catch (err) {
      console.error('Failed to delete cafe item:', err);
      refreshCafeMenu();
    }
  }, [refreshCafeMenu]);

  // Event Actions
  const addEvent = useCallback(async (item: Partial<EventData>) => {
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          event_date: item.date,
          start_time: item.time,
          location: item.location,
          category: item.category,
          image_url: item.image,
          max_attendees: item.capacity
        })
      });
      if (res.ok) {
        const data = await res.json();
        const formatted = {
          id: data.id.toString(),
          source: data.source === 'eventbrite' ? 'eventbrite' : 'internal',
          externalLink: data.eventbrite_url || undefined,
          title: data.title,
          category: data.category || 'Social',
          date: formatDateShort(data.event_date),
          time: data.start_time || 'TBD',
          location: data.location || 'Ever House',
          image: data.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
          description: data.description || '',
          attendees: [],
          capacity: data.max_attendees || undefined,
          ticketsSold: undefined
        } as EventData;
        setEvents(prev => [...prev, formatted]);
      }
    } catch (err) {
      console.error('Failed to add event:', err);
    }
  }, []);

  const updateEvent = useCallback(async (item: EventData) => {
    try {
      const res = await fetch(`/api/events/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          event_date: item.date,
          start_time: item.time,
          location: item.location,
          category: item.category,
          image_url: item.image,
          max_attendees: item.capacity
        })
      });
      if (res.ok) {
        const data = await res.json();
        const formatted = {
          id: data.id.toString(),
          source: data.source === 'eventbrite' ? 'eventbrite' : 'internal',
          externalLink: data.eventbrite_url || undefined,
          title: data.title,
          category: data.category || 'Social',
          date: formatDateShort(data.event_date),
          time: data.start_time || 'TBD',
          location: data.location || 'Ever House',
          image: data.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
          description: data.description || '',
          attendees: [],
          capacity: data.max_attendees || undefined,
          ticketsSold: undefined
        } as EventData;
        setEvents(prev => prev.map(i => i.id === formatted.id ? formatted : i));
      }
    } catch (err) {
      console.error('Failed to update event:', err);
    }
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/events/${id}`, { 
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        setEvents(prev => prev.filter(i => i.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete event:', err);
    }
  }, []);
  
  const syncEventbrite = useCallback(async () => {
    try {
      const res = await fetch('/api/eventbrite/sync', { method: 'POST' });
      if (res.ok) {
        const eventsRes = await fetch('/api/events');
        if (eventsRes.ok) {
          const data = await eventsRes.json();
          if (data?.length) {
            const formatEventData = (events: any[]) => events.map((event: any) => ({
              id: event.id.toString(),
              source: event.source === 'eventbrite' ? 'eventbrite' : 'internal',
              externalLink: event.eventbrite_url || undefined,
              title: event.title,
              category: event.category || 'Social',
              date: formatDateShort(event.event_date),
              time: event.start_time || 'TBD',
              location: event.location || 'Ever House',
              image: event.image_url || 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?q=80&w=1000&auto=format&fit=crop',
              description: event.description || '',
              attendees: [],
              capacity: event.max_attendees || undefined,
              ticketsSold: undefined
            })) as EventData[];
            setEvents(formatEventData(data));
          }
        }
      }
    } catch (err) {
      console.error('Failed to sync Eventbrite:', err);
    }
  }, []);

  // Announcement Actions - API backed
  const addAnnouncement = useCallback(async (item: Announcement) => {
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.desc,
          type: item.type,
          priority: item.priority || 'normal',
          startDate: item.startDate || null,
          endDate: item.endDate || null,
          linkType: item.linkType || null,
          linkTarget: item.linkTarget || null,
          notifyMembers: item.notifyMembers || false
        })
      });
      if (res.ok) {
        const newItem = await res.json();
        setAnnouncements(prev => [newItem, ...prev]);
      }
    } catch (err) {
      console.error('Failed to add announcement:', err);
    }
  }, []);
  
  const updateAnnouncement = useCallback(async (item: Announcement) => {
    // Optimistically update
    setAnnouncements(prev => prev.map(a => a.id === item.id ? item : a));
    
    try {
      const res = await fetch(`/api/announcements/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title,
          description: item.desc,
          type: item.type,
          priority: item.priority || 'normal',
          startDate: item.startDate || null,
          endDate: item.endDate || null,
          linkType: item.linkType || null,
          linkTarget: item.linkTarget || null,
          notifyMembers: item.notifyMembers || false
        })
      });
      if (res.ok) {
        const updated = await res.json();
        // Update with server data to ensure consistency (e.g. server-side timestamps)
        setAnnouncements(prev => prev.map(a => a.id === updated.id ? updated : a));
      } else {
        refreshAnnouncements();
      }
    } catch (err) {
      console.error('Failed to update announcement:', err);
      refreshAnnouncements();
    }
  }, [refreshAnnouncements]);
  
  const deleteAnnouncement = useCallback(async (id: string) => {
    setAnnouncements(prev => prev.filter(a => a.id !== id));
    
    try {
      const res = await fetch(`/api/announcements/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) {
        refreshAnnouncements();
      }
    } catch (err) {
      console.error('Failed to delete announcement:', err);
      refreshAnnouncements();
    }
  }, [refreshAnnouncements]);

  // Member Actions
  const updateMember = useCallback((item: MemberProfile) => setMembers(prev => prev.map(m => m.id === item.id ? item : m)), []);

  // Booking Actions
  const addBooking = useCallback((booking: Booking) => setBookings(prev => [booking, ...prev]), []);
  const deleteBooking = useCallback((id: string) => setBookings(prev => prev.filter(b => b.id !== id)), []);

  // Memoize the context value to prevent unnecessary re-renders
  // Only re-creates when any of the dependencies change
  const contextValue = useMemo(() => ({
    user, actualUser, viewAsUser, isViewingAs,
    login, loginWithMember, logout, refreshUser, setViewAsUser, clearViewAsUser,
    cafeMenu, events, announcements, members, formerMembers, bookings, isLoading, isDataReady, sessionChecked, sessionVersion,
    fetchFormerMembers,
    fetchMembersPaginated, membersPagination, isFetchingMembers,
    addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu,
    addEvent, updateEvent, deleteEvent, syncEventbrite,
    addAnnouncement, updateAnnouncement, deleteAnnouncement,
    updateMember, refreshMembers, addBooking, deleteBooking
  }), [
    user, actualUser, viewAsUser, isViewingAs,
    login, loginWithMember, logout, refreshUser, setViewAsUser, clearViewAsUser,
    cafeMenu, events, announcements, members, formerMembers, bookings, isLoading, isDataReady, sessionChecked, sessionVersion,
    fetchFormerMembers,
    fetchMembersPaginated, membersPagination, isFetchingMembers,
    addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu,
    addEvent, updateEvent, deleteEvent, syncEventbrite,
    addAnnouncement, updateAnnouncement, deleteAnnouncement,
    updateMember, refreshMembers, addBooking, deleteBooking
  ]);

  return (
    <DataContext.Provider value={contextValue}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = () => {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};