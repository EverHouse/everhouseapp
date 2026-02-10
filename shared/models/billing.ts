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
  isStaff?: boolean;
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
  isConferenceRoom?: boolean;
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

// --- Guest Pass Holds Table ---
// Tracks reserved guest passes for pending bookings to prevent double-spend
export const guestPassHolds = pgTable(
  "guest_pass_holds",
  {
    id: serial("id").primaryKey(),
    memberEmail: varchar("member_email", { length: 255 }).notNull(),
    bookingId: integer("booking_id").notNull(),
    passesHeld: integer("passes_held").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_guest_pass_holds_member_email").on(table.memberEmail),
    index("idx_guest_pass_holds_booking_id").on(table.bookingId),
  ],
);

export type GuestPassHold = typeof guestPassHolds.$inferSelect;

// --- Conference Prepayments Table ---
// Tracks prepayments for conference room bookings with overage fees
export const conferencePrepayments = pgTable(
  "conference_prepayments",
  {
    id: serial("id").primaryKey(),
    memberEmail: varchar("member_email", { length: 255 }).notNull(),
    bookingDate: varchar("booking_date", { length: 10 }).notNull(),
    startTime: varchar("start_time", { length: 8 }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    paymentType: varchar("payment_type", { length: 20 }).notNull().default('stripe'),
    paymentIntentId: varchar("payment_intent_id", { length: 255 }),
    creditReferenceId: varchar("credit_reference_id", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default('pending'),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    bookingId: integer("booking_id"),
  },
  (table) => [
    index("idx_conference_prepayments_member_email").on(table.memberEmail),
    index("idx_conference_prepayments_status").on(table.status),
    index("idx_conference_prepayments_payment_intent").on(table.paymentIntentId),
    index("idx_conference_prepayments_booking_date").on(table.bookingDate),
  ],
);

export type ConferencePrepayment = typeof conferencePrepayments.$inferSelect;

// --- Terminal Payments Table ---
// Tracks in-person card reader payments for membership subscriptions
export const terminalPayments = pgTable(
  "terminal_payments",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    userEmail: varchar("user_email", { length: 255 }).notNull(),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }).notNull(),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }).notNull(),
    stripeInvoiceId: varchar("stripe_invoice_id", { length: 255 }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 10 }).default("usd"),
    readerId: varchar("reader_id", { length: 255 }),
    readerLabel: varchar("reader_label", { length: 255 }),
    status: varchar("status", { length: 50 }).notNull().default("succeeded"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundAmountCents: integer("refund_amount_cents"),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    disputeId: varchar("dispute_id", { length: 255 }),
    disputeStatus: varchar("dispute_status", { length: 50 }),
    processedBy: varchar("processed_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_terminal_payments_user_id").on(table.userId),
    index("idx_terminal_payments_payment_intent_id").on(table.stripePaymentIntentId),
    index("idx_terminal_payments_subscription_id").on(table.stripeSubscriptionId),
    index("idx_terminal_payments_status").on(table.status),
  ],
);

export type TerminalPayment = typeof terminalPayments.$inferSelect;

// Note: billingGroups, groupMembers, and familyAddOnProducts are defined in hubspot-billing.ts
// to avoid duplicate exports. Import them from there or from the main schema.
