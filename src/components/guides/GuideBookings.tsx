import ContextualHelp from '../ContextualHelp';

const BOOKINGS_GUIDE_IDS = [
  'booking-requests',
  'multi-member-bookings',
  'booking-reschedule',
  'conference-rooms',
  'checkin-billing',
  'card-reader',
];

export default function GuideBookings() {
  return <ContextualHelp guideIds={BOOKINGS_GUIDE_IDS} title="Bookings Guide" />;
}
