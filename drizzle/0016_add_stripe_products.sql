-- Create stripe_products table for HubSpot to Stripe product sync
CREATE TABLE IF NOT EXISTS stripe_products (
  id SERIAL PRIMARY KEY,
  hubspot_product_id VARCHAR NOT NULL UNIQUE,
  stripe_product_id VARCHAR NOT NULL UNIQUE,
  stripe_price_id VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  price_cents INTEGER NOT NULL,
  billing_interval VARCHAR NOT NULL, -- 'month', 'year', 'one_time'
  billing_interval_count INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS stripe_products_hubspot_product_id_idx ON stripe_products(hubspot_product_id);
CREATE INDEX IF NOT EXISTS stripe_products_stripe_product_id_idx ON stripe_products(stripe_product_id);
CREATE INDEX IF NOT EXISTS stripe_products_is_active_idx ON stripe_products(is_active);
