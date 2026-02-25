ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_billing_start_date TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_requested_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_tier_snapshot TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_status TEXT;
