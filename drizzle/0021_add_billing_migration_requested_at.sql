-- ============================================================================
-- ADD BILLING MIGRATION REQUESTED AT FIELD
-- ============================================================================
-- This migration adds the billing_migration_requested_at timestamp column
-- to the users table to track when MindBody members request to migrate 
-- their billing to Stripe.
-- ============================================================================

ALTER TABLE users ADD COLUMN "billing_migration_requested_at" timestamp;
