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

export const billingAuditLog = pgTable("billing_audit_log", {
  id: serial("id").primaryKey(),
  memberEmail: varchar("member_email").notNull(),
  hubspotDealId: varchar("hubspot_deal_id"),
  actionType: varchar("action_type").notNull(), // 'line_item_added', 'line_item_removed', 'discount_applied', 'discount_overridden', 'stage_changed'
  actionDetails: jsonb("action_details"), // flexible JSON for action-specific data
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  performedBy: varchar("performed_by").notNull(),
  performedByName: varchar("performed_by_name"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("billing_audit_log_member_email_idx").on(table.memberEmail),
  index("billing_audit_log_deal_id_idx").on(table.hubspotDealId),
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
export type BillingAuditLog = typeof billingAuditLog.$inferSelect;
export type InsertBillingAuditLog = typeof billingAuditLog.$inferInsert;
export type HubspotFormConfig = typeof hubspotFormConfigs.$inferSelect;
export type InsertHubspotFormConfig = typeof hubspotFormConfigs.$inferInsert;
