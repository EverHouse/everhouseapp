import React, { ReactNode } from 'react';
import type { CafeItem, EventSource, EventData, Announcement, MemberProfile, Booking } from '../types/data';
import { AuthDataProvider } from './AuthDataContext';
import { MemberDataProvider } from './MemberDataContext';
import { CafeDataProvider } from './CafeDataContext';
import { EventDataProvider } from './EventDataContext';
import { AnnouncementDataProvider } from './AnnouncementDataContext';
import { BookingDataProvider } from './BookingDataContext';

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

