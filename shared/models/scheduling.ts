import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric, pgEnum } from "drizzle-orm/pg-core";

export const bookingSourceEnum = pgEnum("booking_source", ["member_request", "staff_manual", "trackman_import"]);
export const paymentMethodEnum = pgEnum("payment_method", ["guest_pass", "credit_card", "unpaid", "waived"]);
export const participantTypeEnum = pgEnum("participant_type", ["owner", "member", "guest"]);
export const participantPaymentStatusEnum = pgEnum("participant_payment_status", ["pending", "paid", "waived"]);

// Resources table - bookable resources
export const resources = pgTable("resources", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  type: varchar("type").notNull(),
  description: text("description"),
  capacity: integer("capacity").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// Availability blocks table - blocked time slots
// Note: resource_id references resources.id (simulators and conference room)
export const availabilityBlocks = pgTable("availability_blocks", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id"),
  blockDate: date("block_date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  blockType: varchar("block_type").notNull(),
  notes: text("notes"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  closureId: integer("closure_id"),
  eventId: integer("event_id"),
  wellnessClassId: integer("wellness_class_id"),
}, (table) => [
  uniqueIndex("availability_blocks_resource_unique_idx").on(
    table.resourceId, table.blockDate, table.startTime, table.endTime, table.closureId
  )
]);

// Booking requests table - pending booking requests
export const bookingRequests = pgTable("booking_requests", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email").notNull(),
  userName: varchar("user_name"),
  resourceId: integer("resource_id"),
  resourcePreference: varchar("resource_preference"),
  requestDate: date("request_date").notNull(),
  startTime: time("start_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  endTime: time("end_time").notNull(),
  notes: text("notes"),
  status: varchar("status").default("pending"),
  staffNotes: text("staff_notes"),
  suggestedTime: time("suggested_time"),
  reviewedBy: varchar("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  calendarEventId: varchar("calendar_event_id"),
  rescheduleBookingId: integer("reschedule_booking_id"),
  trackmanBookingId: varchar("trackman_booking_id"),
  originalBookedDate: timestamp("original_booked_date"),
  guestCount: integer("guest_count").default(0),
  trackmanPlayerCount: integer("trackman_player_count"),
  sessionId: integer("session_id"),
  declaredPlayerCount: integer("declared_player_count"),
  finalPlayerCount: integer("final_player_count"),
  originalStartTime: time("original_start_time"),
  originalEndTime: time("original_end_time"),
  originalResourceId: integer("original_resource_id"),
  memberNotes: varchar("member_notes", { length: 280 }),
  reconciliationStatus: varchar("reconciliation_status"),
  reconciliationNotes: text("reconciliation_notes"),
  reconciledBy: varchar("reconciled_by"),
  reconciledAt: timestamp("reconciled_at"),
}, (table) => [
  uniqueIndex("booking_requests_trackman_id_idx").on(table.trackmanBookingId),
  index("booking_requests_session_idx").on(table.sessionId),
  index("booking_requests_date_resource_idx").on(table.requestDate, table.resourceId),
]);

// Facility closures table - scheduled closures
export const facilityClosures = pgTable("facility_closures", {
  id: serial("id").primaryKey(),
  title: varchar("title").notNull(),
  reason: text("reason"),
  noticeType: varchar("notice_type"),
  startDate: date("start_date").notNull(),
  startTime: time("start_time"),
  endDate: date("end_date").notNull(),
  endTime: time("end_time"),
  affectedAreas: varchar("affected_areas"),
  notifyMembers: boolean("notify_members").default(false),
  isActive: boolean("is_active").default(true),
  needsReview: boolean("needs_review").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: varchar("created_by"),
  googleCalendarId: varchar("google_calendar_id"),
  conferenceCalendarId: varchar("conference_calendar_id"),
  internalCalendarId: varchar("internal_calendar_id"),
});

// Trackman unmatched bookings - historical bookings that couldn't be matched to members
export const trackmanUnmatchedBookings = pgTable("trackman_unmatched_bookings", {
  id: serial("id").primaryKey(),
  trackmanBookingId: varchar("trackman_booking_id").notNull(),
  userName: varchar("user_name"),
  originalEmail: varchar("original_email"),
  bookingDate: date("booking_date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  durationMinutes: integer("duration_minutes"),
  status: varchar("status"),
  bayNumber: varchar("bay_number"),
  playerCount: integer("player_count"),
  notes: text("notes"),
  matchAttemptReason: text("match_attempt_reason"),
  resolvedEmail: varchar("resolved_email"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Trackman import runs - track import history
export const trackmanImportRuns = pgTable("trackman_import_runs", {
  id: serial("id").primaryKey(),
  filename: varchar("filename").notNull(),
  totalRows: integer("total_rows").notNull(),
  matchedRows: integer("matched_rows").notNull(),
  unmatchedRows: integer("unmatched_rows").notNull(),
  skippedRows: integer("skipped_rows").notNull(),
  importedBy: varchar("imported_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Tours table - scheduled tours synced from HubSpot Meetings (legacy: Google Calendar)
export const tours = pgTable("tours", {
  id: serial("id").primaryKey(),
  googleCalendarId: varchar("google_calendar_id").unique(),
  hubspotMeetingId: varchar("hubspot_meeting_id").unique(),
  title: varchar("title").notNull(),
  guestName: varchar("guest_name"),
  guestEmail: varchar("guest_email"),
  guestPhone: varchar("guest_phone"),
  tourDate: date("tour_date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time"),
  notes: text("notes"),
  status: varchar("status").default("scheduled"),
  checkedInAt: timestamp("checked_in_at"),
  checkedInBy: varchar("checked_in_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Closure reasons table - configurable dropdown options for closure reason
export const closureReasons = pgTable("closure_reasons", {
  id: serial("id").primaryKey(),
  label: varchar("label", { length: 255 }).notNull().unique(),
  sortOrder: integer("sort_order").default(100),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ClosureReason = typeof closureReasons.$inferSelect;
export type InsertClosureReason = typeof closureReasons.$inferInsert;

// Booking members junction table - links multiple members to a single booking
export const bookingMembers = pgTable("booking_members", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull(),
  userEmail: varchar("user_email"), // nullable - empty slot until linked
  slotNumber: integer("slot_number").notNull(), // 1, 2, 3, etc.
  isPrimary: boolean("is_primary").default(false),
  trackmanBookingId: varchar("trackman_booking_id"),
  linkedAt: timestamp("linked_at"), // when the member was linked to this slot
  linkedBy: varchar("linked_by"), // who linked this member (admin email)
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("booking_members_booking_id_idx").on(table.bookingId),
  index("booking_members_user_email_idx").on(table.userEmail),
]);

// Booking guests table - tracks guests (non-members) on bookings
export const bookingGuests = pgTable("booking_guests", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull(),
  guestName: varchar("guest_name"),
  guestEmail: varchar("guest_email"), // nullable
  slotNumber: integer("slot_number").notNull(),
  trackmanBookingId: varchar("trackman_booking_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("booking_guests_booking_id_idx").on(table.bookingId),
]);

export type BookingMember = typeof bookingMembers.$inferSelect;
export type InsertBookingMember = typeof bookingMembers.$inferInsert;
export type BookingGuest = typeof bookingGuests.$inferSelect;
export type InsertBookingGuest = typeof bookingGuests.$inferInsert;

export type Tour = typeof tours.$inferSelect;
export type InsertTour = typeof tours.$inferInsert;
export type TrackmanUnmatchedBooking = typeof trackmanUnmatchedBookings.$inferSelect;
export type InsertTrackmanUnmatchedBooking = typeof trackmanUnmatchedBookings.$inferInsert;
export type TrackmanImportRun = typeof trackmanImportRuns.$inferSelect;

// ============================================================================
// Multi-Member Booking System Tables (Phase 1)
// ============================================================================

// Booking sessions table - central hub linking bookings to Trackman and participants
export const bookingSessions = pgTable("booking_sessions", {
  id: serial("id").primaryKey(),
  trackmanBookingId: varchar("trackman_booking_id").unique(),
  resourceId: integer("resource_id").notNull(),
  sessionDate: date("session_date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  source: bookingSourceEnum("source").default("member_request"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("booking_sessions_resource_date_idx").on(table.resourceId, table.sessionDate),
  index("booking_sessions_trackman_idx").on(table.trackmanBookingId),
]);

// Guests table - persistent guest tracking across bookings
export const guests = pgTable("guests", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull(),
  email: varchar("email"),
  phone: varchar("phone"),
  createdByMemberId: varchar("created_by_member_id"),
  lastVisitDate: date("last_visit_date"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("guests_email_idx").on(table.email),
  index("guests_created_by_idx").on(table.createdByMemberId),
]);

// Usage ledger table - tracks per-member time and fees with tier snapshot
export const usageLedger = pgTable("usage_ledger", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  memberId: varchar("member_id"),
  minutesCharged: integer("minutes_charged").notNull().default(0),
  overageFee: numeric("overage_fee", { precision: 10, scale: 2 }).default("0.00"),
  guestFee: numeric("guest_fee", { precision: 10, scale: 2 }).default("0.00"),
  tierAtBooking: varchar("tier_at_booking"),
  paymentMethod: paymentMethodEnum("payment_method").default("unpaid"),
  source: bookingSourceEnum("source").default("member_request"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("usage_ledger_session_idx").on(table.sessionId),
  index("usage_ledger_member_idx").on(table.memberId),
]);

// Booking participants table - unified table for all participants (replaces booking_members/booking_guests)
export const bookingParticipants = pgTable("booking_participants", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  userId: varchar("user_id"),
  guestId: integer("guest_id"),
  participantType: participantTypeEnum("participant_type").notNull(),
  displayName: varchar("display_name").notNull(),
  slotDuration: integer("slot_duration"),
  paymentStatus: participantPaymentStatusEnum("payment_status").default("pending"),
  trackmanPlayerRowId: varchar("trackman_player_row_id"),
  inviteStatus: varchar("invite_status").default("pending"),
  invitedAt: timestamp("invited_at"),
  respondedAt: timestamp("responded_at"),
  inviteExpiresAt: timestamp("invite_expires_at"),
  expiredReason: varchar("expired_reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("booking_participants_session_idx").on(table.sessionId),
  index("booking_participants_user_idx").on(table.userId),
  index("booking_participants_guest_idx").on(table.guestId),
]);

// Booking payment audit table - tracks staff actions on payments for audit
export const paymentAuditActionEnum = pgEnum("payment_audit_action", [
  "payment_confirmed", 
  "payment_waived", 
  "tier_override", 
  "staff_direct_add",
  "checkin_guard_triggered",
  "reconciliation_adjusted"
]);

export const bookingPaymentAudit = pgTable("booking_payment_audit", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull(),
  sessionId: integer("session_id"),
  participantId: integer("participant_id"),
  action: paymentAuditActionEnum("action").notNull(),
  staffEmail: varchar("staff_email").notNull(),
  staffName: varchar("staff_name"),
  reason: text("reason"),
  amountAffected: numeric("amount_affected", { precision: 10, scale: 2 }),
  previousStatus: varchar("previous_status"),
  newStatus: varchar("new_status"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("booking_payment_audit_booking_idx").on(table.bookingId),
  index("booking_payment_audit_session_idx").on(table.sessionId),
  index("booking_payment_audit_staff_idx").on(table.staffEmail),
]);

export type BookingSession = typeof bookingSessions.$inferSelect;
export type InsertBookingSession = typeof bookingSessions.$inferInsert;
export type Guest = typeof guests.$inferSelect;
export type InsertGuest = typeof guests.$inferInsert;
export type UsageLedger = typeof usageLedger.$inferSelect;
export type InsertUsageLedger = typeof usageLedger.$inferInsert;
export type BookingParticipant = typeof bookingParticipants.$inferSelect;
export type InsertBookingParticipant = typeof bookingParticipants.$inferInsert;
export type BookingPaymentAudit = typeof bookingPaymentAudit.$inferSelect;
export type InsertBookingPaymentAudit = typeof bookingPaymentAudit.$inferInsert;

// Dismissed HubSpot meetings table - tracks HubSpot meetings that were dismissed/ignored
export const dismissedHubspotMeetings = pgTable("dismissed_hubspot_meetings", {
  id: serial("id").primaryKey(),
  hubspotMeetingId: varchar("hubspot_meeting_id").notNull().unique(),
  dismissedBy: varchar("dismissed_by"),
  dismissedAt: timestamp("dismissed_at").notNull().defaultNow(),
  notes: text("notes"),
});

export type DismissedHubspotMeeting = typeof dismissedHubspotMeetings.$inferSelect;
export type InsertDismissedHubspotMeeting = typeof dismissedHubspotMeetings.$inferInsert;
