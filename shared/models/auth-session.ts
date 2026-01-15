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
  lastSyncedAt: timestamp("last_synced_at"),
  joinDate: date("join_date"),
  memberSince: timestamp("member_since"),
  legacySource: varchar("legacy_source"),
  welcomeEmailSent: boolean("welcome_email_sent").default(false),
  welcomeEmailSentAt: timestamp("welcome_email_sent_at"),
  trackmanEmail: varchar("trackman_email"),
  emailOptIn: boolean("email_opt_in"),
  smsOptIn: boolean("sms_opt_in"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  archivedAt: timestamp("archived_at"),
  archivedBy: varchar("archived_by"),
});

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
