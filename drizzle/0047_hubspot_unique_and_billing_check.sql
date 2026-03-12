-- ============================================================================
-- INTEGRITY HARDENING: HubSpot ID Uniqueness + Billing Provider State Check
-- ============================================================================
-- 1. Adds a partial unique index on hubspot_id to prevent duplicate HubSpot IDs
--    (mirrors the pattern from 0041 for stripe_customer_id).
-- 2. Adds a CHECK constraint to prevent invalid billing provider hybrid states
--    where billing_provider contradicts the presence of billing system IDs.
-- ============================================================================

-- ============================================================================
-- 1. UNIQUE INDEX ON hubspot_id (where not null)
-- ============================================================================

-- Step 1a: Normalize whitespace-only hubspot_ids to NULL
UPDATE users SET hubspot_id = NULL
  WHERE hubspot_id IS NOT NULL AND TRIM(hubspot_id) = '';

-- Step 1b: Trim whitespace from hubspot_ids
UPDATE users SET hubspot_id = TRIM(hubspot_id)
  WHERE hubspot_id IS NOT NULL AND hubspot_id != TRIM(hubspot_id);

-- Step 1c: NULL out duplicate hubspot_ids, keeping the most recently updated.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  WITH ranked AS (
    SELECT id, hubspot_id,
      ROW_NUMBER() OVER (
        PARTITION BY hubspot_id
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      ) as rn
    FROM users
    WHERE hubspot_id IS NOT NULL AND hubspot_id != ''
  )
  UPDATE users SET hubspot_id = NULL
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  GET DIAGNOSTICS dup_count = ROW_COUNT;
  IF dup_count > 0 THEN
    RAISE NOTICE 'Cleared % duplicate hubspot_id values', dup_count;
  END IF;

  -- Verify no duplicates remain before creating index
  SELECT COUNT(*) INTO dup_count
    FROM (
      SELECT hubspot_id FROM users
      WHERE hubspot_id IS NOT NULL AND hubspot_id != ''
      GROUP BY hubspot_id HAVING COUNT(*) > 1
    ) dupes;

  IF dup_count > 0 THEN
    RAISE NOTICE 'WARNING: % duplicate hubspot_id groups still remain after cleanup', dup_count;
  END IF;
END $$;

DROP INDEX IF EXISTS users_hubspot_id_unique;
CREATE UNIQUE INDEX users_hubspot_id_unique
  ON users (hubspot_id) WHERE hubspot_id IS NOT NULL AND hubspot_id != '';

-- ============================================================================
-- 2. BILLING PROVIDER HYBRID STATE CHECK
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
