-- ============================================================================
-- ADD MISSING FK CONSTRAINTS
-- ============================================================================
-- Multiple FK constraints defined in Drizzle schema were never captured in
-- migration files. During deployment, Drizzle auto-generates ALTER TABLE
-- statements to add them, but orphaned data in production violates the
-- constraints and causes deployment failures.
--
-- This migration:
--   1. Cleans up orphaned references (SET NULL or DELETE as appropriate)
--   2. Drops any legacy-named constraints (managed by db-init.ts)
--   3. Adds the Drizzle-named FK constraints
-- ============================================================================

-- ============================================================================
-- 1. booking_requests.session_id → booking_sessions.id (ON DELETE SET NULL)
-- ============================================================================
UPDATE booking_requests SET session_id = NULL
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_sessions WHERE id = booking_requests.session_id);

ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_session_id_fkey;
ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_session_id_booking_sessions_id_fk;
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_session_id_booking_sessions_id_fk
  FOREIGN KEY ("session_id") REFERENCES "public"."booking_sessions"("id")
  ON DELETE set null ON UPDATE no action;

-- ============================================================================
-- 2. booking_requests.closure_id → facility_closures.id (ON DELETE SET NULL)
-- ============================================================================
UPDATE booking_requests SET closure_id = NULL
WHERE closure_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM facility_closures WHERE id = booking_requests.closure_id);

ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_closure_id_fkey;
ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_closure_id_facility_closures_id_fk;
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_closure_id_facility_closures_id_fk
  FOREIGN KEY ("closure_id") REFERENCES "public"."facility_closures"("id")
  ON DELETE set null ON UPDATE no action;

-- ============================================================================
-- 3. booking_participants.session_id → booking_sessions.id (ON DELETE CASCADE)
-- ============================================================================
DELETE FROM booking_participants
WHERE NOT EXISTS (SELECT 1 FROM booking_sessions WHERE id = booking_participants.session_id);

ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_session_id_fkey;
ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_session_id_booking_sessions_id_fk;
ALTER TABLE booking_participants
  ADD CONSTRAINT booking_participants_session_id_booking_sessions_id_fk
  FOREIGN KEY ("session_id") REFERENCES "public"."booking_sessions"("id")
  ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- 4. booking_participants.user_id → users.id (ON DELETE SET NULL)
-- ============================================================================
UPDATE booking_participants SET user_id = NULL
WHERE user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = booking_participants.user_id);

ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_user_id_fkey;
ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_user_id_users_id_fk;
ALTER TABLE booking_participants
  ADD CONSTRAINT booking_participants_user_id_users_id_fk
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

-- ============================================================================
-- 5. booking_participants.guest_id → guests.id (ON DELETE SET NULL)
-- ============================================================================
UPDATE booking_participants SET guest_id = NULL
WHERE guest_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM guests WHERE id = booking_participants.guest_id);

ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_guest_id_fkey;
ALTER TABLE booking_participants
  DROP CONSTRAINT IF EXISTS booking_participants_guest_id_guests_id_fk;
ALTER TABLE booking_participants
  ADD CONSTRAINT booking_participants_guest_id_guests_id_fk
  FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id")
  ON DELETE set null ON UPDATE no action;

-- ============================================================================
-- 6. wellness_enrollments.class_id → wellness_classes.id (ON DELETE CASCADE)
-- ============================================================================
DELETE FROM wellness_enrollments
WHERE class_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM wellness_classes WHERE id = wellness_enrollments.class_id);

ALTER TABLE wellness_enrollments
  DROP CONSTRAINT IF EXISTS wellness_enrollments_class_id_fkey;
ALTER TABLE wellness_enrollments
  DROP CONSTRAINT IF EXISTS wellness_enrollments_class_id_wellness_classes_id_fk;
ALTER TABLE wellness_enrollments
  ADD CONSTRAINT wellness_enrollments_class_id_wellness_classes_id_fk
  FOREIGN KEY ("class_id") REFERENCES "public"."wellness_classes"("id")
  ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- 7. booking_fee_snapshots: rename legacy _fkey to Drizzle _fk naming
-- ============================================================================
ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_booking_id_fkey;
ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_booking_id_booking_requests_id_fk;

