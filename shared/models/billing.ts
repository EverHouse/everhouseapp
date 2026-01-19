import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  timestamp,
  varchar,
  integer,
} from "drizzle-orm/pg-core";
import { users } from "./auth-session";

// Day pass purchases table - for tracking day pass sales
export const dayPassPurchases = pgTable(
  "day_pass_purchases",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id"),
    productType: varchar("product_type").notNull(), // 'workspace' or 'golf_sim'
    amountCents: integer("amount_cents").notNull(),
    quantity: integer("quantity").default(1),
    stripePaymentIntentId: varchar("stripe_payment_intent_id").notNull(),
    stripeCustomerId: varchar("stripe_customer_id").notNull(),
    hubspotDealId: varchar("hubspot_deal_id"),
    purchaserEmail: varchar("purchaser_email").notNull(),
    purchaserFirstName: varchar("purchaser_first_name"),
    purchaserLastName: varchar("purchaser_last_name"),
    purchaserPhone: varchar("purchaser_phone"),
    source: varchar("source").default("stripe"), // 'stripe', 'mindbody_import', 'manual'
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_day_pass_purchases_user_id").on(table.userId),
    index("idx_day_pass_purchases_stripe_payment_intent_id").on(
      table.stripePaymentIntentId
    ),
    index("idx_day_pass_purchases_purchaser_email").on(table.purchaserEmail),
    index("idx_day_pass_purchases_purchased_at").on(table.purchasedAt),
  ]
);

export type DayPassPurchase = typeof dayPassPurchases.$inferSelect;
export type InsertDayPassPurchase = typeof dayPassPurchases.$inferInsert;
