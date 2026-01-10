import React, { createContext, useState, useContext, ReactNode, useEffect, useCallback, useRef } from 'react';
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
  fetchFormerMembers: () => Promise<void>;
  
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
  const formerMembersFetched = useRef(false);
  const [cafeMenuLoaded, setCafeMenuLoaded] = useState(false);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [announcementsLoaded, setAnnouncementsLoaded] = useState(false);
  const [cafeMenu, setCafeMenu] = useState<CafeItem[]>(INITIAL_CAFE);
  const [events, setEvents] = useState<EventData[]>(INITIAL_EVENTS);
  const [announcements, setAnnouncements] = useState<Announcement[]>(INITIAL_ANNOUNCEMENTS);
  const [members, setMembers] = useState<MemberProfile[]>(INITIAL_MEMBERS);
  const [formerMembers, setFormerMembers] = useState<MemberProfile[]>([]);
  const [bookings, setBookings] = useState<Booking[]>(INITIAL_BOOKINGS);
  
  const isDataReady = !isLoading && cafeMenuLoaded && eventsLoaded && announcementsLoaded;
  
  const isViewingAs = viewAsUser !== null;
  const user = viewAsUser || actualUser;

  useEffect(() => {
    if (storeUser && !actualUser) {
      setActualUser(storeUser as MemberProfile);
      setIsLoading(false);
    }
  }, [storeUser, actualUser]);

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
              lastBookingDate: undefined
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
  const setViewAsUser = async (member: MemberProfile) => {
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
  };
  
  const clearViewAsUser = () => {
    flushSync(() => {
      setViewAsUserState(null);
    });
  };

  // Fetch members from HubSpot for admin/staff users
  useEffect(() => {
    const fetchMembers = async () => {
      if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) return;
      
      try {
        const res = await fetch('/api/hubspot/contacts', { credentials: 'include' });
        if (res.ok) {
          const contacts = await res.json();
          const formatted: MemberProfile[] = contacts.map((contact: any) => ({
            id: contact.id,
            name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
            tier: contact.tier || 'Core',
            tags: contact.tags || [],
            status: contact.status || 'Active',
            email: contact.email || '',
            phone: contact.phone || '',
            role: 'member',
            lifetimeVisits: contact.lifetimeVisits || 0,
            lastBookingDate: contact.lastBookingDate || null,
            joinDate: contact.joinDate || null,
            mindbodyClientId: contact.mindbodyClientId || null,
            manuallyLinkedEmails: contact.manuallyLinkedEmails || []
          }));
          setMembers(formatted);
        }
      } catch (err) {
        console.error('Failed to fetch HubSpot contacts:', err);
      }
    };
    fetchMembers();
  }, [actualUser]);

  // Function to fetch former/inactive members on demand
  const fetchFormerMembers = useCallback(async () => {
    if (formerMembersFetched.current) return;
    if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) return;
    
    formerMembersFetched.current = true;
    
    try {
      const res = await fetch('/api/hubspot/contacts?status=former', { credentials: 'include' });
      if (res.ok) {
        const contacts = await res.json();
        if (Array.isArray(contacts)) {
          const formatted: MemberProfile[] = contacts.map((contact: any) => ({
            id: contact.id,
            name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
            tier: contact.tier || 'Unknown',
            tags: contact.tags || [],
            status: contact.status || 'Inactive',
            email: contact.email || '',
            phone: contact.phone || '',
            role: 'member',
            lifetimeVisits: contact.lifetimeVisits || 0,
            lastBookingDate: contact.lastBookingDate || null,
            joinDate: contact.joinDate || null,
            mindbodyClientId: contact.mindbodyClientId || null,
            manuallyLinkedEmails: contact.manuallyLinkedEmails || []
          }));
          setFormerMembers(formatted);
        }
      } else {
        console.error('Failed to fetch former members: API returned', res.status);
        formerMembersFetched.current = false;
      }
    } catch (err) {
      console.error('Failed to fetch former members:', err);
      formerMembersFetched.current = false;
    }
  }, [actualUser]);

  const refreshMembers = useCallback(async (): Promise<{ success: boolean; count: number }> => {
    if (!actualUser || (actualUser.role !== 'admin' && actualUser.role !== 'staff')) {
      return { success: false, count: 0 };
    }
    
    try {
      const res = await fetch('/api/hubspot/contacts?refresh=true', { credentials: 'include' });
      if (res.ok) {
        const contacts = await res.json();
        const formatted: MemberProfile[] = contacts.map((contact: any) => ({
          id: contact.id,
          name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown',
          tier: contact.tier || 'Core',
          tags: contact.tags || [],
          status: contact.status || 'Active',
          email: contact.email || '',
          phone: contact.phone || '',
          role: 'member',
          lifetimeVisits: contact.lifetimeVisits || 0,
          joinDate: contact.joinDate || null,
          mindbodyClientId: contact.mindbodyClientId || null,
          manuallyLinkedEmails: contact.manuallyLinkedEmails || []
        }));
        setMembers(formatted);
        formerMembersFetched.current = false;
        return { success: true, count: formatted.length };
      }
      return { success: false, count: 0 };
    } catch (err) {
      console.error('Failed to refresh members from HubSpot:', err);
      return { success: false, count: 0 };
    }
  }, [actualUser]);

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
        setCafeMenuLoaded(true);
      }
    });

    const directFetch = async () => {
      try {
        const res = await fetch('/api/cafe-menu');
        if (res.ok) {
          const contentType = res.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            const data = await res.json();
            if (isValidCafeData(data)) {
              setCafeMenu(formatCafeData(data));
              setCafeMenuLoaded(true);
            }
          }
        }
      } catch {}
      setCafeMenuLoaded(true);
    };

    const timer = setTimeout(() => {
      if (cafeMenu.length === 0) directFetch();
      else setCafeMenuLoaded(true);
    }, 1500);

    return () => clearTimeout(timer);
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
  useEffect(() => {
    const handleMemberStatsUpdate = (event: CustomEvent) => {
      const memberEmail = event.detail?.memberEmail;
      if (memberEmail && actualUser?.email?.toLowerCase() === memberEmail.toLowerCase()) {
        // Refresh user data when their stats are updated
        refreshUser();
      }
    };
    
    window.addEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    return () => {
      window.removeEventListener('member-stats-updated', handleMemberStatsUpdate as EventListener);
    };
  }, [actualUser?.email, refreshUser]);

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
      if (data?.length) setEvents(formatEventData(data));
      setEventsLoaded(true);
    });
    
    setTimeout(() => setEventsLoaded(true), 2000);
  }, []);

  // Auth Logic - verify member email
  const login = async (email: string) => {
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
  };

  const loginWithMember = (member: any) => {
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
  };

  const logout = async () => {
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
  };

  const refreshUser = async () => {
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

  // Cafe Actions (optimistic UI)
  const addCafeItem = async (item: CafeItem) => {
    const tempId = `temp-${Date.now()}`;
    const optimisticItem = { ...item, id: tempId };
    const snapshot = [...cafeMenu];
    
    setCafeMenu(prev => [...prev, optimisticItem]);
    
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
        setCafeMenu(snapshot);
      }
    } catch (err) {
      console.error('Failed to add cafe item:', err);
      setCafeMenu(snapshot);
    }
  };
  
  const updateCafeItem = async (item: CafeItem) => {
    const snapshot = [...cafeMenu];
    
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
        setCafeMenu(snapshot);
      }
    } catch (err) {
      console.error('Failed to update cafe item:', err);
      setCafeMenu(snapshot);
    }
  };
  
  const deleteCafeItem = async (id: string) => {
    const snapshot = [...cafeMenu];
    
    setCafeMenu(prev => prev.filter(i => i.id !== id));
    
    try {
      const res = await fetch(`/api/cafe-menu/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        setCafeMenu(snapshot);
      }
    } catch (err) {
      console.error('Failed to delete cafe item:', err);
      setCafeMenu(snapshot);
    }
  };

  // Event Actions
  const addEvent = async (item: Partial<EventData>) => {
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
  };

  const updateEvent = async (item: EventData) => {
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
  };

  const deleteEvent = async (id: string) => {
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
  };
  
  const syncEventbrite = async () => {
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
  };

  // Announcement Actions - API backed
  const addAnnouncement = async (item: Announcement) => {
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
  };
  
  const updateAnnouncement = async (item: Announcement) => {
    const snapshot = [...announcements];
    
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
        setAnnouncements(snapshot);
      }
    } catch (err) {
      console.error('Failed to update announcement:', err);
      setAnnouncements(snapshot);
    }
  };
  
  const deleteAnnouncement = async (id: string) => {
    const snapshot = [...announcements];
    setAnnouncements(prev => prev.filter(a => a.id !== id));
    
    try {
      const res = await fetch(`/api/announcements/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) {
        setAnnouncements(snapshot);
      }
    } catch (err) {
      console.error('Failed to delete announcement:', err);
      setAnnouncements(snapshot);
    }
  };

  // Member Actions
  const updateMember = (item: MemberProfile) => setMembers(prev => prev.map(m => m.id === item.id ? item : m));

  // Booking Actions
  const addBooking = (booking: Booking) => setBookings(prev => [booking, ...prev]);
  const deleteBooking = (id: string) => setBookings(prev => prev.filter(b => b.id !== id));

  return (
    <DataContext.Provider value={{
      user, actualUser, viewAsUser, isViewingAs,
      login, loginWithMember, logout, refreshUser, setViewAsUser, clearViewAsUser,
      cafeMenu, events, announcements, members, formerMembers, bookings, isLoading, isDataReady, sessionChecked, sessionVersion,
      fetchFormerMembers,
      addCafeItem, updateCafeItem, deleteCafeItem, refreshCafeMenu,
      addEvent, updateEvent, deleteEvent, syncEventbrite,
      addAnnouncement, updateAnnouncement, deleteAnnouncement,
      updateMember, refreshMembers, addBooking, deleteBooking
    }}>
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