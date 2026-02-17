import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

// Session storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// User storage table.
// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  role: varchar("role").default("member"),
  tier: varchar("tier"),
  tierId: integer("tier_id"),
  tags: jsonb("tags").default(sql`'[]'::jsonb`),
  phone: varchar("phone"),
  mindbodyClientId: varchar("mindbody_client_id"),
  lifetimeVisits: integer("lifetime_visits").default(0),
  linkedEmails: jsonb("linked_emails").default(sql`'[]'::jsonb`),
  manuallyLinkedEmails: jsonb("manually_linked_emails").default(sql`'[]'::jsonb`),
  dataSource: varchar("data_source"),
  hubspotId: varchar("hubspot_id"),
  membershipStatus: varchar("membership_status").default("active"),
  billingProvider: varchar("billing_provider").default("mindbody"),
  stripeCustomerId: varchar("stripe_customer_id"),
  stripeSubscriptionId: varchar("stripe_subscription_id"),
  stripeCurrentPeriodEnd: timestamp("stripe_current_period_end"),
  lastSyncedAt: timestamp("last_synced_at"),
  joinDate: date("join_date"),
  memberSince: timestamp("member_since"),
  legacySource: varchar("legacy_source"),
  welcomeEmailSent: boolean("welcome_email_sent").default(false),
  welcomeEmailSentAt: timestamp("welcome_email_sent_at"),
  trackmanEmail: varchar("trackman_email"),
  emailOptIn: boolean("email_opt_in"),
  smsOptIn: boolean("sms_opt_in"),
  // Granular SMS preferences (synced from HubSpot)
  smsPromoOptIn: boolean("sms_promo_opt_in"),
  smsTransactionalOptIn: boolean("sms_transactional_opt_in"),
  smsRemindersOptIn: boolean("sms_reminders_opt_in"),
  // Stripe delinquent status (synced from HubSpot)
  stripeDelinquent: boolean("stripe_delinquent"),
  doNotSellMyInfo: boolean("do_not_sell_my_info").default(false),
  dataExportRequestedAt: timestamp("data_export_requested_at"),
  waiverVersion: varchar("waiver_version"),
  waiverSignedAt: timestamp("waiver_signed_at"),
  companyName: text("company_name"),
  jobTitle: text("job_title"),
  hubspotCompanyId: text("hubspot_company_id"),
  // Address fields (synced from HubSpot/Mindbody)
  streetAddress: text("street_address"),
  city: text("city"),
  state: text("state"),
  zipCode: varchar("zip_code", { length: 20 }),
  // Date of birth (synced from HubSpot/Mindbody) - useful for birthday celebrations
  dateOfBirth: date("date_of_birth"),
  // Track last HubSpot notes hash to detect changes
  lastHubspotNotesHash: varchar("last_hubspot_notes_hash", { length: 64 }),
  billingGroupId: integer("billing_group_id"),
  billingMigrationRequestedAt: timestamp("billing_migration_requested_at"),
  lastTier: varchar("last_tier"),
  gracePeriodStart: timestamp("grace_period_start"),
  contractStartDate: date("contract_start_date"),
  cancellationRequestedAt: timestamp("cancellation_requested_at"),
  cancellationEffectiveDate: date("cancellation_effective_date"),
  cancellationReason: text("cancellation_reason"),
  gracePeriodEmailCount: integer("grace_period_email_count").default(0),
  visitorType: varchar("visitor_type"),
  googleId: varchar("google_id"),
  googleEmail: varchar("google_email"),
  googleLinkedAt: timestamp("google_linked_at"),
  lastActivityAt: timestamp("last_activity_at"),
  lastActivitySource: varchar("last_activity_source"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  archivedAt: timestamp("archived_at"),
  archivedBy: varchar("archived_by"),
  idImageUrl: text("id_image_url"),
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  onboardingDismissedAt: timestamp("onboarding_dismissed_at"),
  firstLoginAt: timestamp("first_login_at"),
  firstBookingAt: timestamp("first_booking_at"),
  profileCompletedAt: timestamp("profile_completed_at"),
  appInstalledAt: timestamp("app_installed_at"),
  onboardingNudgeCount: integer("onboarding_nudge_count").default(0),
  onboardingLastNudgeAt: timestamp("onboarding_last_nudge_at"),
}, (table) => [
  index("users_stripe_customer_id_idx").on(table.stripeCustomerId),
  index("users_membership_status_idx").on(table.membershipStatus),
  index("users_billing_group_id_idx").on(table.billingGroupId),
  index("users_visitor_type_idx").on(table.visitorType),
]);

// Staff users table - emails that get staff or admin access
// Note: role column distinguishes 'staff' from 'admin' users
export const staffUsers = pgTable("staff_users", {
  id: serial("id").primaryKey(),
  email: varchar("email").notNull().unique(),
  name: varchar("name"),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  phone: varchar("phone"),
  jobTitle: varchar("job_title"),
  passwordHash: varchar("password_hash"),
  role: varchar("role").default("staff"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: varchar("created_by"),
});

// Magic links table - for passwordless authentication
export const magicLinks = pgTable("magic_links", {
  id: serial("id").primaryKey(),
  email: varchar("email").notNull(),
  token: varchar("token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export type UpsertUser = typeof users.$inferInsert;
export type User = typeof users.$inferSelect;
export type StaffUser = typeof staffUsers.$inferSelect;
export type InsertStaffUser = typeof staffUsers.$inferInsert;
