-- ============================================================================
-- PHASE 1: DATABASE INTEGRITY CONSTRAINTS
-- ============================================================================
-- Adds CHECK constraints to guest_passes table and ensures schema.ts
-- matches existing database indexes for booking_sessions and booking_participants.
-- ============================================================================

-- CHECK constraint: passes_used must never exceed passes_total
ALTER TABLE guest_passes
ADD CONSTRAINT guest_passes_usage_check CHECK (passes_used <= passes_total);

-- CHECK constraint: passes_used must never go negative
ALTER TABLE guest_passes
ADD CONSTRAINT guest_passes_non_negative_check CHECK (passes_used >= 0);

-- NOTE: The following UNIQUE indexes already exist in the database
-- (created via earlier migrations) and are now reflected in schema.ts:
-- 1. booking_sessions_resource_datetime_unique ON booking_sessions(resource_id, session_date, start_time, end_time)
-- 2. booking_participants_session_user_unique_idx ON booking_participants(session_id, user_id) WHERE user_id IS NOT NULL

-- Add refunded_at column to booking_participants if it doesn't exist
-- (This column exists in DB but was missing from schema.ts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'booking_participants' AND column_name = 'refunded_at'
  ) THEN
    ALTER TABLE booking_participants ADD COLUMN refunded_at TIMESTAMPTZ;
  END IF;
END $$;
