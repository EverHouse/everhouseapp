CREATE TYPE "public"."trackman_bay_slot_status" AS ENUM('booked', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."trackman_webhook_event_type" AS ENUM('user_update', 'booking_update', 'purchase_update', 'purchase_paid', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."booking_source" ADD VALUE 'trackman_webhook';--> statement-breakpoint
CREATE TABLE "user_linked_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"primary_email" varchar NOT NULL,
	"linked_email" varchar NOT NULL,
	"source" varchar DEFAULT 'manual',
	"created_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trackman_bay_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"resource_id" integer NOT NULL,
	"slot_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"status" "trackman_bay_slot_status" DEFAULT 'booked',
	"trackman_booking_id" varchar,
	"customer_email" varchar,
	"customer_name" varchar,
	"player_count" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trackman_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" "trackman_webhook_event_type" NOT NULL,
	"trackman_booking_id" varchar,
	"trackman_user_id" varchar,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp,
	"processing_error" text,
	"matched_booking_id" integer,
	"matched_user_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"processed_by" varchar(255),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_email" varchar(255) NOT NULL,
	"staff_name" varchar(255),
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(100) NOT NULL,
	"resource_id" varchar(255),
	"resource_name" varchar(255),
	"details" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_export_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar(255) NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"download_url" text,
	"expires_at" timestamp,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "webhook_processed_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"event_type" varchar(100),
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_processed_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "billing_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"primary_email" varchar NOT NULL,
	"primary_stripe_customer_id" varchar,
	"primary_stripe_subscription_id" varchar,
	"group_name" varchar,
	"type" text DEFAULT 'family',
	"company_name" text,
	"hubspot_company_id" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"created_by" varchar,
	"created_by_name" varchar,
	CONSTRAINT "billing_groups_primary_email_unique" UNIQUE("primary_email")
);
--> statement-breakpoint
CREATE TABLE "family_add_on_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"tier_name" varchar NOT NULL,
	"stripe_product_id" varchar,
	"stripe_price_id" varchar,
	"price_cents" integer NOT NULL,
	"billing_interval" varchar DEFAULT 'month',
	"display_name" varchar,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "family_add_on_products_tier_name_unique" UNIQUE("tier_name")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"billing_group_id" integer NOT NULL,
	"member_email" varchar NOT NULL,
	"member_tier" varchar NOT NULL,
	"relationship" varchar,
	"stripe_subscription_item_id" varchar,
	"stripe_price_id" varchar,
	"add_on_price_cents" integer,
	"is_active" boolean DEFAULT true,
	"added_at" timestamp DEFAULT now(),
	"removed_at" timestamp,
	"added_by" varchar,
	"added_by_name" varchar
);
--> statement-breakpoint
CREATE TABLE "stripe_payment_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"stripe_payment_intent_id" varchar NOT NULL,
	"stripe_customer_id" varchar,
	"amount_cents" integer NOT NULL,
	"purpose" varchar NOT NULL,
	"booking_id" integer,
	"session_id" integer,
	"description" text,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0,
	"last_retry_at" timestamp,
	"failure_reason" text,
	"dunning_notified_at" timestamp,
	"requires_card_update" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "stripe_payment_intents_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"hubspot_product_id" varchar NOT NULL,
	"stripe_product_id" varchar NOT NULL,
	"stripe_price_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"price_cents" integer NOT NULL,
	"billing_interval" varchar NOT NULL,
	"billing_interval_count" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "stripe_products_hubspot_product_id_unique" UNIQUE("hubspot_product_id"),
	CONSTRAINT "stripe_products_stripe_product_id_unique" UNIQUE("stripe_product_id")
);
--> statement-breakpoint
CREATE TABLE "day_pass_purchases" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar,
	"product_type" varchar NOT NULL,
	"amount_cents" integer NOT NULL,
	"quantity" integer DEFAULT 1,
	"remaining_uses" integer DEFAULT 1,
	"status" varchar DEFAULT 'active',
	"stripe_payment_intent_id" varchar NOT NULL,
	"stripe_customer_id" varchar NOT NULL,
	"hubspot_deal_id" varchar,
	"purchaser_email" varchar NOT NULL,
	"purchaser_first_name" varchar,
	"purchaser_last_name" varchar,
	"purchaser_phone" varchar,
	"source" varchar DEFAULT 'stripe',
	"purchased_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pass_redemption_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" varchar NOT NULL,
	"redeemed_by" varchar NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now(),
	"location" varchar DEFAULT 'front_desk',
	"notes" varchar
);
--> statement-breakpoint
DROP INDEX "booking_requests_trackman_id_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "do_not_sell_my_info" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_export_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "waiver_version" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "waiver_signed_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hubspot_company_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "street_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "zip_code" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_hubspot_notes_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "billing_group_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "billing_migration_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_tier" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "grace_period_start" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "grace_period_email_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "visitor_type" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_activity_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_activity_source" varchar;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "guest_fee_cents" integer DEFAULT 2500;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "stripe_product_id" varchar;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "stripe_price_id" varchar;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "founding_price_id" varchar;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "billing_interval" varchar DEFAULT 'month';--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "product_type" varchar DEFAULT 'subscription';--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "min_quantity" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN "tier_type" text DEFAULT 'individual';--> statement-breakpoint
ALTER TABLE "booking_participants" ADD COLUMN "stripe_payment_intent_id" varchar;--> statement-breakpoint
ALTER TABLE "booking_participants" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking_participants" ADD COLUMN "used_guest_pass" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "booking_participants" ADD COLUMN "waiver_reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking_participants" ADD COLUMN "cached_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "booking_payment_audit" ADD COLUMN "payment_method" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "user_id" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "guardian_name" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "guardian_relationship" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "guardian_phone" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "guardian_consent_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "overage_minutes" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "overage_fee_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "overage_paid" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "overage_payment_intent_id" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "trackman_external_id" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "is_unmatched" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "trackman_customer_notes" text;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "was_auto_linked" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "origin" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "last_sync_source" varchar;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "last_trackman_sync_at" timestamp;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "stripe_payment_intent_id" varchar;--> statement-breakpoint
ALTER TABLE "trackman_bay_slots" ADD CONSTRAINT "trackman_bay_slots_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_linked_emails_primary_idx" ON "user_linked_emails" USING btree ("primary_email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_linked_emails_linked_idx" ON "user_linked_emails" USING btree ("linked_email");--> statement-breakpoint
CREATE INDEX "trackman_bay_slots_resource_date_idx" ON "trackman_bay_slots" USING btree ("resource_id","slot_date");--> statement-breakpoint
CREATE INDEX "trackman_bay_slots_trackman_booking_idx" ON "trackman_bay_slots" USING btree ("trackman_booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trackman_bay_slots_unique_idx" ON "trackman_bay_slots" USING btree ("resource_id","slot_date","start_time","trackman_booking_id");--> statement-breakpoint
CREATE INDEX "trackman_webhook_events_type_idx" ON "trackman_webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "trackman_webhook_events_trackman_booking_idx" ON "trackman_webhook_events" USING btree ("trackman_booking_id");--> statement-breakpoint
CREATE INDEX "trackman_webhook_events_created_idx" ON "trackman_webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "account_deletion_requests_user_id_idx" ON "account_deletion_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_deletion_requests_status_idx" ON "account_deletion_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_requests_pending_user_idx" ON "account_deletion_requests" USING btree ("user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "admin_audit_log_staff_email_idx" ON "admin_audit_log" USING btree ("staff_email");--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "admin_audit_log_resource_type_idx" ON "admin_audit_log" USING btree ("resource_type");--> statement-breakpoint
CREATE INDEX "admin_audit_log_resource_id_idx" ON "admin_audit_log" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "data_export_requests_user_email_idx" ON "data_export_requests" USING btree ("user_email");--> statement-breakpoint
CREATE INDEX "data_export_requests_status_idx" ON "data_export_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_processed_events_event_id_idx" ON "webhook_processed_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_processed_events_processed_at_idx" ON "webhook_processed_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "billing_groups_primary_email_idx" ON "billing_groups" USING btree ("primary_email");--> statement-breakpoint
CREATE INDEX "family_add_on_products_tier_name_idx" ON "family_add_on_products" USING btree ("tier_name");--> statement-breakpoint
CREATE INDEX "group_members_billing_group_id_idx" ON "group_members" USING btree ("billing_group_id");--> statement-breakpoint
CREATE INDEX "group_members_member_email_idx" ON "group_members" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "stripe_payment_intents_user_id_idx" ON "stripe_payment_intents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "stripe_payment_intents_booking_id_idx" ON "stripe_payment_intents" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "stripe_payment_intents_status_idx" ON "stripe_payment_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stripe_products_hubspot_product_id_idx" ON "stripe_products" USING btree ("hubspot_product_id");--> statement-breakpoint
CREATE INDEX "stripe_products_stripe_product_id_idx" ON "stripe_products" USING btree ("stripe_product_id");--> statement-breakpoint
CREATE INDEX "stripe_products_is_active_idx" ON "stripe_products" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_day_pass_purchases_user_id" ON "day_pass_purchases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_day_pass_purchases_stripe_payment_intent_id" ON "day_pass_purchases" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "idx_day_pass_purchases_purchaser_email" ON "day_pass_purchases" USING btree ("purchaser_email");--> statement-breakpoint
CREATE INDEX "idx_day_pass_purchases_purchased_at" ON "day_pass_purchases" USING btree ("purchased_at");--> statement-breakpoint
CREATE INDEX "idx_day_pass_purchases_status" ON "day_pass_purchases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pass_redemption_logs_purchase_id" ON "pass_redemption_logs" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "idx_pass_redemption_logs_redeemed_at" ON "pass_redemption_logs" USING btree ("redeemed_at");--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_sessions" ADD CONSTRAINT "booking_sessions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_stripe_customer_id_idx" ON "users" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "users_membership_status_idx" ON "users" USING btree ("membership_status");--> statement-breakpoint
CREATE INDEX "users_billing_group_id_idx" ON "users" USING btree ("billing_group_id");--> statement-breakpoint
CREATE INDEX "users_visitor_type_idx" ON "users" USING btree ("visitor_type");--> statement-breakpoint
CREATE INDEX "guest_passes_member_email_idx" ON "guest_passes" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "idx_booking_requests_trackman_booking_id" ON "booking_requests" USING btree ("trackman_booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_requests_trackman_external_id_idx" ON "booking_requests" USING btree ("trackman_external_id");--> statement-breakpoint
CREATE INDEX "booking_requests_user_id_idx" ON "booking_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "booking_requests_unmatched_idx" ON "booking_requests" USING btree ("is_unmatched");--> statement-breakpoint
CREATE INDEX "usage_ledger_stripe_payment_intent_idx" ON "usage_ledger" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "notifications_user_email_is_read_idx" ON "notifications" USING btree ("user_email","is_read");