DELETE FROM booking_fee_snapshots
WHERE booking_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = booking_fee_snapshots.booking_id);

ALTER TABLE booking_fee_snapshots
  ADD CONSTRAINT booking_fee_snapshots_booking_id_booking_requests_id_fk
  FOREIGN KEY ("booking_id") REFERENCES "public"."booking_requests"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_session_id_fkey;
ALTER TABLE booking_fee_snapshots
  DROP CONSTRAINT IF EXISTS booking_fee_snapshots_session_id_booking_sessions_id_fk;

UPDATE booking_fee_snapshots SET session_id = NULL
WHERE session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_sessions WHERE id = booking_fee_snapshots.session_id);

ALTER TABLE booking_fee_snapshots
  ADD CONSTRAINT booking_fee_snapshots_session_id_booking_sessions_id_fk
  FOREIGN KEY ("session_id") REFERENCES "public"."booking_sessions"("id")
  ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- 8. guest_pass_holds: rename legacy _fkey to Drizzle _fk naming
-- ============================================================================
ALTER TABLE guest_pass_holds
  DROP CONSTRAINT IF EXISTS guest_pass_holds_booking_id_fkey;
ALTER TABLE guest_pass_holds
  DROP CONSTRAINT IF EXISTS guest_pass_holds_booking_id_booking_requests_id_fk;

DELETE FROM guest_pass_holds
WHERE booking_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = guest_pass_holds.booking_id);

ALTER TABLE guest_pass_holds
  ADD CONSTRAINT guest_pass_holds_booking_id_booking_requests_id_fk
  FOREIGN KEY ("booking_id") REFERENCES "public"."booking_requests"("id")
  ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- 9. conference_prepayments: rename legacy _fkey to Drizzle _fk naming
-- ============================================================================
ALTER TABLE conference_prepayments
  DROP CONSTRAINT IF EXISTS conference_prepayments_booking_id_fkey;
ALTER TABLE conference_prepayments
  DROP CONSTRAINT IF EXISTS conference_prepayments_booking_id_booking_requests_id_fk;

DELETE FROM conference_prepayments
WHERE booking_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = conference_prepayments.booking_id);

ALTER TABLE conference_prepayments
  ADD CONSTRAINT conference_prepayments_booking_id_booking_requests_id_fk
  FOREIGN KEY ("booking_id") REFERENCES "public"."booking_requests"("id")
  ON DELETE cascade ON UPDATE no action;

-- ============================================================================
-- 10. booking_wallet_passes: clean up orphaned references
--     Table may or may not exist (created via drizzle-kit push in dev).
--     If it exists, clean up orphans; if not, Drizzle CREATE TABLE handles it.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_wallet_passes') THEN
    DELETE FROM booking_wallet_passes
    WHERE member_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users WHERE id = booking_wallet_passes.member_id);

    DELETE FROM booking_wallet_passes
    WHERE booking_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE id = booking_wallet_passes.booking_id);

    BEGIN
      ALTER TABLE booking_wallet_passes
        DROP CONSTRAINT IF EXISTS booking_wallet_passes_member_id_fkey;
      ALTER TABLE booking_wallet_passes
        DROP CONSTRAINT IF EXISTS booking_wallet_passes_member_id_users_id_fk;
      ALTER TABLE booking_wallet_passes
        DROP CONSTRAINT IF EXISTS booking_wallet_passes_booking_id_fkey;
      ALTER TABLE booking_wallet_passes
        DROP CONSTRAINT IF EXISTS booking_wallet_passes_booking_id_booking_requests_id_fk;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    BEGIN
      ALTER TABLE booking_wallet_passes
        ADD CONSTRAINT booking_wallet_passes_booking_id_booking_requests_id_fk
        FOREIGN KEY ("booking_id") REFERENCES "public"."booking_requests"("id")
        ON DELETE cascade ON UPDATE no action;

      ALTER TABLE booking_wallet_passes
        ADD CONSTRAINT booking_wallet_passes_member_id_users_id_fk
        FOREIGN KEY ("member_id") REFERENCES "public"."users"("id")
        ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;
