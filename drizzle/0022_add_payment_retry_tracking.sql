-- Add retry tracking columns to stripe_payment_intents for automated dunning
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMP;
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS dunning_notified_at TIMESTAMP;
ALTER TABLE stripe_payment_intents ADD COLUMN IF NOT EXISTS requires_card_update BOOLEAN DEFAULT FALSE;
