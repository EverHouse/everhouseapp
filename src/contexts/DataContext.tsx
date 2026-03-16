import React, { ReactNode, useMemo } from 'react';
import type { CafeItem, EventSource, EventData, Announcement, MemberProfile, Booking } from '../types/data';
import { AuthDataProvider, useAuthData } from './AuthDataContext';
import { MemberDataProvider, useMemberData } from './MemberDataContext';
import { CafeDataProvider, useCafeData } from './CafeDataContext';
import { EventDataProvider, useEventData } from './EventDataContext';
import { AnnouncementDataProvider, useAnnouncementData } from './AnnouncementDataContext';
import { BookingDataProvider, useBookingData } from './BookingDataContext';

export type { CafeItem, EventSource, EventData, Announcement, MemberProfile, Booking };
export type { PaginatedMembersResponse, FetchMembersOptions } from './MemberDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useAuthData } from './AuthDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useMemberData } from './MemberDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useCafeData } from './CafeDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useEventData } from './EventDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useAnnouncementData } from './AnnouncementDataContext';
// eslint-disable-next-line react-refresh/only-export-components
export { useBookingData } from './BookingDataContext';

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

  fetchMembersPaginated: (options?: import('./MemberDataContext').FetchMembersOptions) => Promise<import('./MemberDataContext').PaginatedMembersResponse>;
  membersPagination: { total: number; page: number; totalPages: number; hasMore: boolean } | null;
  isFetchingMembers: boolean;

  loginWithMember: (member: MemberProfile) => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;

  setViewAsUser: (member: MemberProfile) => Promise<void>;
  clearViewAsUser: () => void;

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
  refreshAnnouncements: () => Promise<void>;

  updateMember: (member: MemberProfile) => void;
  refreshMembers: () => Promise<{ success: boolean; count: number }>;

  addBooking: (booking: Booking) => void;
  deleteBooking: (id: string) => void;
}

export const DataProvider: React.FC<{children: ReactNode}> = ({ children }) => {
  return (
    <AuthDataProvider>
      <MemberDataProvider>
        <CafeDataProvider>
          <EventDataProvider>
            <AnnouncementDataProvider>
              <BookingDataProvider>
                {children}
              </BookingDataProvider>
            </AnnouncementDataProvider>
          </EventDataProvider>
        </CafeDataProvider>
      </MemberDataProvider>
    </AuthDataProvider>
  );
};

/** @deprecated Use specific hooks instead: useAuthData, useMemberData, useCafeData, useEventData, useAnnouncementData, useBookingData */
// eslint-disable-next-line react-refresh/only-export-components
export const useData = (): DataContextType => {
  const auth = useAuthData();
  const member = useMemberData();
  const cafe = useCafeData();
  const event = useEventData();
  const announcement = useAnnouncementData();
  const booking = useBookingData();

  const isDataReady = !auth.isLoading && auth.sessionChecked && cafe.cafeMenuLoaded && event.eventsLoaded && announcement.announcementsLoaded;

  return useMemo(() => ({
    user: auth.user,
    actualUser: auth.actualUser,
    viewAsUser: auth.viewAsUser,
    isViewingAs: auth.isViewingAs,
    isLoading: auth.isLoading,
    isDataReady,
    sessionChecked: auth.sessionChecked,
    sessionVersion: auth.sessionVersion,
    loginWithMember: auth.loginWithMember,
    logout: auth.logout,
    refreshUser: auth.refreshUser,
    setViewAsUser: auth.setViewAsUser,
    clearViewAsUser: auth.clearViewAsUser,

    members: member.members,
    formerMembers: member.formerMembers,
    fetchFormerMembers: member.fetchFormerMembers,
    fetchMembersPaginated: member.fetchMembersPaginated,
    membersPagination: member.membersPagination,
    isFetchingMembers: member.isFetchingMembers,
    updateMember: member.updateMember,
    refreshMembers: member.refreshMembers,

    cafeMenu: cafe.cafeMenu,
    addCafeItem: cafe.addCafeItem,
    updateCafeItem: cafe.updateCafeItem,
    deleteCafeItem: cafe.deleteCafeItem,
    refreshCafeMenu: cafe.refreshCafeMenu,

    events: event.events,
    addEvent: event.addEvent,
    updateEvent: event.updateEvent,
    deleteEvent: event.deleteEvent,
    syncEventbrite: event.syncEventbrite,

    announcements: announcement.announcements,
    addAnnouncement: announcement.addAnnouncement,
    updateAnnouncement: announcement.updateAnnouncement,
    deleteAnnouncement: announcement.deleteAnnouncement,
    refreshAnnouncements: announcement.refreshAnnouncements,

    bookings: booking.bookings,
    addBooking: booking.addBooking,
    deleteBooking: booking.deleteBooking
  }), [
    auth.user, auth.actualUser, auth.viewAsUser, auth.isViewingAs,
    auth.isLoading, auth.sessionChecked, auth.sessionVersion,
    auth.loginWithMember, auth.logout, auth.refreshUser,
    auth.setViewAsUser, auth.clearViewAsUser,
    member.members, member.formerMembers, member.fetchFormerMembers,
    member.fetchMembersPaginated, member.membersPagination, member.isFetchingMembers,
    member.updateMember, member.refreshMembers,
    cafe.cafeMenu, cafe.addCafeItem, cafe.updateCafeItem, cafe.deleteCafeItem, cafe.refreshCafeMenu,
    event.events, event.addEvent, event.updateEvent, event.deleteEvent, event.syncEventbrite,
    announcement.announcements, announcement.addAnnouncement, announcement.updateAnnouncement,
    announcement.deleteAnnouncement, announcement.refreshAnnouncements,
    booking.bookings, booking.addBooking, booking.deleteBooking,
    isDataReady
  ]);
};
