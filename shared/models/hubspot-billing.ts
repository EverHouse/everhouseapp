import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, varchar, serial, boolean, text, integer, numeric } from "drizzle-orm/pg-core";

export const hubspotProductMappings = pgTable("hubspot_product_mappings", {
  id: serial("id").primaryKey(),
  hubspotProductId: varchar("hubspot_product_id").notNull().unique(),
  productName: varchar("product_name").notNull(),
  productType: varchar("product_type").notNull(), // 'membership', 'fee', 'pass'
  tierName: varchar("tier_name"), // for membership products, links to tier
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  billingFrequency: varchar("billing_frequency"), // 'monthly', 'one_time'
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const discountRules = pgTable("discount_rules", {
  id: serial("id").primaryKey(),
  discountTag: varchar("discount_tag").notNull().unique(), // 'Founding Member', 'Comped', 'Investor', 'Referral'
  discountPercent: integer("discount_percent").notNull().default(0), // 0-100
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const hubspotDeals = pgTable("hubspot_deals", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  hubspotContactId: varchar("hubspot_contact_id"),
  hubspotDealId: varchar("hubspot_deal_id").notNull().unique(),
  dealName: varchar("deal_name"),
  pipelineId: varchar("pipeline_id"),
  pipelineStage: varchar("pipeline_stage"), // HubSpot stage IDs: 'closedwon', '2825519820', 'closedlost'
  isPrimary: boolean("is_primary").default(true), // for members with multiple deals
  lastKnownMindbodyStatus: varchar("last_known_mindbody_status"),
  lastPaymentStatus: varchar("last_payment_status"), // 'current', 'overdue', 'failed', 'unknown'
  lastPaymentCheck: timestamp("last_payment_check"),
  lastStageSyncAt: timestamp("last_stage_sync_at"),
  lastSyncError: text("last_sync_error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("hubspot_deals_member_email_idx").on(table.memberEmail),
  index("hubspot_deals_hubspot_deal_id_idx").on(table.hubspotDealId),
]);

export const hubspotLineItems = pgTable("hubspot_line_items", {
  id: serial("id").primaryKey(),
  hubspotDealId: varchar("hubspot_deal_id").notNull(),
  hubspotLineItemId: varchar("hubspot_line_item_id").unique(),
  hubspotProductId: varchar("hubspot_product_id").notNull(),
  productName: varchar("product_name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  discountPercent: integer("discount_percent").default(0),
  discountReason: varchar("discount_reason"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  status: varchar("status").default("pending"), // 'pending', 'synced', 'error'
  syncError: text("sync_error"),
  createdBy: varchar("created_by"),
  createdByName: varchar("created_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("hubspot_line_items_deal_id_idx").on(table.hubspotDealId),
]);

export const hubspotFormConfigs = pgTable("hubspot_form_configs", {
  id: serial("id").primaryKey(),
  formType: varchar("form_type").notNull().unique(), // 'tour-request', 'membership', 'private-hire', etc.
  hubspotFormId: varchar("hubspot_form_id").notNull(),
  formName: varchar("form_name").notNull(),
  formFields: jsonb("form_fields").default(sql`'[]'::jsonb`), // cached field definitions from HubSpot
  hiddenFields: jsonb("hidden_fields").default(sql`'{}'::jsonb`), // app-injected hidden fields
  isActive: boolean("is_active").default(true),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type HubspotProductMapping = typeof hubspotProductMappings.$inferSelect;
export type InsertHubspotProductMapping = typeof hubspotProductMappings.$inferInsert;
export type DiscountRule = typeof discountRules.$inferSelect;
export type InsertDiscountRule = typeof discountRules.$inferInsert;
export type HubspotDeal = typeof hubspotDeals.$inferSelect;
export type InsertHubspotDeal = typeof hubspotDeals.$inferInsert;
export type HubspotLineItem = typeof hubspotLineItems.$inferSelect;
export type InsertHubspotLineItem = typeof hubspotLineItems.$inferInsert;
export type HubspotFormConfig = typeof hubspotFormConfigs.$inferSelect;
export type InsertHubspotFormConfig = typeof hubspotFormConfigs.$inferInsert;

// Legacy purchases table - historical transactions from Mindbody import
export const legacyPurchases = pgTable("legacy_purchases", {
  id: serial("id").primaryKey(),
  
  // Member linkage
  userId: varchar("user_id"), // Links to users.id
  mindbodyClientId: varchar("mindbody_client_id").notNull(),
  memberEmail: varchar("member_email"),
  
  // Sale identification (unique constraint on sale_id + line_number for deduplication)
  mindbodySaleId: varchar("mindbody_sale_id").notNull(),
  lineNumber: integer("line_number").notNull().default(1),
  
  // Item details
  itemName: varchar("item_name").notNull(),
  itemCategory: varchar("item_category"), // 'membership', 'guest_pass', 'sim_walk_in', 'sim_add_on', 'guest_sim_fee', 'day_pass', 'lesson', 'merch', 'other'
  
  // Pricing (stored in cents for accuracy)
  itemPriceCents: integer("item_price_cents").notNull().default(0),
  quantity: integer("quantity").notNull().default(1),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).default("0"),
  discountAmountCents: integer("discount_amount_cents").default(0),
  taxCents: integer("tax_cents").default(0),
  itemTotalCents: integer("item_total_cents").notNull().default(0),
  
  // Payment info
  paymentMethod: varchar("payment_method"), // 'credit_card', 'amex', 'cash', 'comp', 'misc'
  
  // Timestamps
  saleDate: timestamp("sale_date").notNull(),
  
  // Trackman session linkage (for guest fee reconciliation)
  linkedBookingSessionId: integer("linked_booking_session_id"),
  linkedAt: timestamp("linked_at"),
  
  // Flags
  isComp: boolean("is_comp").default(false), // $0 comped items
  isSynced: boolean("is_synced").default(false), // Has been synced to HubSpot
  hubspotDealId: varchar("hubspot_deal_id"),
  
  // Audit
  importedAt: timestamp("imported_at").defaultNow(),
  importBatchId: varchar("import_batch_id"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("legacy_purchases_mindbody_client_id_idx").on(table.mindbodyClientId),
  index("legacy_purchases_sale_date_idx").on(table.saleDate),
  index("legacy_purchases_item_category_idx").on(table.itemCategory),
  index("legacy_purchases_member_email_idx").on(table.memberEmail),
]);

// Import jobs tracking table - audit trail for imports
export const legacyImportJobs = pgTable("legacy_import_jobs", {
  id: serial("id").primaryKey(),
  jobType: varchar("job_type").notNull(), // 'members', 'sales', 'attendance'
  fileName: varchar("file_name"),
  status: varchar("status").notNull().default("pending"), // 'pending', 'running', 'completed', 'failed'
  totalRows: integer("total_rows").default(0),
  processedRows: integer("processed_rows").default(0),
  matchedRows: integer("matched_rows").default(0),
  skippedRows: integer("skipped_rows").default(0),
  errorRows: integer("error_rows").default(0),
  errorDetails: jsonb("error_details").default(sql`'[]'::jsonb`),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: varchar("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type LegacyPurchase = typeof legacyPurchases.$inferSelect;
export type InsertLegacyPurchase = typeof legacyPurchases.$inferInsert;
export type LegacyImportJob = typeof legacyImportJobs.$inferSelect;
export type InsertLegacyImportJob = typeof legacyImportJobs.$inferInsert;

export const stripeProducts = pgTable("stripe_products", {
  id: serial("id").primaryKey(),
  hubspotProductId: varchar("hubspot_product_id").notNull().unique(),
  stripeProductId: varchar("stripe_product_id").notNull().unique(),
  stripePriceId: varchar("stripe_price_id").notNull(),
  name: varchar("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  billingInterval: varchar("billing_interval").notNull(),
  billingIntervalCount: integer("billing_interval_count").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("stripe_products_hubspot_product_id_idx").on(table.hubspotProductId),
  index("stripe_products_stripe_product_id_idx").on(table.stripeProductId),
  index("stripe_products_is_active_idx").on(table.isActive),
]);

export type StripeProduct = typeof stripeProducts.$inferSelect;
export type InsertStripeProduct = typeof stripeProducts.$inferInsert;

export const stripePaymentIntents = pgTable("stripe_payment_intents", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull(),
  stripePaymentIntentId: varchar("stripe_payment_intent_id").notNull().unique(),
  stripeCustomerId: varchar("stripe_customer_id"),
  amountCents: integer("amount_cents").notNull(),
  purpose: varchar("purpose").notNull(),
  bookingId: integer("booking_id"),
  sessionId: integer("session_id"),
  description: text("description"),
  status: varchar("status").notNull().default("pending"),
  retryCount: integer("retry_count").default(0),
  lastRetryAt: timestamp("last_retry_at"),
  failureReason: text("failure_reason"),
  dunningNotifiedAt: timestamp("dunning_notified_at"),
  requiresCardUpdate: boolean("requires_card_update").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("stripe_payment_intents_user_id_idx").on(table.userId),
  index("stripe_payment_intents_booking_id_idx").on(table.bookingId),
  index("stripe_payment_intents_status_idx").on(table.status),
]);

export type StripePaymentIntent = typeof stripePaymentIntents.$inferSelect;
export type InsertStripePaymentIntent = typeof stripePaymentIntents.$inferInsert;

// Billing groups - tracks primary payer and group members (family or corporate)
export const billingGroups = pgTable("billing_groups", {
  id: serial("id").primaryKey(),
  
  // Primary payer info
  primaryEmail: varchar("primary_email").notNull().unique(),
  primaryStripeCustomerId: varchar("primary_stripe_customer_id"),
  primaryStripeSubscriptionId: varchar("primary_stripe_subscription_id"),
  
  // Group metadata
  groupName: varchar("group_name"), // optional friendly name like "Smith Family"
  type: text("type").default("family"), // 'family' or 'corporate'
  companyName: text("company_name"),
  hubspotCompanyId: text("hubspot_company_id"),
  maxSeats: integer("max_seats"), // for corporate groups: total purchased seats
  
  // Status
  isActive: boolean("is_active").default(true),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdBy: varchar("created_by"),
  createdByName: varchar("created_by_name"),
}, (table) => [
  index("billing_groups_primary_email_idx").on(table.primaryEmail),
]);

// Group members - links individual members to a billing group
export const groupMembers = pgTable("group_members", {
  id: serial("id").primaryKey(),
  
  // Billing group linkage
  billingGroupId: integer("billing_group_id").notNull(),
  
  // Member info
  memberEmail: varchar("member_email").notNull(),
  memberTier: varchar("member_tier").notNull(), // tier name for allowance calculation
  relationship: varchar("relationship"), // 'spouse', 'child', 'parent', etc.
  
  // Stripe line item tracking
  stripeSubscriptionItemId: varchar("stripe_subscription_item_id"),
  stripePriceId: varchar("stripe_price_id"),
  
  // Add-on pricing (stored for audit purposes)
  addOnPriceCents: integer("add_on_price_cents"),
  
  // Status
  isActive: boolean("is_active").default(true),
  
  // Timestamps
  addedAt: timestamp("added_at").defaultNow(),
  removedAt: timestamp("removed_at"),
  addedBy: varchar("added_by"),
  addedByName: varchar("added_by_name"),
}, (table) => [
  index("group_members_billing_group_id_idx").on(table.billingGroupId),
  index("group_members_member_email_idx").on(table.memberEmail),
]);

// Family add-on products - configurable pricing for family add-ons by tier
export const familyAddOnProducts = pgTable("family_add_on_products", {
  id: serial("id").primaryKey(),
  
  // Tier info
  tierName: varchar("tier_name").notNull().unique(), // 'Premium', 'Social', etc.
  
  // Stripe product/price IDs
  stripeProductId: varchar("stripe_product_id"),
  stripePriceId: varchar("stripe_price_id"),
  
  // Pricing
  priceCents: integer("price_cents").notNull(), // e.g., 7500 for $75
  billingInterval: varchar("billing_interval").default("month"),
  
  // Display
  displayName: varchar("display_name"), // e.g., "Family Add-on - Premium"
  description: text("description"),
  
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("family_add_on_products_tier_name_idx").on(table.tierName),
]);

export type BillingGroup = typeof billingGroups.$inferSelect;
export type InsertBillingGroup = typeof billingGroups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type InsertGroupMember = typeof groupMembers.$inferInsert;
export type FamilyAddOnProduct = typeof familyAddOnProducts.$inferSelect;
export type InsertFamilyAddOnProduct = typeof familyAddOnProducts.$inferInsert;

// Legacy table aliases for backwards compatibility
export const familyGroups = billingGroups;
export const familyMembers = groupMembers;

// Legacy type aliases for backwards compatibility
export type FamilyGroup = BillingGroup;
export type InsertFamilyGroup = InsertBillingGroup;
export type FamilyMember = GroupMember;
export type InsertFamilyMember = InsertGroupMember;
