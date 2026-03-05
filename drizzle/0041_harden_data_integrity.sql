-- ============================================================================
-- DATA INTEGRITY HARDENING - DATABASE-LEVEL CONSTRAINTS
-- ============================================================================
-- Adds CHECK constraints and CASCADE rules to prevent data integrity issues
-- at the database level, reducing reliance on runtime integrity checks.
--
-- All constraints use pre-cleanup or NOT VALID + deferred VALIDATE to be
-- safe against existing data that may violate the new rules.
-- ============================================================================

-- 1. booking_fee_snapshots: CASCADE on booking deletion
--    Pre-clean: remove snapshots referencing deleted bookings before adding FK.
DELETE FROM booking_fee_snapshots
  WHERE booking_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = booking_fee_snapshots.booking_id);

ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_booking_id_fkey;
ALTER TABLE booking_fee_snapshots
  ADD CONSTRAINT booking_fee_snapshots_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;

-- 2. booking_fee_snapshots: CASCADE on session deletion
--    Pre-clean: NULL out session_id for snapshots referencing deleted sessions.
UPDATE booking_fee_snapshots SET session_id = NULL
  WHERE session_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM booking_sessions WHERE id = booking_fee_snapshots.session_id);

ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_session_id_fkey;
ALTER TABLE booking_fee_snapshots
  ADD CONSTRAINT booking_fee_snapshots_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES booking_sessions(id) ON DELETE CASCADE;

-- 3. Booking time validity: CHECK constraint
--    Pre-clean: fix any existing invalid records by swapping times.
UPDATE booking_requests
  SET start_time = end_time, end_time = start_time
  WHERE end_time <= start_time
    AND NOT (start_time >= '20:00:00' AND end_time <= '06:00:00');

ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_time_order_check;
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_time_order_check
  CHECK (end_time > start_time OR (start_time >= '20:00:00' AND end_time <= '06:00:00'));

-- 4. Session time validity
UPDATE booking_sessions
  SET start_time = end_time, end_time = start_time
  WHERE end_time <= start_time
    AND NOT (start_time >= '20:00:00' AND end_time <= '06:00:00');

ALTER TABLE booking_sessions
  DROP CONSTRAINT IF EXISTS booking_sessions_time_order_check;
ALTER TABLE booking_sessions
  ADD CONSTRAINT booking_sessions_time_order_check
  CHECK (end_time > start_time OR (start_time >= '20:00:00' AND end_time <= '06:00:00'));

-- 5. Users: active members must have email
--    Pre-clean: set status to 'deleted' for active members without email.
UPDATE users SET membership_status = 'deleted'
  WHERE email IS NULL
    AND membership_status NOT IN ('terminated', 'cancelled', 'deleted', 'former_member');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_active_email_check;
ALTER TABLE users
  ADD CONSTRAINT users_active_email_check
  CHECK (
    membership_status IN ('terminated', 'cancelled', 'deleted', 'former_member')
    OR email IS NOT NULL
  );

-- 6. Unique constraint on stripe_customer_id (where not null)
--    Pre-clean: NULL out duplicate stripe_customer_ids, keeping the most recent.
WITH ranked AS (
  SELECT id, stripe_customer_id,
    ROW_NUMBER() OVER (PARTITION BY stripe_customer_id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) as rn
  FROM users
  WHERE stripe_customer_id IS NOT NULL
)
UPDATE users SET stripe_customer_id = NULL
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DROP INDEX IF EXISTS users_stripe_customer_id_unique;
CREATE UNIQUE INDEX users_stripe_customer_id_unique
  ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- 7. guest_pass_holds: CASCADE on booking deletion
--    Pre-clean: remove holds referencing deleted bookings.
DELETE FROM guest_pass_holds
  WHERE booking_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = guest_pass_holds.booking_id);

ALTER TABLE guest_pass_holds
  DROP CONSTRAINT IF EXISTS guest_pass_holds_booking_id_fkey;
ALTER TABLE guest_pass_holds
  ADD CONSTRAINT guest_pass_holds_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;

-- 8. conference_prepayments: CASCADE on booking deletion
--    Pre-clean: remove prepayments referencing deleted bookings.
DELETE FROM conference_prepayments
  WHERE booking_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = conference_prepayments.booking_id);

ALTER TABLE conference_prepayments
  DROP CONSTRAINT IF EXISTS conference_prepayments_booking_id_fkey;
ALTER TABLE conference_prepayments
  ADD CONSTRAINT conference_prepayments_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;
