import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  timestamp,
  varchar,
  integer,
  text,
} from "drizzle-orm/pg-core";

// --- Existing Tables (Day Pass & Redemptions) ---

export const dayPassPurchases = pgTable(
  "day_pass_purchases",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: varchar("user_id"),
    productType: varchar("product_type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    quantity: integer("quantity").default(1),
    remainingUses: integer("remaining_uses").default(1),
    status: varchar("status").default("active"),
    stripePaymentIntentId: varchar("stripe_payment_intent_id").notNull(),
    stripeCustomerId: varchar("stripe_customer_id").notNull(),
    hubspotDealId: varchar("hubspot_deal_id"),
    purchaserEmail: varchar("purchaser_email").notNull(),
    purchaserFirstName: varchar("purchaser_first_name"),
    purchaserLastName: varchar("purchaser_last_name"),
    purchaserPhone: varchar("purchaser_phone"),
    source: varchar("source").default("stripe"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_day_pass_purchases_user_id").on(table.userId),
    index("idx_day_pass_purchases_stripe_payment_intent_id").on(
      table.stripePaymentIntentId,
    ),
    index("idx_day_pass_purchases_purchaser_email").on(table.purchaserEmail),
    index("idx_day_pass_purchases_purchased_at").on(table.purchasedAt),
    index("idx_day_pass_purchases_status").on(table.status),
  ],
);

export type DayPassPurchase = typeof dayPassPurchases.$inferSelect;

export const passRedemptionLogs = pgTable(
  "pass_redemption_logs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    purchaseId: varchar("purchase_id").notNull(),
    redeemedBy: varchar("redeemed_by").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).defaultNow(),
    location: varchar("location").default("front_desk"),
    notes: varchar("notes"),
  },
  (table) => [
    index("idx_pass_redemption_logs_purchase_id").on(table.purchaseId),
    index("idx_pass_redemption_logs_redeemed_at").on(table.redeemedAt),
  ],
);

export type PassRedemptionLog = typeof passRedemptionLogs.$inferSelect;

// --- New Unified Billing Group Tables ---

// Replaces family_groups to support both Family and Corporate
export const billingGroups = pgTable(
  "billing_groups",
  {
    id: serial("id").primaryKey(), // Revert to serial to match existing logic
    type: text("type").notNull().default("family"),
    companyName: text("company_name"),
    hubspotCompanyId: text("hubspot_company_id"),
    stripeCustomerId: varchar("stripe_customer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_billing_groups_type").on(table.type),
    index("idx_billing_groups_hubspot_id").on(table.hubspotCompanyId),
  ],
);

export type BillingGroup = typeof billingGroups.$inferSelect;
export type InsertBillingGroup = typeof billingGroups.$inferInsert;

// Tracks individual members within a group
export const groupMembers = pgTable(
  "group_members",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: varchar("group_id").notNull(), // References billing_groups.id
    userId: varchar("user_id").notNull(), // References users.id
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_group_members_group_id").on(table.groupId),
    index("idx_group_members_user_id").on(table.userId),
  ],
);

export type GroupMember = typeof groupMembers.$inferSelect;
export type InsertGroupMember = typeof groupMembers.$inferInsert;

// HubSpot Sync Audit - Tracks all HubSpot API activity
export const hubspotSyncAudit = pgTable("hubspot_sync_audit", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  entityType: text("entity_type").notNull(), // 'contact' or 'company'
  entityId: text("entity_id").notNull(), // Local ID
  hubspotId: text("hubspot_id"), // HubSpot ID
  status: text("status").notNull(), // 'success', 'failed', 'active'
  errorMessage: text("error_message"),
  payload: sql`jsonb`, // Detailed data sent/received
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow(),
});

export type HubspotSyncAudit = typeof hubspotSyncAudit.$inferSelect;
