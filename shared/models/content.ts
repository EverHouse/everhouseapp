import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";
import { users } from "./auth-session";

// Events table - club events
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  title: varchar("title").notNull(),
  description: text("description"),
  eventDate: date("event_date").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time"),
  location: varchar("location"),
  category: varchar("category"),
  imageUrl: text("image_url"),
  maxAttendees: integer("max_attendees"),
  createdAt: timestamp("created_at").defaultNow(),
  eventbriteId: varchar("eventbrite_id"),
  eventbriteUrl: text("eventbrite_url"),
  externalUrl: text("external_url"),
  source: varchar("source").default("manual"),
  visibility: varchar("visibility").default("public"),
  googleCalendarId: varchar("google_calendar_id"),
  requiresRsvp: boolean("requires_rsvp").default(false),
  locallyEdited: boolean("locally_edited").default(false),
  googleEventEtag: varchar("google_event_etag"),
  googleEventUpdatedAt: timestamp("google_event_updated_at"),
  appLastModifiedAt: timestamp("app_last_modified_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  blockBookings: boolean("block_bookings").default(false),
  needsReview: boolean("needs_review").default(false),
  reviewedBy: varchar("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  reviewDismissed: boolean("review_dismissed").default(false),
});

// Event RSVPs table - event registrations
export const eventRsvps = pgTable("event_rsvps", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => events.id, { onDelete: 'cascade' }),
  userEmail: varchar("user_email").notNull(),
  status: varchar("status").default("confirmed"),
  source: varchar("source").default("local"), // 'local' or 'eventbrite'
  eventbriteAttendeeId: varchar("eventbrite_attendee_id"), // external ID for deduplication
  matchedUserId: varchar("matched_user_id").references(() => users.id), // link to member if matched
  attendeeName: varchar("attendee_name"), // store name from Eventbrite for non-members
  ticketClass: varchar("ticket_class"), // ticket type from Eventbrite
  checkedIn: boolean("checked_in").default(false), // attendance tracking
  guestCount: integer("guest_count").default(0), // additional tickets for same email (for +X guests)
  orderDate: timestamp("order_date"), // when the RSVP was actually made (from Eventbrite)
  createdAt: timestamp("created_at").defaultNow(),
});

// Wellness classes table - for scheduling wellness/fitness classes
export const wellnessClasses = pgTable("wellness_classes", {
  id: serial("id").primaryKey(),
  title: varchar("title").notNull(),
  time: varchar("time").notNull(),
  instructor: varchar("instructor").notNull(),
  duration: varchar("duration").notNull(),
  category: varchar("category").notNull(),
  spots: varchar("spots").notNull(),
  status: varchar("status"),
  description: text("description"),
  date: date("date").notNull(),
  isActive: boolean("is_active").default(true),
  googleCalendarId: varchar("google_calendar_id"),
  imageUrl: text("image_url"),
  externalUrl: text("external_url"),
  visibility: varchar("visibility").default("public"),
  locallyEdited: boolean("locally_edited").default(false),
  googleEventEtag: varchar("google_event_etag"),
  googleEventUpdatedAt: timestamp("google_event_updated_at"),
  appLastModifiedAt: timestamp("app_last_modified_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  blockBookings: boolean("block_bookings").default(false),
  capacity: integer("capacity"),
  waitlistEnabled: boolean("waitlist_enabled").default(false),
  needsReview: boolean("needs_review").default(false),
  reviewedBy: varchar("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  reviewDismissed: boolean("review_dismissed").default(false),
});

// Wellness enrollments table - class registrations
export const wellnessEnrollments = pgTable("wellness_enrollments", {
  id: serial("id").primaryKey(),
  classId: integer("class_id"),
  userEmail: varchar("user_email").notNull(),
  status: varchar("status").default("confirmed"),
  isWaitlisted: boolean("is_waitlisted").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Announcements table - club announcements
export const announcements = pgTable("announcements", {
  id: serial("id").primaryKey(),
  title: varchar("title").notNull(),
  message: text("message").notNull(),
  priority: varchar("priority").default("normal"),
  isActive: boolean("is_active").default(true),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  closureId: integer("closure_id"),
  linkType: varchar("link_type"),
  linkTarget: varchar("link_target"),
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: varchar("created_by"),
});

// Gallery images table - venue photos
export const galleryImages = pgTable("gallery_images", {
  id: serial("id").primaryKey(),
  title: varchar("title"),
  description: text("description"),
  imageUrl: text("image_url").notNull(),
  category: varchar("category"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// FAQs table - frequently asked questions
export const faqs = pgTable("faqs", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  category: varchar("category"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Cafe items table - menu items
export const cafeItems = pgTable("cafe_items", {
  id: serial("id").primaryKey(),
  category: varchar("category").notNull(),
  name: varchar("name").notNull(),
  price: numeric("price").notNull().default("0"),
  description: text("description"),
  icon: varchar("icon"),
  imageUrl: text("image_url"),
  isActive: boolean("is_active").default(true),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// Form submissions table - contact/tour/event inquiries
export const formSubmissions = pgTable("form_submissions", {
  id: serial("id").primaryKey(),
  formType: varchar("form_type").notNull(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  email: varchar("email").notNull(),
  phone: varchar("phone"),
  message: text("message"),
  metadata: jsonb("metadata"),
  status: varchar("status").default("new"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Bug reports table - user-submitted bug reports
export const bugReports = pgTable("bug_reports", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email").notNull(),
  userName: varchar("user_name"),
  userRole: varchar("user_role"),
  description: text("description").notNull(),
  screenshotUrl: text("screenshot_url"),
  pageUrl: varchar("page_url"),
  userAgent: text("user_agent"),
  status: varchar("status").default("open"),
  resolvedBy: varchar("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  staffNotes: text("staff_notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type WellnessClass = typeof wellnessClasses.$inferSelect;
export type InsertWellnessClass = typeof wellnessClasses.$inferInsert;
export type WellnessEnrollment = typeof wellnessEnrollments.$inferSelect;
export type InsertWellnessEnrollment = typeof wellnessEnrollments.$inferInsert;
export type Announcement = typeof announcements.$inferSelect;
export type InsertAnnouncement = typeof announcements.$inferInsert;
export type Faq = typeof faqs.$inferSelect;
export type InsertFaq = typeof faqs.$inferInsert;
export type FormSubmission = typeof formSubmissions.$inferSelect;
export type InsertFormSubmission = typeof formSubmissions.$inferInsert;
export type BugReport = typeof bugReports.$inferSelect;
export type InsertBugReport = typeof bugReports.$inferInsert;
