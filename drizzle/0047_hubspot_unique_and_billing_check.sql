-- ============================================================================
-- INTEGRITY HARDENING: Billing Provider State Check
-- ============================================================================
-- Adds a CHECK constraint to prevent invalid billing provider hybrid states
-- where billing_provider contradicts the presence of billing system IDs.
--
-- NOTE: The hubspot_id unique index is created at app startup in db-init.ts
-- (same pattern as stripe_customer_id) because it requires data cleanup first
-- and the migration validator cannot run cleanup before testing constraints.
-- ============================================================================

-- ============================================================================
-- BILLING PROVIDER HYBRID STATE CHECK
-- ============================================================================
-- Prevents the specific invalid state where billing_provider='mindbody' but
-- a Stripe subscription exists. This is the main "hybrid state" the integrity
-- checker flags as critical.
--
-- Valid states:
--   billing_provider = 'stripe'       -> stripe_subscription_id may exist
--   billing_provider = 'mindbody'     -> must NOT have stripe_subscription_id
--   billing_provider = 'family_addon' -> no restriction (managed externally)
--   billing_provider = 'comped'       -> no restriction (complimentary)
--   billing_provider = 'manual'       -> no restriction (manually managed)
--   billing_provider IS NULL or ''    -> no restriction (unclassified, auto-fix handles)
--
-- Pre-clean: fix members who have billing_provider='mindbody' but have a
-- Stripe subscription — these should be reclassified as 'stripe'.
UPDATE users
  SET billing_provider = 'stripe', updated_at = NOW()
  WHERE billing_provider = 'mindbody'
    AND stripe_subscription_id IS NOT NULL
    AND stripe_subscription_id != '';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_billing_provider_no_hybrid;
ALTER TABLE users
  ADD CONSTRAINT users_billing_provider_no_hybrid
  CHECK (
    billing_provider IS DISTINCT FROM 'mindbody'
    OR stripe_subscription_id IS NULL
    OR stripe_subscription_id = ''
  );
