-- Add product_id column to stripe_payment_intents for better reporting
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS product_id VARCHAR;
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS product_name VARCHAR;

-- Create index for product_id lookups
CREATE INDEX IF NOT EXISTS stripe_payment_intents_product_id_idx ON stripe_payment_intents(product_id);
