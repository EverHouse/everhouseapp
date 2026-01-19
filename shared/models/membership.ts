import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

// Membership tiers table - centralized tier configuration for marketing and logic
export const membershipTiers = pgTable("membership_tiers", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull().unique(),
  slug: varchar("slug").notNull().unique(),
  
  // Display fields
  priceString: varchar("price_string").notNull(),
  description: text("description"),
  buttonText: varchar("button_text").default("Apply Now"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  isPopular: boolean("is_popular").default(false),
  showInComparison: boolean("show_in_comparison").default(true),
  
  // Marketing fields (JSON)
  highlightedFeatures: jsonb("highlighted_features").default(sql`'[]'::jsonb`),
  allFeatures: jsonb("all_features").default(sql`'{}'::jsonb`),
  
  // Logic/Enforcement fields
  dailySimMinutes: integer("daily_sim_minutes").default(0),
  guestPassesPerMonth: integer("guest_passes_per_month").default(0),
  bookingWindowDays: integer("booking_window_days").default(7),
  dailyConfRoomMinutes: integer("daily_conf_room_minutes").default(0),
  
  // Boolean permissions
  canBookSimulators: boolean("can_book_simulators").default(false),
  canBookConference: boolean("can_book_conference").default(false),
  canBookWellness: boolean("can_book_wellness").default(true),
  hasGroupLessons: boolean("has_group_lessons").default(false),
  hasExtendedSessions: boolean("has_extended_sessions").default(false),
  hasPrivateLesson: boolean("has_private_lesson").default(false),
  hasSimulatorGuestPasses: boolean("has_simulator_guest_passes").default(false),
  hasDiscountedMerch: boolean("has_discounted_merch").default(false),
  unlimitedAccess: boolean("unlimited_access").default(false),
  
  guestFeeCents: integer("guest_fee_cents").default(2500),
  
  stripeProductId: varchar("stripe_product_id"),
  stripePriceId: varchar("stripe_price_id"),
  foundingPriceId: varchar("founding_price_id"),
  priceCents: integer("price_cents"),
  billingInterval: varchar("billing_interval").default("month"),
  productType: varchar("product_type").default("subscription"), // 'subscription' or 'one_time'
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Guest passes table - member guest pass tracking
export const guestPasses = pgTable("guest_passes", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  passesUsed: integer("passes_used").notNull().default(0),
  passesTotal: integer("passes_total").notNull().default(4),
  lastResetDate: date("last_reset_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Member notes table - staff notes about members
export const memberNotes = pgTable("member_notes", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  content: text("content").notNull(),
  createdBy: varchar("created_by").notNull(),
  createdByName: varchar("created_by_name"),
  isPinned: boolean("is_pinned").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Communication logs table - prepared for HubSpot 2-way sync
export const communicationLogs = pgTable("communication_logs", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  type: varchar("type").notNull(), // 'email', 'call', 'meeting', 'note', 'sms'
  direction: varchar("direction"), // 'inbound', 'outbound'
  subject: varchar("subject"),
  body: text("body"),
  status: varchar("status"), // 'sent', 'received', 'scheduled', 'draft'
  hubspotEngagementId: varchar("hubspot_engagement_id"), // for HubSpot sync
  hubspotSyncedAt: timestamp("hubspot_synced_at"),
  loggedBy: varchar("logged_by"),
  loggedByName: varchar("logged_by_name"),
  occurredAt: timestamp("occurred_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Guest check-ins table - tracking guest visits by member
export const guestCheckIns = pgTable("guest_check_ins", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  guestName: varchar("guest_name").notNull(),
  guestEmail: varchar("guest_email"),
  guestPhone: varchar("guest_phone"),
  checkInDate: date("check_in_date").notNull(),
  checkInTime: time("check_in_time"),
  notes: text("notes"),
  checkedInBy: varchar("checked_in_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type MembershipTier = typeof membershipTiers.$inferSelect;
export type InsertMembershipTier = typeof membershipTiers.$inferInsert;
export type MemberNote = typeof memberNotes.$inferSelect;
export type InsertMemberNote = typeof memberNotes.$inferInsert;
export type CommunicationLog = typeof communicationLogs.$inferSelect;
export type InsertCommunicationLog = typeof communicationLogs.$inferInsert;
export type GuestCheckIn = typeof guestCheckIns.$inferSelect;
export type InsertGuestCheckIn = typeof guestCheckIns.$inferInsert;
