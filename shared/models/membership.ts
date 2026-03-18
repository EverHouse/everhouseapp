import { sql } from "drizzle-orm";
import { check, index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

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
  showOnMembershipPage: boolean("show_on_membership_page").default(true),
  
  // Marketing fields (JSON)
  highlightedFeatures: jsonb("highlighted_features").default(sql`'[]'::jsonb`),
  allFeatures: jsonb("all_features").default(sql`'{}'::jsonb`),
  
  // Logic/Enforcement fields
  dailySimMinutes: integer("daily_sim_minutes").default(0),
  guestPassesPerYear: integer("guest_passes_per_year").default(0),
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
  
  minQuantity: integer("min_quantity").default(1),
  tierType: text("tier_type").default("individual"), // 'individual' or 'corporate'
  
  walletPassBgColor: varchar("wallet_pass_bg_color"),
  walletPassForegroundColor: varchar("wallet_pass_foreground_color"),
  walletPassLabelColor: varchar("wallet_pass_label_color"),
  
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
}, (table) => [
  index("guest_passes_member_email_idx").on(table.memberEmail),
  index("idx_guest_passes_lower_email").on(sql`LOWER(${table.memberEmail})`),
  check("guest_passes_usage_check", sql`passes_used <= passes_total`),
  check("guest_passes_non_negative_check", sql`passes_used >= 0`),
]);

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
}, (table) => [
  index("member_notes_member_email_idx").on(table.memberEmail),
  index("idx_member_notes_lower_member_email").on(sql`LOWER(${table.memberEmail})`),
]);

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
}, (table) => [
  index("communication_logs_member_email_idx").on(table.memberEmail),
  index("idx_communication_logs_lower_member_email").on(sql`LOWER(${table.memberEmail})`),
  index("idx_communication_logs_created_at").on(table.createdAt),
  index("idx_communication_logs_member").on(table.memberEmail, table.createdAt),
  index("idx_communication_logs_occurred_at").on(table.occurredAt),
  index("idx_communication_logs_email").on(table.memberEmail),
]);

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
}, (table) => [
  index("idx_guest_check_ins_lower_member_email").on(sql`LOWER(${table.memberEmail})`),
  index("idx_guest_check_ins_lower_guest_email").on(sql`LOWER(${table.guestEmail})`),
  index("idx_guest_check_ins_email").on(table.memberEmail),
]);

// Linked emails table - alternate email addresses for members (for Trackman matching)
export const userLinkedEmails = pgTable("user_linked_emails", {
  id: serial("id").primaryKey(),
  primaryEmail: varchar("primary_email").notNull(), // The member's main email in the system
  linkedEmail: varchar("linked_email").notNull(), // The alternate email (e.g., work email from Trackman)
  source: varchar("source").default("manual"), // 'manual', 'trackman_resolution', 'hubspot'
  createdBy: varchar("created_by"), // Staff email who created the link
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  primaryEmailIdx: index("user_linked_emails_primary_idx").on(table.primaryEmail),
  linkedEmailIdx: uniqueIndex("user_linked_emails_linked_idx").on(table.linkedEmail),
  lowerLinkedEmailIdx: index("idx_user_linked_emails_lower_linked_email").on(sql`LOWER(${table.linkedEmail})`),
  lowerPrimaryEmailIdx: index("idx_user_linked_emails_lower_primary_email").on(sql`LOWER(${table.primaryEmail})`),
}));

export type MembershipTier = typeof membershipTiers.$inferSelect;
export type InsertMembershipTier = typeof membershipTiers.$inferInsert;
export type MemberNote = typeof memberNotes.$inferSelect;
export type InsertMemberNote = typeof memberNotes.$inferInsert;
export type CommunicationLog = typeof communicationLogs.$inferSelect;
export type InsertCommunicationLog = typeof communicationLogs.$inferInsert;
export type GuestCheckIn = typeof guestCheckIns.$inferSelect;
export type InsertGuestCheckIn = typeof guestCheckIns.$inferInsert;
export type UserLinkedEmail = typeof userLinkedEmails.$inferSelect;
export type InsertUserLinkedEmail = typeof userLinkedEmails.$inferInsert;

// Tier Features - global feature definitions for compare table
export const tierFeatures = pgTable("tier_features", {
  id: serial("id").primaryKey(),
  featureKey: varchar("feature_key").notNull().unique(),
  displayLabel: varchar("display_label").notNull(),
  valueType: varchar("value_type").notNull().default("boolean"), // 'boolean', 'number', 'text'
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("tier_features_sort_order_idx").on(table.sortOrder),
]);

// Tier Feature Values - per-tier values for each feature
export const tierFeatureValues = pgTable("tier_feature_values", {
  id: serial("id").primaryKey(),
  featureId: integer("feature_id").notNull().references(() => tierFeatures.id, { onDelete: 'cascade' }),
  tierId: integer("tier_id").notNull().references(() => membershipTiers.id, { onDelete: 'cascade' }),
  valueBoolean: boolean("value_boolean"),
  valueNumber: numeric("value_number"),
  valueText: varchar("value_text"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("tier_feature_values_feature_tier_idx").on(table.featureId, table.tierId),
]);

export type TierFeature = typeof tierFeatures.$inferSelect;
export type InsertTierFeature = typeof tierFeatures.$inferInsert;
export type TierFeatureValue = typeof tierFeatureValues.$inferSelect;
export type InsertTierFeatureValue = typeof tierFeatureValues.$inferInsert;

export const walletPassDeviceRegistrations = pgTable("wallet_pass_device_registrations", {
  id: serial("id").primaryKey(),
  deviceLibraryId: varchar("device_library_id").notNull(),
  pushToken: varchar("push_token").notNull(),
  passTypeId: varchar("pass_type_id").notNull(),
  serialNumber: varchar("serial_number").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("wallet_pass_device_serial_idx").on(table.deviceLibraryId, table.passTypeId, table.serialNumber),
  index("wallet_pass_serial_idx").on(table.serialNumber),
]);

export const walletPassAuthTokens = pgTable("wallet_pass_auth_tokens", {
  id: serial("id").primaryKey(),
  serialNumber: varchar("serial_number").notNull().unique(),
  authToken: varchar("auth_token").notNull(),
  memberId: varchar("member_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("wallet_pass_auth_member_idx").on(table.memberId),
]);

export type WalletPassDeviceRegistration = typeof walletPassDeviceRegistrations.$inferSelect;
export type InsertWalletPassDeviceRegistration = typeof walletPassDeviceRegistrations.$inferInsert;
export type WalletPassAuthToken = typeof walletPassAuthTokens.$inferSelect;
export type InsertWalletPassAuthToken = typeof walletPassAuthTokens.$inferInsert;
