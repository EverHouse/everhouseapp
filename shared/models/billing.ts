import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  uniqueIndex,
  jsonb,
  pgTable,
  timestamp,
  varchar,
  integer,
  text,
  serial,
} from "drizzle-orm/pg-core";
// FK constraints for booking_fee_snapshots are managed by db-init.ts (not schema .references())
// to avoid deployment migration conflicts with orphaned production data

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
    source: 'preview' | 'approval' | 'checkin' | 'stripe' | 'roster_update' | 'trackman_webhook' | 'sync_cleanup' | 'staff_action' | 'staff_add_member' | 'staff_add_guest' | 'reschedule' | 'staff_booking' | 'booking_creation' | 'trackman_modification' | 'trackman_auto_match' | 'staff_auto_match' | 'trackman_import';
  };
  totalSessionFee?: number;
  participantsUpdated?: boolean;
  billingResult?: Record<string, unknown>;
  ledgerUpdated?: boolean;
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
  source: 'preview' | 'approval' | 'checkin' | 'stripe' | 'roster_update' | 'trackman_webhook' | 'sync_cleanup' | 'staff_action' | 'staff_add_member' | 'staff_add_guest' | 'reschedule' | 'staff_booking' | 'booking_creation' | 'trackman_modification' | 'trackman_auto_match' | 'staff_auto_match' | 'trackman_import';
  excludeSessionFromUsage?: boolean;
  isConferenceRoom?: boolean;
}

// --- Booking Fee Snapshots Table ---
export const bookingFeeSnapshots = pgTable(
  "booking_fee_snapshots",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id").notNull(), // FK to booking_requests.id managed by db-init.ts (not schema) to avoid deployment migration conflicts
    sessionId: integer("session_id"), // FK to booking_sessions.id managed by db-init.ts (not schema) to avoid deployment migration conflicts
    participantFees: jsonb("participant_fees").notNull(),
    totalCents: integer("total_cents").notNull(),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_fee_snapshots_booking").on(table.bookingId),
    index("idx_fee_snapshots_intent").on(table.stripePaymentIntentId),
    uniqueIndex("idx_booking_fee_snapshots_session_completed")
      .on(table.sessionId)
      .where(sql`status = 'completed'`),
  ],
);

export type BookingFeeSnapshot = typeof bookingFeeSnapshots.$inferSelect;
export type InsertBookingFeeSnapshot = typeof bookingFeeSnapshots.$inferInsert;

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
    stripeCustomerId: varchar("stripe_customer_id"),
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
    index("idx_day_pass_purchases_lower_email").on(sql`LOWER(${table.purchaserEmail})`),
    uniqueIndex("day_pass_purchases_stripe_pi_unique")
      .on(table.stripePaymentIntentId)
      .where(sql`${table.stripePaymentIntentId} IS NOT NULL`),
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
    index("idx_guest_pass_holds_lower_member_email").on(sql`LOWER(${table.memberEmail})`),
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
    index("idx_conference_prepayments_member_email").on(sql`LOWER(${table.memberEmail})`),
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
    index("idx_terminal_payments_lower_user_email").on(sql`LOWER(${table.userEmail})`),
    uniqueIndex("terminal_payments_stripe_pi_unique").on(table.stripePaymentIntentId),
  ],
);

export type TerminalPayment = typeof terminalPayments.$inferSelect;

export const failedSideEffects = pgTable("failed_side_effects", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull(),
  actionType: varchar("action_type", { length: 64 }).notNull(),
  stripePaymentIntentId: varchar("stripe_payment_intent_id"),
  errorMessage: text("error_message").notNull(),
  context: jsonb("context"),
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: varchar("resolved_by"),
  retryCount: integer("retry_count").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_failed_side_effects_booking_id").on(table.bookingId),
  index("idx_failed_side_effects_resolved").on(table.resolved),
]);

export type FailedSideEffect = typeof failedSideEffects.$inferSelect;

export const stripeTransactionCache = pgTable("stripe_transaction_cache", {
  id: serial("id").primaryKey(),
  stripeId: text("stripe_id").unique().notNull(),
  objectType: text("object_type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").default("usd"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
  customerId: text("customer_id"),
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),
  description: text("description"),
  metadata: jsonb("metadata"),
  source: text("source").default("webhook"),
  paymentIntentId: text("payment_intent_id"),
  chargeId: text("charge_id"),
  invoiceId: text("invoice_id"),
}, (table) => [
  index("idx_stripe_cache_created_at").on(sql`${table.createdAt} DESC`),
  index("idx_stripe_cache_customer_email").on(table.customerEmail),
  index("idx_stripe_cache_status").on(table.status),
  index("idx_stripe_cache_object_type").on(table.objectType),
]);

// Note: billingGroups, groupMembers, and familyAddOnProducts are defined in hubspot-billing.ts
// to avoid duplicate exports. Import them from there or from the main schema.
