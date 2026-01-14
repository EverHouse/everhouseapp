CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text,
	"category" varchar(100) DEFAULT 'general' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "billing_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"hubspot_deal_id" varchar,
	"action_type" varchar NOT NULL,
	"action_details" jsonb,
	"previous_value" text,
	"new_value" text,
	"performed_by" varchar NOT NULL,
	"performed_by_name" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "discount_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"discount_tag" varchar NOT NULL,
	"discount_percent" integer DEFAULT 0 NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "discount_rules_discount_tag_unique" UNIQUE("discount_tag")
);
--> statement-breakpoint
CREATE TABLE "hubspot_deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"hubspot_contact_id" varchar,
	"hubspot_deal_id" varchar NOT NULL,
	"deal_name" varchar,
	"pipeline_id" varchar,
	"pipeline_stage" varchar,
	"is_primary" boolean DEFAULT true,
	"last_known_mindbody_status" varchar,
	"last_payment_status" varchar,
	"last_payment_check" timestamp,
	"last_stage_sync_at" timestamp,
	"last_sync_error" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "hubspot_deals_hubspot_deal_id_unique" UNIQUE("hubspot_deal_id")
);
--> statement-breakpoint
CREATE TABLE "hubspot_form_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_type" varchar NOT NULL,
	"hubspot_form_id" varchar NOT NULL,
	"form_name" varchar NOT NULL,
	"form_fields" jsonb DEFAULT '[]'::jsonb,
	"hidden_fields" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "hubspot_form_configs_form_type_unique" UNIQUE("form_type")
);
--> statement-breakpoint
CREATE TABLE "hubspot_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"hubspot_deal_id" varchar NOT NULL,
	"hubspot_line_item_id" varchar,
	"hubspot_product_id" varchar NOT NULL,
	"product_name" varchar NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"discount_percent" integer DEFAULT 0,
	"discount_reason" varchar,
	"total_amount" numeric(10, 2),
	"status" varchar DEFAULT 'pending',
	"sync_error" text,
	"created_by" varchar,
	"created_by_name" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "hubspot_line_items_hubspot_line_item_id_unique" UNIQUE("hubspot_line_item_id")
);
--> statement-breakpoint
CREATE TABLE "hubspot_product_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"hubspot_product_id" varchar NOT NULL,
	"product_name" varchar NOT NULL,
	"product_type" varchar NOT NULL,
	"tier_name" varchar,
	"unit_price" numeric(10, 2) NOT NULL,
	"billing_frequency" varchar,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "hubspot_product_mappings_hubspot_product_id_unique" UNIQUE("hubspot_product_id")
);
--> statement-breakpoint
CREATE TABLE "legacy_import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar NOT NULL,
	"file_name" varchar,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"total_rows" integer DEFAULT 0,
	"processed_rows" integer DEFAULT 0,
	"matched_rows" integer DEFAULT 0,
	"skipped_rows" integer DEFAULT 0,
	"error_rows" integer DEFAULT 0,
	"error_details" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "legacy_purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar,
	"mindbody_client_id" varchar NOT NULL,
	"member_email" varchar,
	"mindbody_sale_id" varchar NOT NULL,
	"line_number" integer DEFAULT 1 NOT NULL,
	"item_name" varchar NOT NULL,
	"item_category" varchar,
	"item_price_cents" integer DEFAULT 0 NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"discount_amount_cents" integer DEFAULT 0,
	"tax_cents" integer DEFAULT 0,
	"item_total_cents" integer DEFAULT 0 NOT NULL,
	"payment_method" varchar,
	"sale_date" timestamp NOT NULL,
	"linked_booking_session_id" integer,
	"linked_at" timestamp,
	"is_comp" boolean DEFAULT false,
	"is_synced" boolean DEFAULT false,
	"hubspot_deal_id" varchar,
	"imported_at" timestamp DEFAULT now(),
	"import_batch_id" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "billing_provider" varchar DEFAULT 'mindbody';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "member_since" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "legacy_source" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "archived_by" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "archived_by" varchar;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "archived_by" varchar;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "archived_by" varchar;--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_key_idx" ON "app_settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "billing_audit_log_member_email_idx" ON "billing_audit_log" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "billing_audit_log_deal_id_idx" ON "billing_audit_log" USING btree ("hubspot_deal_id");--> statement-breakpoint
CREATE INDEX "billing_audit_log_created_at_idx" ON "billing_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hubspot_deals_member_email_idx" ON "hubspot_deals" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "hubspot_deals_hubspot_deal_id_idx" ON "hubspot_deals" USING btree ("hubspot_deal_id");--> statement-breakpoint
CREATE INDEX "hubspot_line_items_deal_id_idx" ON "hubspot_line_items" USING btree ("hubspot_deal_id");--> statement-breakpoint
CREATE INDEX "legacy_purchases_mindbody_client_id_idx" ON "legacy_purchases" USING btree ("mindbody_client_id");--> statement-breakpoint
CREATE INDEX "legacy_purchases_sale_date_idx" ON "legacy_purchases" USING btree ("sale_date");--> statement-breakpoint
CREATE INDEX "legacy_purchases_item_category_idx" ON "legacy_purchases" USING btree ("item_category");--> statement-breakpoint
CREATE INDEX "legacy_purchases_member_email_idx" ON "legacy_purchases" USING btree ("member_email");