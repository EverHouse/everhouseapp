-- ============================================================================
-- DAY PASS REDEMPTION FIELDS
-- ============================================================================
-- Add redeemed_at and booking_id columns to track when day passes are redeemed
-- and link them to the booking they were used for.
-- ============================================================================

ALTER TABLE day_pass_purchases 
ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS booking_id INTEGER REFERENCES booking_requests(id) ON DELETE SET NULL;

-- Create index for booking lookups
CREATE INDEX IF NOT EXISTS idx_day_pass_purchases_booking_id ON day_pass_purchases(booking_id);
CREATE INDEX IF NOT EXISTS idx_day_pass_purchases_redeemed_at ON day_pass_purchases(redeemed_at);
