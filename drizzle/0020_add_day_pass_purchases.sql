-- ============================================================================
-- DAY PASS PURCHASES TABLE
-- ============================================================================
-- This migration creates the day_pass_purchases table to track day pass sales
-- for both workspace and golf simulator products.
-- ============================================================================

CREATE TABLE day_pass_purchases (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar,
  "product_type" varchar NOT NULL,
  "amount_cents" integer NOT NULL,
  "quantity" integer DEFAULT 1,
  "stripe_payment_intent_id" varchar NOT NULL,
  "stripe_customer_id" varchar NOT NULL,
  "hubspot_deal_id" varchar,
  "purchaser_email" varchar NOT NULL,
  "purchaser_first_name" varchar,
  "purchaser_last_name" varchar,
  "purchaser_phone" varchar,
  "source" varchar DEFAULT 'stripe',
  "purchased_at" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

-- Create indexes for common query patterns
CREATE INDEX idx_day_pass_purchases_user_id ON day_pass_purchases("user_id");
CREATE INDEX idx_day_pass_purchases_stripe_payment_intent_id ON day_pass_purchases("stripe_payment_intent_id");
CREATE INDEX idx_day_pass_purchases_purchaser_email ON day_pass_purchases("purchaser_email");
CREATE INDEX idx_day_pass_purchases_purchased_at ON day_pass_purchases("purchased_at");
