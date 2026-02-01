import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  timestamp,
  varchar,
  integer,
  text,
  serial,
} from "drizzle-orm/pg-core";

// --- Unified Fee Service Types ---

export interface FeeLineItem {
  participantId?: number;
  userId?: string;
  displayName: string;
  participantType: 'owner' | 'member' | 'guest';
  minutesAllocated: number;
  overageCents: number;
  guestCents: number;
  totalCents: number;
  guestPassUsed: boolean;
  tierName?: string;
  dailyAllowance?: number;
  usedMinutesToday?: number;
}

export interface FeeBreakdown {
  totals: {
    totalCents: number;
    overageCents: number;
    guestCents: number;
    guestPassesUsed: number;
    guestPassesAvailable: number;
  };
  participants: FeeLineItem[];
  metadata: {
    effectivePlayerCount: number;
    declaredPlayerCount: number;
    actualPlayerCount: number;
    sessionDuration: number;
    sessionDate: string;
    source: 'preview' | 'approval' | 'checkin' | 'stripe' | 'roster_update';
  };
}

export interface FeeComputeParams {
  sessionId?: number;
  bookingId?: number;
  sessionDate?: string;
  startTime?: string;
  sessionDuration?: number;
  declaredPlayerCount?: number;
  hostEmail?: string;
  participants?: Array<{
    userId?: string;
    email?: string;
    displayName: string;
    participantType: 'owner' | 'member' | 'guest';
  }>;
  source: 'preview' | 'approval' | 'checkin' | 'stripe' | 'roster_update';
  excludeSessionFromUsage?: boolean;
}

// --- Day Pass & Redemptions Tables ---

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
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    bookingId: integer("booking_id"),
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

// Note: billingGroups, groupMembers, and familyAddOnProducts are defined in hubspot-billing.ts
// to avoid duplicate exports. Import them from there or from the main schema.
