import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

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
}, (table) => [
  uniqueIndex("booking_requests_trackman_id_idx").on(table.trackmanBookingId),
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

// Tours table - scheduled tours synced from Google Calendar
export const tours = pgTable("tours", {
  id: serial("id").primaryKey(),
  googleCalendarId: varchar("google_calendar_id").unique(),
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
