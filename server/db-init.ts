import { sql } from 'drizzle-orm';
import { db } from './db';
import { getErrorMessage } from './utils/errorUtils';
import { logger } from './core/logger';

export async function setupEmailNormalization(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION normalize_email()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        IF TG_TABLE_NAME IN ('booking_requests', 'notifications', 'push_subscriptions') THEN
          IF NEW.user_email IS NOT NULL THEN
            NEW.user_email := LOWER(TRIM(NEW.user_email));
          END IF;
        END IF;
        
        IF TG_TABLE_NAME = 'users' THEN
          IF NEW.email IS NOT NULL THEN
            NEW.email := LOWER(TRIM(NEW.email));
          END IF;
        END IF;
        
        RETURN NEW;
      END;
      $$;
    `);

    const tables = [
      { table: 'users', column: 'email' },
      { table: 'booking_requests', column: 'user_email' },
      { table: 'notifications', column: 'user_email' },
      { table: 'push_subscriptions', column: 'user_email' }
    ];

    for (const { table, column } of tables) {
      try {
        await db.execute(sql`
          DROP TRIGGER IF EXISTS normalize_email_trigger ON ${sql.raw(table)};
          CREATE TRIGGER normalize_email_trigger
          BEFORE INSERT OR UPDATE OF ${sql.raw(column)} ON ${sql.raw(table)}
          FOR EACH ROW
          EXECUTE FUNCTION normalize_email();
        `);
      } catch (err: unknown) {
        logger.warn(`[DB Init] Skipping email trigger on ${table}: ${getErrorMessage(err)}`);
      }
    }

    logger.info('[DB Init] Email normalization triggers created');
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to create email normalization triggers:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function normalizeExistingEmails(): Promise<{ updated: number }> {
  let totalUpdated = 0;
  
  try {
    const usersResult = await db.execute(sql`
      UPDATE users 
      SET email = LOWER(TRIM(email))
      WHERE email != LOWER(TRIM(email))
    `);
    totalUpdated += usersResult.rowCount || 0;

    const bookingsResult = await db.execute(sql`
      UPDATE booking_requests 
      SET user_email = LOWER(TRIM(user_email))
      WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
    `);
    totalUpdated += bookingsResult.rowCount || 0;

    const notificationsResult = await db.execute(sql`
      UPDATE notifications 
      SET user_email = LOWER(TRIM(user_email))
      WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
    `);
    totalUpdated += notificationsResult.rowCount || 0;

    const pushResult = await db.execute(sql`
      UPDATE push_subscriptions 
      SET user_email = LOWER(TRIM(user_email))
      WHERE user_email IS NOT NULL AND user_email != LOWER(TRIM(user_email))
    `);
    totalUpdated += pushResult.rowCount || 0;

    logger.info(`[DB Init] Normalized ${totalUpdated} email records`);
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to normalize existing emails:', { extra: { errorMessage: getErrorMessage(error) } });
  }

  try {
    const statusResult = await db.execute(sql`
      UPDATE users SET membership_status = LOWER(membership_status), updated_at = NOW()
      WHERE membership_status IS NOT NULL AND membership_status != LOWER(membership_status)
    `);
    const statusFixed = statusResult.rowCount || 0;
    if (statusFixed > 0) {
      logger.info(`[DB Init] Normalized ${statusFixed} membership_status values to lowercase`);
    }
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to normalize membership_status:', { extra: { errorMessage: getErrorMessage(error) } });
  }
  
  return { updated: totalUpdated };
}

export async function fixFunctionSearchPaths(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        new._updated_at = now();
        RETURN NEW;
      END;
      $$;
    `);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION set_updated_at_metadata()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        new.updated_at = now();
        RETURN NEW;
      END;
      $$;
    `);
    logger.info('[DB Init] Function search_path security hardened');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping search_path fix: ${getErrorMessage(err)}`);
  }

  try {
    await db.execute(sql`DROP INDEX IF EXISTS idx_availability_blocks_closure_id`);
    logger.info('[DB Init] Duplicate index cleanup complete');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping duplicate index cleanup: ${getErrorMessage(err)}`);
  }
}

export async function cleanupOrphanedRecords(): Promise<{ notifications: number; oldBookings: number }> {
  let notificationsDeleted = 0;
  let oldBookingsArchived = 0;
  
  try {
    const notifResult = await db.execute(sql`
      DELETE FROM notifications n
      WHERE n.user_email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(n.user_email))
        AND n.created_at < NOW() - INTERVAL '30 days'
    `);
    notificationsDeleted = notifResult.rowCount || 0;
    logger.info(`[DB Init] Cleaned up ${notificationsDeleted} orphaned notifications (older than 30 days)`);

    const bookingResult = await db.execute(sql`
      UPDATE booking_requests
      SET notes = COALESCE(notes, '') || ' [Orphaned record - no matching user]'
      WHERE user_email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(user_email))
        AND notes NOT LIKE '%[Orphaned record%'
        AND status IN ('cancelled', 'declined', 'no_show')
        AND request_date < NOW() - INTERVAL '90 days'
    `);
    oldBookingsArchived = bookingResult.rowCount || 0;
    logger.info(`[DB Init] Marked ${oldBookingsArchived} orphaned old booking records`);

    const lessonClosureResult = await db.execute(sql`
      UPDATE facility_closures
      SET is_active = false
      WHERE is_active = true
        AND (
          LOWER(title) LIKE 'lesson%'
          OR LOWER(title) LIKE 'private lesson%'
          OR LOWER(title) LIKE 'kids lesson%'
          OR LOWER(title) LIKE 'group lesson%'
          OR LOWER(title) ~ '\][\s:|\-]*lesson'
          OR LOWER(title) ~ '\][\s:|\-]*private lesson'
          OR LOWER(title) ~ '\][\s:|\-]*kids lesson'
          OR LOWER(title) ~ '\][\s:|\-]*group lesson'
        )
    `);
    const lessonClosuresDeactivated = lessonClosureResult.rowCount || 0;
    if (lessonClosuresDeactivated > 0) {
      logger.info(`[DB Init] Deactivated ${lessonClosuresDeactivated} lesson closures (lessons should only create availability blocks, not notices)`);
    }
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to cleanup orphaned records:', { extra: { errorMessage: getErrorMessage(error) } });
  }
  
  return { notifications: notificationsDeleted, oldBookings: oldBookingsArchived };
}

export async function createSyncExclusionsTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sync_exclusions (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        reason TEXT DEFAULT 'permanent_delete',
        excluded_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    logger.info('[DB Init] sync_exclusions table created/verified');
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to create sync_exclusions:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function createStripeTransactionCache(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stripe_transaction_cache (
        id SERIAL PRIMARY KEY,
        stripe_id TEXT UNIQUE NOT NULL,
        object_type TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT DEFAULT 'usd',
        status TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        customer_id TEXT,
        customer_email TEXT,
        customer_name TEXT,
        description TEXT,
        metadata JSONB,
        source TEXT DEFAULT 'webhook',
        payment_intent_id TEXT,
        charge_id TEXT,
        invoice_id TEXT
      )
    `);
    
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stripe_cache_created_at ON stripe_transaction_cache(created_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stripe_cache_customer_email ON stripe_transaction_cache(customer_email)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stripe_cache_status ON stripe_transaction_cache(status)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stripe_cache_object_type ON stripe_transaction_cache(object_type)`);
    
    logger.info('[DB Init] stripe_transaction_cache table created/verified');
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to create stripe_transaction_cache:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function seedDefaultNoticeTypes() {
  try {
    await db.execute(sql`
      INSERT INTO notice_types (name, is_preset, sort_order) VALUES 
        ('Announcement', true, 1),
        ('Event', true, 2),
        ('Wellness', true, 3),
        ('Golf', true, 4),
        ('Holiday', true, 5),
        ('Maintenance', true, 6)
      ON CONFLICT (name) DO NOTHING
    `);
    logger.info('[DB Init] Default notice types seeded');
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to seed notice types:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function ensureDatabaseConstraints() {
  try {
    await db.execute(sql`
      DELETE FROM booking_participants
      WHERE NOT EXISTS (
        SELECT 1 FROM booking_sessions WHERE booking_sessions.id = booking_participants.session_id
      );
    `);


    await db.execute(sql`
      DO $$ 
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'booking_requests_status_check'
        ) THEN
          ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_status_check;
        END IF;
        
        ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_status_check 
          CHECK (status IN ('pending', 'approved', 'confirmed', 'declined', 'cancelled', 'cancellation_pending', 'attended', 'no_show', 'expired'));

        IF EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'booking_requests_duration_minutes_check'
        ) THEN
          ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_duration_minutes_check;
        END IF;
        
        ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_duration_minutes_check 
          CHECK (duration_minutes IN (30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360));
      END $$;
    `);
    
    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION prevent_booking_session_overlap()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        DECLARE
          conflict_count INTEGER;
          bypass TEXT;
        BEGIN
          BEGIN
            bypass := current_setting('app.bypass_overlap_check', true);
          EXCEPTION WHEN OTHERS THEN
            bypass := '';
          END;
          IF bypass = 'true' THEN
            RETURN NEW;
          END IF;

          IF NEW.start_time = NEW.end_time THEN
            RETURN NEW;
          END IF;

          BEGIN
            SELECT COUNT(*) INTO conflict_count
            FROM public.booking_sessions bs
            WHERE bs.resource_id = NEW.resource_id
              AND bs.session_date = NEW.session_date
              AND bs.id != COALESCE(NEW.id, 0)
              AND bs.start_time != bs.end_time
              AND tsrange(
                (bs.session_date + bs.start_time)::timestamp,
                CASE WHEN bs.end_time <= bs.start_time
                  THEN (bs.session_date + bs.end_time + INTERVAL '1 day')::timestamp
                  ELSE (bs.session_date + bs.end_time)::timestamp
                END,
                '[)'
              ) && tsrange(
                (NEW.session_date + NEW.start_time)::timestamp,
                CASE WHEN NEW.end_time <= NEW.start_time
                  THEN (NEW.session_date + NEW.end_time + INTERVAL '1 day')::timestamp
                  ELSE (NEW.session_date + NEW.end_time)::timestamp
                END,
                '[)'
              )
              AND EXISTS (
                SELECT 1 FROM public.booking_requests br
                WHERE br.session_id = bs.id
                  AND br.status NOT IN ('cancelled', 'deleted')
              );
          EXCEPTION WHEN data_exception THEN
            conflict_count := 0;
          END;
          
          IF conflict_count > 0 THEN
            RAISE EXCEPTION 'Double-booking not allowed: This time slot on this bay already has a session';
          END IF;
          
          RETURN NEW;
        END;
        $$;

        DROP TRIGGER IF EXISTS check_booking_session_overlap ON booking_sessions;
        CREATE TRIGGER check_booking_session_overlap
        BEFORE INSERT OR UPDATE OF resource_id, session_date, start_time, end_time ON booking_sessions
        FOR EACH ROW
        EXECUTE FUNCTION prevent_booking_session_overlap();
      `);
      logger.info('[DB Init] Double-booking prevention trigger created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping overlap trigger: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION normalize_tier_value()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        DECLARE
          raw_tier TEXT;
          lowered TEXT;
          normalized TEXT;
        BEGIN
          raw_tier := NEW.tier;
          IF raw_tier IS NULL THEN
            RETURN NEW;
          END IF;
          IF raw_tier IN ('Social', 'Core', 'Premium', 'Corporate', 'VIP', 'Staff', 'Group Lessons') THEN
            RETURN NEW;
          END IF;
          lowered := LOWER(TRIM(raw_tier));
          normalized := CASE
            WHEN lowered LIKE '%vip%' THEN 'VIP'
            WHEN lowered LIKE '%premium%' THEN 'Premium'
            WHEN lowered LIKE '%corporate%' THEN 'Corporate'
            WHEN lowered LIKE '%core%' THEN 'Core'
            WHEN lowered LIKE '%social%' THEN 'Social'
            WHEN lowered LIKE '%staff%' THEN 'Staff'
            WHEN lowered LIKE '%group lesson%' OR lowered LIKE '%group-lesson%' THEN 'Group Lessons'
            ELSE NULL
          END;
          IF normalized IS NOT NULL THEN
            NEW.tier := normalized;
            RETURN NEW;
          END IF;
          RETURN NEW;
        END;
        $$;

        DROP TRIGGER IF EXISTS normalize_tier_before_write ON users;
        CREATE TRIGGER normalize_tier_before_write
          BEFORE INSERT OR UPDATE OF tier ON users
          FOR EACH ROW
          EXECUTE FUNCTION normalize_tier_value();
      `);
      logger.info('[DB Init] Tier normalization trigger created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping tier normalization trigger: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'users_tier_check'
          ) THEN
            ALTER TABLE users ADD CONSTRAINT users_tier_check
              CHECK (tier IS NULL OR tier IN ('Social', 'Core', 'Premium', 'Corporate', 'VIP', 'Staff', 'Group Lessons'));
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Tier CHECK constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping tier CHECK constraint: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        UPDATE users SET billing_provider = 'manual', updated_at = NOW()
        WHERE billing_provider NOT IN ('stripe', 'mindbody', 'manual', 'comped', 'family_addon')
        AND billing_provider IS NOT NULL
      `);
    } catch { /* ignore - cleanup before constraint */ }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE users DROP CONSTRAINT IF EXISTS users_billing_provider_check;
          ALTER TABLE users ADD CONSTRAINT users_billing_provider_check
            CHECK (billing_provider IS NULL OR billing_provider IN ('stripe', 'mindbody', 'manual', 'comped', 'family_addon'));
        END $$;
      `);
      logger.info('[DB Init] Billing provider CHECK constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping billing provider CHECK constraint: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE availability_blocks DROP CONSTRAINT IF EXISTS availability_blocks_block_type_check;
          ALTER TABLE availability_blocks ADD CONSTRAINT availability_blocks_block_type_check
            CHECK (block_type IN ('available', 'blocked', 'maintenance', 'wellness', 'event', 'lesson', 'closure'));
        END $$;
      `);
      logger.info('[DB Init] Availability blocks block_type CHECK constraint synced');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping availability_blocks block_type CHECK constraint: ${getErrorMessage(err)}`);
    }

    const bookingSourceValues = ['auto-complete', 'manual-auto-complete', 'system'] as const;
    for (const val of bookingSourceValues) {
      try {
        await db.execute(sql`ALTER TYPE booking_source ADD VALUE IF NOT EXISTS ${val}`);
      } catch {
        logger.debug(`[DB Init] booking_source enum value '${val}' already exists or cannot be added`);
      }
    }
    logger.info('[DB Init] booking_source enum values synced');

    const paymentStatusValues = ['refund_pending'] as const;
    for (const val of paymentStatusValues) {
      try {
        await db.execute(sql`ALTER TYPE participant_payment_status ADD VALUE IF NOT EXISTS ${val}`);
      } catch {
        logger.debug(`[DB Init] participant_payment_status enum value '${val}' already exists or cannot be added`);
      }
    }
    logger.info('[DB Init] participant_payment_status enum values synced');

    try {
      await db.execute(sql`ALTER TABLE users ALTER COLUMN billing_provider SET DEFAULT 'stripe'`);
      logger.info('[DB Init] billing_provider column default set to stripe');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Failed to set billing_provider default: ${getErrorMessage(err)}`);
    }

    try { await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_billing_start_date TIMESTAMP`); } catch { logger.debug('[DB Init] migration_billing_start_date column already exists or failed'); }
    try { await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_requested_by TEXT`); } catch { logger.debug('[DB Init] migration_requested_by column already exists or failed'); }
    try { await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_tier_snapshot TEXT`); } catch { logger.debug('[DB Init] migration_tier_snapshot column already exists or failed'); }
    try { await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_status TEXT`); } catch { logger.debug('[DB Init] migration_status column already exists or failed'); }
    logger.info('[DB Init] Billing migration columns verified');

    try {
      await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMP`);
      await db.execute(sql`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'membership_status_changed_at') THEN
            UPDATE users SET last_modified_at = membership_status_changed_at WHERE last_modified_at IS NULL AND membership_status_changed_at IS NOT NULL;
            ALTER TABLE users DROP COLUMN membership_status_changed_at;
          END IF;
        END $$
      `);
    } catch (err: unknown) { logger.debug('[DB Init] last_modified_at column migration: ' + getErrorMessage(err)); }
    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION trg_track_membership_status_change()
        RETURNS TRIGGER AS $$
        BEGIN
          IF OLD.membership_status IS DISTINCT FROM NEW.membership_status THEN
            NEW.last_modified_at = NOW();
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await db.execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_membership_status_change') THEN
            CREATE TRIGGER trg_membership_status_change
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION trg_track_membership_status_change();
          END IF;
        END $$
      `);
      logger.info('[DB Init] Membership status change tracking trigger created');
    } catch (err: unknown) { logger.debug('[DB Init] Membership status change trigger already exists or failed: ' + getErrorMessage(err)); }

    try {
      const backfillResult = await db.execute(sql`
        UPDATE users
        SET last_modified_at = updated_at
        WHERE membership_status IN ('terminated', 'expired', 'suspended', 'inactive', 'cancelled', 'canceled', 'frozen', 'froze', 'declined', 'churned', 'former_member', 'deleted')
          AND last_modified_at IS NULL
          AND updated_at IS NOT NULL
      `);
      const backfilled = backfillResult.rowCount || 0;
      if (backfilled > 0) {
        logger.info(`[DB Init] Backfilled last_modified_at for ${backfilled} former members from updated_at`);
      }
    } catch (err: unknown) { logger.debug('[DB Init] last_modified_at backfill failed: ' + getErrorMessage(err)); }

    try { await db.execute(sql`ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS wallet_pass_bg_color VARCHAR`); } catch { logger.debug('[DB Init] wallet_pass_bg_color column already exists or failed'); }
    try { await db.execute(sql`ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS wallet_pass_foreground_color VARCHAR`); } catch { logger.debug('[DB Init] wallet_pass_foreground_color column already exists or failed'); }
    try { await db.execute(sql`ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS wallet_pass_label_color VARCHAR`); } catch { logger.debug('[DB Init] wallet_pass_label_color column already exists or failed'); }
    logger.info('[DB Init] Wallet pass color columns verified');

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
          ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
            CHECK (type IN (
              'info', 'success', 'warning', 'error', 'system',
              'booking', 'booking_approved', 'booking_declined', 'booking_reminder',
              'booking_cancelled', 'booking_cancelled_by_staff', 'booking_cancelled_via_trackman',
              'booking_invite', 'booking_update', 'booking_updated', 'booking_confirmed',
              'booking_auto_confirmed', 'booking_checked_in', 'booking_created',
              'booking_participant_added', 'booking_request',
              'closure', 'closure_today', 'closure_created',
              'wellness_booking', 'wellness_enrollment', 'wellness_cancellation',
              'wellness_reminder', 'wellness_class', 'wellness',
              'guest_pass',
              'event', 'event_rsvp', 'event_rsvp_cancelled', 'event_reminder',
              'tour', 'tour_scheduled', 'tour_reminder',
              'trackman_booking', 'trackman_unmatched', 'trackman_cancelled_link',
              'announcement',
              'payment_method_update', 'payment_success', 'payment_failed',
              'payment_receipt', 'payment_error',
              'outstanding_balance', 'fee_waived',
              'membership_renewed', 'membership_failed', 'membership_past_due',
              'membership_cancelled', 'membership_terminated', 'membership_cancellation',
              'billing', 'billing_alert', 'billing_migration',
              'day_pass', 'new_member', 'member_status_change',
              'card_expiring', 'staff_note', 'account_deletion',
              'terminal_refund', 'terminal_dispute', 'terminal_dispute_closed',
              'terminal_payment_canceled',
              'funds_added', 'trial_expired',
              'waiver_review', 'cancellation_pending', 'cancellation_stuck',
              'bug_report', 'import_failure', 'integration_error', 'attendance'
            ));
        END $$;
      `);
      logger.info('[DB Init] Notification type CHECK constraint synced');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping notification type CHECK constraint: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_time_order_check'
          ) THEN
            ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_time_order_check
              CHECK (end_time > start_time OR (start_time >= '20:00:00' AND end_time <= '06:00:00'));
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Booking time order CHECK constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping booking time order CHECK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'booking_sessions_time_order_check'
          ) THEN
            ALTER TABLE booking_sessions ADD CONSTRAINT booking_sessions_time_order_check
              CHECK (end_time > start_time OR (start_time >= '20:00:00' AND end_time <= '06:00:00'));
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Session time order CHECK constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping session time order CHECK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'users_active_email_check'
          ) THEN
            ALTER TABLE users ADD CONSTRAINT users_active_email_check
              CHECK (
                membership_status IN ('terminated', 'cancelled', 'deleted', 'former_member')
                OR email IS NOT NULL
              );
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Active member email CHECK constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping active email CHECK: ${getErrorMessage(err)}`);
    }

    if (process.env.NODE_ENV === 'production') {
      try {
        await db.execute(sql`
          UPDATE users SET stripe_customer_id = NULL
          WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY stripe_customer_id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) AS rn
              FROM users
              WHERE stripe_customer_id IS NOT NULL
            ) dupes
            WHERE rn > 1
          )
        `);
        await db.execute(sql`
          CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_unique
            ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL
        `);
        logger.info('[DB Init] Stripe customer ID unique index created/verified');
      } catch (err: unknown) {
        logger.warn(`[DB Init] Skipping Stripe customer unique index: ${getErrorMessage(err)}`);
      }

    }

    try {
      await db.execute(sql`UPDATE users SET hubspot_id = NULL WHERE hubspot_id IS NOT NULL AND TRIM(hubspot_id) = ''`);
      await db.execute(sql`UPDATE users SET hubspot_id = TRIM(hubspot_id) WHERE hubspot_id IS NOT NULL AND hubspot_id != TRIM(hubspot_id)`);
      await db.execute(sql`
        UPDATE users SET hubspot_id = NULL
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY hubspot_id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC) AS rn
            FROM users
            WHERE hubspot_id IS NOT NULL AND hubspot_id != ''
          ) dupes
          WHERE rn > 1
        )
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS users_hubspot_id_unique
          ON users (hubspot_id) WHERE hubspot_id IS NOT NULL AND hubspot_id != ''
      `);
      logger.info('[DB Init] HubSpot ID unique index created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping HubSpot ID unique index: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE booking_fee_snapshots
            DROP CONSTRAINT IF EXISTS booking_fee_snapshots_booking_id_fkey;
          ALTER TABLE booking_fee_snapshots
            ADD CONSTRAINT booking_fee_snapshots_booking_id_fkey
            FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;

          ALTER TABLE booking_fee_snapshots
            DROP CONSTRAINT IF EXISTS booking_fee_snapshots_session_id_fkey;
          ALTER TABLE booking_fee_snapshots
            ADD CONSTRAINT booking_fee_snapshots_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES booking_sessions(id) ON DELETE CASCADE;
        END $$;
      `);
      logger.info('[DB Init] Fee snapshot CASCADE constraints created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping fee snapshot CASCADE: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE guest_pass_holds
            DROP CONSTRAINT IF EXISTS guest_pass_holds_booking_id_fkey;
          ALTER TABLE guest_pass_holds
            ADD CONSTRAINT guest_pass_holds_booking_id_fkey
            FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;

          ALTER TABLE conference_prepayments
            DROP CONSTRAINT IF EXISTS conference_prepayments_booking_id_fkey;
          ALTER TABLE conference_prepayments
            ADD CONSTRAINT conference_prepayments_booking_id_fkey
            FOREIGN KEY (booking_id) REFERENCES booking_requests(id) ON DELETE CASCADE;
        END $$;
      `);
      logger.info('[DB Init] Guest pass holds & conference prepayments CASCADE constraints created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping guest pass/conference CASCADE: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes WHERE indexname = 'day_pass_purchases_stripe_pi_unique'
          ) THEN
            CREATE UNIQUE INDEX day_pass_purchases_stripe_pi_unique
              ON day_pass_purchases (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Day pass payment intent unique index created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping day pass PI unique index: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes WHERE indexname = 'wellness_enrollments_unique_active'
          ) THEN
            CREATE UNIQUE INDEX wellness_enrollments_unique_active
              ON wellness_enrollments (class_id, user_email) WHERE status = 'confirmed';
          END IF;
        END $$;
      `);
      logger.info('[DB Init] Wellness enrollment unique active index created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping wellness enrollment unique index: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DROP INDEX IF EXISTS hubspot_sync_queue_idempotency_idx;
        CREATE UNIQUE INDEX hubspot_sync_queue_idempotency_idx 
          ON hubspot_sync_queue (idempotency_key) 
          WHERE idempotency_key IS NOT NULL AND status NOT IN ('completed', 'superseded');
      `);
      logger.info('[DB Init] HubSpot queue idempotency index updated for superseded status');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping HubSpot queue idempotency index update: ${getErrorMessage(err)}`);
    }

    const indexQueries = [
      { name: 'idx_booking_requests_status', query: sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(status)` },
      { name: 'idx_booking_requests_user_email', query: sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_user_email ON booking_requests(user_email)` },
      { name: 'idx_booking_requests_resource_date', query: sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_resource_date ON booking_requests(resource_id, start_time)` },
      { name: 'idx_booking_requests_start_time', query: sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_start_time ON booking_requests(start_time)` },
      { name: 'idx_availability_blocks_resource_date', query: sql`CREATE INDEX IF NOT EXISTS idx_availability_blocks_resource_date ON availability_blocks(resource_id, block_date)` },
      { name: 'idx_trackman_unmatched_resolved', query: sql`CREATE INDEX IF NOT EXISTS idx_trackman_unmatched_resolved ON trackman_unmatched_bookings(resolved_at)` },
      { name: 'idx_events_event_date', query: sql`CREATE INDEX IF NOT EXISTS idx_events_event_date ON events(event_date)` },
      { name: 'idx_notifications_user_read', query: sql`CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_email, is_read)` },
      { name: 'idx_users_email_lower', query: sql`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email))` },
      { name: 'idx_users_membership_status', query: sql`CREATE INDEX IF NOT EXISTS idx_users_membership_status ON users(membership_status)` },
      { name: 'idx_booking_participants_session_id', query: sql`CREATE INDEX IF NOT EXISTS idx_booking_participants_session_id ON booking_participants(session_id)` },
      { name: 'idx_stripe_payment_intents_booking_id', query: sql`CREATE INDEX IF NOT EXISTS idx_stripe_payment_intents_booking_id ON stripe_payment_intents(booking_id)` },
      { name: 'idx_usage_ledger_member_id', query: sql`CREATE INDEX IF NOT EXISTS idx_usage_ledger_member_id ON usage_ledger(member_id)` },
      { name: 'idx_admin_audit_log_created', query: sql`CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at)` },
      { name: 'idx_webhook_processed_events_type', query: sql`CREATE INDEX IF NOT EXISTS idx_webhook_processed_events_type ON webhook_processed_events(event_type)` },
      { name: 'idx_communication_logs_email', query: sql`CREATE INDEX IF NOT EXISTS idx_communication_logs_email ON communication_logs(member_email)` },
      { name: 'idx_guest_check_ins_email', query: sql`CREATE INDEX IF NOT EXISTS idx_guest_check_ins_email ON guest_check_ins(member_email)` },
    ];
    
    for (const { name, query } of indexQueries) {
      try {
        await db.execute(query);
      } catch (err: unknown) {
        logger.warn(`[DB Init] Skipping index ${name}: ${getErrorMessage(err)}`);
      }
    }
    
    logger.info('[DB Init] Performance indexes processed');

    try {
      const needsFix = await db.execute(sql`
        SELECT id, stripe_customer_id FROM users 
        WHERE LOWER(email) = 'nick@evenhouse.club' 
          AND stripe_customer_id IS NOT NULL
        LIMIT 1
      `);
      if (needsFix.rows.length > 0) {
        const savedCustomerId = (needsFix.rows[0] as { stripe_customer_id: string }).stripe_customer_id;
        await db.execute(sql`
          UPDATE users 
          SET stripe_customer_id = NULL,
              stripe_subscription_id = NULL,
              membership_tier = NULL,
              membership_status = 'non-member',
              updated_at = NOW()
          WHERE LOWER(email) = 'nick@evenhouse.club'
        `);
        await db.execute(sql`
          UPDATE users 
          SET stripe_customer_id = ${savedCustomerId},
              membership_tier = 'VIP',
              membership_status = 'active',
              billing_provider = 'stripe',
              updated_at = NOW()
          WHERE LOWER(email) = 'nicholasallanluu@gmail.com'
        `);
        logger.info('[DB Init] Moved Stripe customer from nick@evenhouse.club to nicholasallanluu@gmail.com');

        try {
          const { getStripeClient } = await import('./core/stripe/client');
          const stripe = await getStripeClient();
          await stripe.customers.update(savedCustomerId, { email: 'nicholasallanluu@gmail.com' });
          logger.info('[DB Init] Updated Stripe customer email to nicholasallanluu@gmail.com');
        } catch (stripeErr: unknown) {
          logger.error('[DB Init] Stripe customer email update failed (update manually in Stripe dashboard):', { extra: { errorMessage: getErrorMessage(stripeErr) } });
        }
      }
    } catch (fixErr: unknown) {
      logger.error('[DB Init] Stripe customer reassignment failed:', { extra: { errorMessage: getErrorMessage(fixErr) } });
    }
    try {
      await db.execute(sql`
        DELETE FROM guest_passes gp
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(gp.member_email))
      `);
      await db.execute(sql`
        UPDATE guest_passes SET member_email = LOWER(TRIM(member_email))
        WHERE member_email IS NOT NULL AND member_email != LOWER(TRIM(member_email))
      `);
      logger.info('[DB Init] Legacy guest pass data cleaned up');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Guest pass legacy cleanup: ${getErrorMessage(err)}`);
    }

    try {
      const emailOrphanCleanup = await db.execute(sql`
        WITH deleted_notifications AS (
          DELETE FROM notifications n
          WHERE n.user_email IS NOT NULL AND n.user_email != ''
            AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(n.user_email))
          RETURNING 1
        ),
        deleted_push AS (
          DELETE FROM push_subscriptions ps
          WHERE ps.user_email IS NOT NULL AND ps.user_email != ''
            AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(ps.user_email))
          RETURNING 1
        ),
        deleted_dismissed AS (
          DELETE FROM user_dismissed_notices udn
          WHERE udn.user_email IS NOT NULL AND udn.user_email != ''
            AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(udn.user_email))
          RETURNING 1
        ),
        deleted_rsvps AS (
          DELETE FROM event_rsvps er
          WHERE er.user_email IS NOT NULL AND er.user_email != ''
            AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(er.user_email))
          RETURNING 1
        ),
        deleted_wellness AS (
          DELETE FROM wellness_enrollments we
          WHERE we.user_email IS NOT NULL AND we.user_email != ''
            AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(we.user_email))
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*) FROM deleted_notifications) AS notifs,
          (SELECT COUNT(*) FROM deleted_push) AS push,
          (SELECT COUNT(*) FROM deleted_dismissed) AS dismissed,
          (SELECT COUNT(*) FROM deleted_rsvps) AS rsvps,
          (SELECT COUNT(*) FROM deleted_wellness) AS wellness
      `);
      const row = emailOrphanCleanup.rows[0] as Record<string, string>;
      const total = ['notifs', 'push', 'dismissed', 'rsvps', 'wellness'].reduce((sum, k) => sum + parseInt(row[k] || '0'), 0);
      if (total > 0) {
        logger.info(`[DB Init] Cleaned ${total} email-orphan records across dependent tables`, { extra: row });
      }
    } catch (err: unknown) {
      logger.warn(`[DB Init] Email orphan cleanup: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        UPDATE usage_ledger SET member_id = NULL
        WHERE member_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = member_id)
      `);
      logger.info('[DB Init] Legacy usage_ledger orphan member_id references cleaned up');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Usage ledger legacy cleanup: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        UPDATE trackman_webhook_events SET matched_booking_id = NULL
        WHERE matched_booking_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM booking_requests br WHERE br.id = matched_booking_id)
      `);
      logger.info('[DB Init] Legacy trackman webhook orphan booking references cleaned up');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Trackman webhook legacy cleanup: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        UPDATE booking_requests SET session_id = NULL
        WHERE session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM booking_sessions bs WHERE bs.id = session_id)
      `);
      logger.info('[DB Init] Legacy booking_requests orphan session_id references cleaned up');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Booking requests session cleanup: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        UPDATE booking_requests SET closure_id = NULL
        WHERE closure_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM facility_closures fc WHERE fc.id = closure_id)
      `);
      logger.info('[DB Init] Legacy booking_requests orphan closure_id references cleaned up');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Booking requests closure cleanup: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE booking_requests
            DROP CONSTRAINT IF EXISTS booking_requests_session_id_fkey;
          ALTER TABLE booking_requests
            ADD CONSTRAINT booking_requests_session_id_fkey
            FOREIGN KEY (session_id) REFERENCES booking_sessions(id) ON DELETE SET NULL;
        END $$;
      `);
      logger.info('[DB Init] FK: booking_requests.session_id → booking_sessions.id created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping booking_requests.session_id FK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE booking_requests
            DROP CONSTRAINT IF EXISTS booking_requests_closure_id_fkey;
          ALTER TABLE booking_requests
            ADD CONSTRAINT booking_requests_closure_id_fkey
            FOREIGN KEY (closure_id) REFERENCES facility_closures(id) ON DELETE SET NULL;
        END $$;
      `);
      logger.info('[DB Init] FK: booking_requests.closure_id → facility_closures.id created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping booking_requests.closure_id FK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE usage_ledger
            DROP CONSTRAINT IF EXISTS usage_ledger_member_id_fkey;
          ALTER TABLE usage_ledger
            ADD CONSTRAINT usage_ledger_member_id_fkey
            FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE SET NULL;
        END $$;
      `);
      logger.info('[DB Init] FK: usage_ledger.member_id → users.id created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping usage_ledger.member_id FK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE trackman_webhook_events
            DROP CONSTRAINT IF EXISTS trackman_webhook_events_matched_booking_id_fkey;
          ALTER TABLE trackman_webhook_events
            ADD CONSTRAINT trackman_webhook_events_matched_booking_id_fkey
            FOREIGN KEY (matched_booking_id) REFERENCES booking_requests(id) ON DELETE SET NULL;
        END $$;
      `);
      logger.info('[DB Init] FK: trackman_webhook_events.matched_booking_id → booking_requests.id created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping trackman_webhook_events.matched_booking_id FK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          ALTER TABLE booking_wallet_passes
            DROP CONSTRAINT IF EXISTS booking_wallet_passes_member_id_fkey;
          ALTER TABLE booking_wallet_passes
            ADD CONSTRAINT booking_wallet_passes_member_id_fkey
            FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE;
        END $$;
      `);
      logger.info('[DB Init] FK: booking_wallet_passes.member_id → users.id created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping booking_wallet_passes.member_id FK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'users_membership_status_lowercase_check'
          ) THEN
            ALTER TABLE users ADD CONSTRAINT users_membership_status_lowercase_check
              CHECK (membership_status = LOWER(membership_status));
          END IF;
        END $$;
      `);
      logger.info('[DB Init] CHECK: users.membership_status lowercase constraint created/verified');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping membership_status lowercase CHECK: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION cascade_user_email_delete()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        BEGIN
          DELETE FROM public.notifications WHERE LOWER(user_email) = LOWER(OLD.email);
          DELETE FROM public.push_subscriptions WHERE LOWER(user_email) = LOWER(OLD.email);
          DELETE FROM public.guest_passes WHERE LOWER(member_email) = LOWER(OLD.email);
          DELETE FROM public.member_notes WHERE LOWER(member_email) = LOWER(OLD.email);
          DELETE FROM public.event_rsvps WHERE LOWER(user_email) = LOWER(OLD.email);
          DELETE FROM public.wellness_enrollments WHERE LOWER(user_email) = LOWER(OLD.email);
          DELETE FROM public.user_dismissed_notices WHERE LOWER(user_email) = LOWER(OLD.email);
          RETURN OLD;
        END;
        $$;

        DROP TRIGGER IF EXISTS trg_cascade_user_email_delete ON users;
        CREATE TRIGGER trg_cascade_user_email_delete
        BEFORE DELETE ON users
        FOR EACH ROW
        EXECUTE FUNCTION cascade_user_email_delete();

        CREATE OR REPLACE FUNCTION cascade_user_email_update()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        BEGIN
          IF LOWER(OLD.email) IS DISTINCT FROM LOWER(NEW.email) THEN
            UPDATE public.notifications SET user_email = NEW.email WHERE LOWER(user_email) = LOWER(OLD.email);
            UPDATE public.push_subscriptions SET user_email = NEW.email WHERE LOWER(user_email) = LOWER(OLD.email);
            UPDATE public.guest_passes SET member_email = NEW.email WHERE LOWER(member_email) = LOWER(OLD.email);
            UPDATE public.member_notes SET member_email = NEW.email WHERE LOWER(member_email) = LOWER(OLD.email);
            UPDATE public.event_rsvps SET user_email = NEW.email WHERE LOWER(user_email) = LOWER(OLD.email);
            UPDATE public.wellness_enrollments SET user_email = NEW.email WHERE LOWER(user_email) = LOWER(OLD.email);
            UPDATE public.user_dismissed_notices SET user_email = NEW.email WHERE LOWER(user_email) = LOWER(OLD.email);
          END IF;
          RETURN NEW;
        END;
        $$;

        DROP TRIGGER IF EXISTS trg_cascade_user_email_update ON users;
        CREATE TRIGGER trg_cascade_user_email_update
        AFTER UPDATE OF email ON users
        FOR EACH ROW
        EXECUTE FUNCTION cascade_user_email_update();
      `);
      logger.info('[DB Init] Triggers: cascade_user_email_delete + cascade_user_email_update created');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping cascade email triggers: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION validate_email_exists_in_users()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        DECLARE
          email_col TEXT;
          email_val TEXT;
        BEGIN
          IF TG_TABLE_NAME IN ('notifications', 'push_subscriptions', 'event_rsvps', 'wellness_enrollments', 'user_dismissed_notices') THEN
            email_val := NEW.user_email;
          ELSIF TG_TABLE_NAME IN ('member_notes') THEN
            email_val := NEW.member_email;
          ELSE
            RETURN NEW;
          END IF;
          IF email_val IS NULL OR email_val = '' THEN
            RETURN NEW;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM public.users WHERE LOWER(email) = LOWER(email_val)) THEN
            RAISE EXCEPTION 'Email "%" in % does not match any user — orphan record rejected', email_val, TG_TABLE_NAME;
          END IF;
          RETURN NEW;
        END;
        $$;
      `);

      const emailTables = [
        { table: 'notifications', col: 'user_email' },
        { table: 'push_subscriptions', col: 'user_email' },
        { table: 'event_rsvps', col: 'user_email' },
        { table: 'wellness_enrollments', col: 'user_email' },
        { table: 'user_dismissed_notices', col: 'user_email' },
        { table: 'member_notes', col: 'member_email' },
      ];

      for (const { table, col } of emailTables) {
        const triggerName = `trg_validate_email_${table}`;
        await db.execute(sql.raw(`
          DROP TRIGGER IF EXISTS ${triggerName} ON ${table};
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT OR UPDATE OF ${col} ON ${table}
          FOR EACH ROW
          EXECUTE FUNCTION validate_email_exists_in_users();
        `));
      }

      logger.info('[DB Init] Email validation triggers created on 6 dependent tables (prevents orphan inserts)');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping email validation triggers: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION validate_guest_pass_member()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        SET search_path = ''
        AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM public.users WHERE LOWER(email) = LOWER(NEW.member_email)) THEN
            RAISE EXCEPTION 'Guest pass member_email "%" does not match any user', NEW.member_email;
          END IF;
          RETURN NEW;
        END;
        $$;

        DROP TRIGGER IF EXISTS trg_validate_guest_pass_member ON guest_passes;
        CREATE TRIGGER trg_validate_guest_pass_member
        BEFORE INSERT OR UPDATE OF member_email ON guest_passes
        FOR EACH ROW
        EXECUTE FUNCTION validate_guest_pass_member();
      `);
      logger.info('[DB Init] Trigger: validate_guest_pass_member created (prevents orphan guest passes)');
    } catch (err: unknown) {
      logger.warn(`[DB Init] Skipping validate_guest_pass_member trigger: ${getErrorMessage(err)}`);
    }

    logger.info('[DB Init] Data integrity hardening constraints applied');
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to ensure constraints:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function verifyIntegrityConstraints(): Promise<{ verified: boolean; missing: string[] }> {
  const requiredConstraints = [
    { name: 'booking_requests_time_order_check', type: 'constraint', justifies: 'Booking Time Validity check elimination' },
    { name: 'booking_sessions_time_order_check', type: 'constraint', justifies: 'Booking Time Validity check elimination' },
    { name: 'users_active_email_check', type: 'constraint', justifies: 'Members Without Email check elimination' },
    { name: 'users_hubspot_id_unique', type: 'index', justifies: 'HubSpot ID Duplicates check elimination' },
    { name: 'users_membership_status_lowercase_check', type: 'constraint', justifies: 'Status normalization auto-fix retirement' },
  ];

  const requiredTriggers = [
    { name: 'trg_validate_guest_pass_member', justifies: 'Guest Passes Without Members check elimination' },
    { name: 'trg_cascade_user_email_delete', justifies: 'Email Cascade Orphans check elimination (delete cascade)' },
    { name: 'trg_cascade_user_email_update', justifies: 'Email Cascade Orphans check elimination (update cascade)' },
    { name: 'trg_validate_email_notifications', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'trg_validate_email_push_subscriptions', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'trg_validate_email_event_rsvps', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'trg_validate_email_wellness_enrollments', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'trg_validate_email_user_dismissed_notices', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'trg_validate_email_member_notes', justifies: 'Email Cascade Orphans check elimination (insert validation)' },
    { name: 'check_booking_session_overlap', justifies: 'Overlapping Bookings check downgrade' },
    { name: 'trg_auto_billing_provider', justifies: 'Billing Provider Hybrid State check downgrade' },
    { name: 'trg_link_participant_user_id', justifies: 'Sessions Without Participants check downgrade' },
  ];

  const requiredFKs = [
    { table: 'booking_participants', column: 'user_id', justifies: 'Participant User Relationships check elimination' },
    { table: 'booking_requests', column: 'session_id', justifies: 'Booking session FK integrity' },
    { table: 'booking_requests', column: 'closure_id', justifies: 'Booking closure FK integrity' },
    { table: 'usage_ledger', column: 'member_id', justifies: 'Usage ledger member FK integrity' },
    { table: 'trackman_webhook_events', column: 'matched_booking_id', justifies: 'Trackman webhook booking FK integrity' },
    { table: 'booking_wallet_passes', column: 'member_id', justifies: 'Wallet pass member FK integrity' },
  ];

  const missing: string[] = [];

  try {
    for (const c of requiredConstraints) {
      const result = await db.execute(sql`
        SELECT 1 FROM pg_constraint WHERE conname = ${c.name}
        UNION ALL
        SELECT 1 FROM pg_indexes WHERE indexname = ${c.name}
        LIMIT 1
      `);
      if (result.rows.length === 0) {
        missing.push(`${c.name} (${c.justifies})`);
      }
    }

    for (const t of requiredTriggers) {
      const result = await db.execute(sql`
        SELECT 1 FROM pg_trigger WHERE tgname = ${t.name} LIMIT 1
      `);
      if (result.rows.length === 0) {
        missing.push(`trigger:${t.name} (${t.justifies})`);
      }
    }

    for (const fk of requiredFKs) {
      const result = await db.execute(sql`
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON c.conrelid = r.oid
        JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = ANY(c.conkey)
        WHERE r.relname = ${fk.table} AND a.attname = ${fk.column} AND c.contype = 'f'
        LIMIT 1
      `);
      if (result.rows.length === 0) {
        missing.push(`fk:${fk.table}.${fk.column} (${fk.justifies})`);
      }
    }

    if (missing.length > 0) {
      logger.error('[DB Init] INTEGRITY CONSTRAINT VERIFICATION FAILED — missing protections:', { extra: { missing } });
    } else {
      logger.info('[DB Init] All integrity constraints verified — 6 eliminated checks are safely backed by DB-level enforcement');
    }

    return { verified: missing.length === 0, missing };
  } catch (error: unknown) {
    logger.error('[DB Init] Constraint verification query failed:', { extra: { errorMessage: getErrorMessage(error) } });
    return { verified: false, missing: ['verification query failed'] };
  }
}

export async function validateTierHierarchy(): Promise<void> {
  try {
    const { TIER_NAMES } = await import('../shared/constants/tiers');
    const codeSlugs = new Set(TIER_NAMES.map(t => t.toLowerCase()));
    const dbTiers = await db.execute(sql`SELECT DISTINCT slug FROM membership_tiers WHERE is_active = true`);
    const allDbSlugs = dbTiers.rows.map((r: Record<string, unknown>) => (r.slug as string)?.toLowerCase()).filter(Boolean);
    const dbMembershipSlugs = new Set(allDbSlugs.filter(s => codeSlugs.has(s)));
    
    const inCodeNotDb = [...codeSlugs].filter(s => !dbMembershipSlugs.has(s));
    
    if (inCodeNotDb.length > 0) {
      logger.warn(`[DB Init] Tier drift detected: Code constants have tiers not in DB: ${inCodeNotDb.join(', ')}`);
    } else {
      logger.info('[DB Init] Tier hierarchy validated — all code tier constants found in DB');
    }
  } catch (error: unknown) {
    logger.error('[DB Init] Tier hierarchy validation failed:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function seedTierFeatures(): Promise<void> {
  try {
    const existing = await db.execute(sql`SELECT COUNT(*) FROM tier_features`);
    if (parseInt(existing.rows[0].count as string) > 0) {
      logger.info('[DB Init] Tier features already seeded, skipping');
      return;
    }

    const features = [
      { key: 'daily_golf_time', label: 'Daily Golf Time', type: 'text' },
      { key: 'guest_passes', label: 'Guest Passes', type: 'text' },
      { key: 'booking_window', label: 'Booking Window', type: 'text' },
      { key: 'cafe_bar_access', label: 'Cafe & Bar Access', type: 'boolean' },
      { key: 'lounge_access', label: 'Lounge Access', type: 'boolean' },
      { key: 'work_desks', label: 'Work Desks', type: 'boolean' },
      { key: 'golf_simulators', label: 'Golf Simulators', type: 'boolean' },
      { key: 'putting_green', label: 'Putting Green', type: 'boolean' },
      { key: 'member_events', label: 'Member Events', type: 'boolean' },
      { key: 'conference_room', label: 'Conference Room', type: 'text' },
      { key: 'group_lessons', label: 'Group Lessons', type: 'boolean' },
      { key: 'extended_sessions', label: 'Extended Sessions', type: 'boolean' },
      { key: 'private_lessons', label: 'Private Lessons', type: 'boolean' },
      { key: 'sim_guest_passes', label: 'Sim Guest Passes', type: 'boolean' },
      { key: 'discounted_merch', label: 'Discounted Merch', type: 'boolean' },
    ];

    const tiersResult = await db.execute(sql`SELECT id FROM membership_tiers`);
    const tierIds = tiersResult.rows.map((r: Record<string, unknown>) => r.id);

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const featureResult = await db.execute(sql`
        INSERT INTO tier_features (feature_key, display_label, value_type, sort_order, is_active)
        VALUES (${f.key}, ${f.label}, ${f.type}, ${i}, true)
        RETURNING id
      `);
      const featureId = featureResult.rows[0].id;

      for (const tierId of tierIds) {
        const defaultBoolean = f.type === 'boolean' ? false : null;
        const defaultText = f.type === 'text' ? '' : null;
        await db.execute(sql`
          INSERT INTO tier_feature_values (feature_id, tier_id, value_boolean, value_number, value_text)
          VALUES (${featureId}, ${tierId}, ${defaultBoolean}, NULL, ${defaultText})
        `);
      }
    }

    logger.info(`[DB Init] Seeded ${features.length} tier features with values for ${tierIds.length} tiers`);
  } catch (error: unknown) {
    logger.error('[DB Init] Failed to seed tier features:', { extra: { errorMessage: getErrorMessage(error) } });
  }
}

export async function setupInstantDataTriggers(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION auto_set_billing_provider()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        IF NEW.billing_provider IS NULL OR NEW.billing_provider = '' THEN
          NEW.billing_provider := 'stripe';
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_auto_billing_provider ON users;
      CREATE TRIGGER trg_auto_billing_provider
      BEFORE INSERT OR UPDATE OF stripe_subscription_id, mindbody_client_id, billing_provider ON users
      FOR EACH ROW
      EXECUTE FUNCTION auto_set_billing_provider();
    `);
    logger.info('[DB Init] Trigger: auto_set_billing_provider created');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping auto_set_billing_provider trigger: ${getErrorMessage(err)}`);
  }

  try {
    await db.execute(sql`
      DROP TRIGGER IF EXISTS trg_copy_tier_on_link ON user_linked_emails;
      DROP FUNCTION IF EXISTS auto_copy_tier_on_link();
    `);
    logger.info('[DB Init] Removed legacy trg_copy_tier_on_link trigger (linked users should be merged, not given separate tiers)');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping trg_copy_tier_on_link cleanup: ${getErrorMessage(err)}`);
  }

  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION auto_sync_staff_role()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        IF NEW.is_active = true THEN
          UPDATE public.users
          SET role = NEW.role, tier = 'VIP', membership_status = 'active', updated_at = NOW()
          WHERE LOWER(email) = LOWER(NEW.email)
            AND role NOT IN ('admin', 'staff', 'golf_instructor');
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_sync_staff_role ON staff_users;
      CREATE TRIGGER trg_sync_staff_role
      AFTER INSERT OR UPDATE OF is_active, role ON staff_users
      FOR EACH ROW
      EXECUTE FUNCTION auto_sync_staff_role();
    `);
    logger.info('[DB Init] Trigger: auto_sync_staff_role created');

    const orphanedResult = await db.execute(sql`
      UPDATE users SET role = CASE
          WHEN LOWER(membership_status) IN ('active', 'trialing', 'past_due', 'pending') THEN 'member'
          WHEN LOWER(membership_status) IN ('visitor', 'non-member') THEN 'visitor'
          ELSE role
        END,
        membership_status = LOWER(membership_status),
        updated_at = NOW()
      WHERE role = 'staff'
        AND LOWER(email) NOT IN (
          SELECT LOWER(email) FROM staff_users WHERE is_active = true
        )
        AND role != 'admin'
      RETURNING email, membership_status
    `);
    if (orphanedResult.rows.length > 0) {
      logger.info(`[DB Init] Fixed ${orphanedResult.rows.length} orphaned staff roles`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extra: { emails: orphanedResult.rows.map((r: any) => r.email) }
      });
    }
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping auto_sync_staff_role trigger: ${getErrorMessage(err)}`);
  }

  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION auto_link_participant_user_id()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      DECLARE
        found_user_id TEXT;
      BEGIN
        IF NEW.user_id IS NULL AND NEW.participant_type = 'owner' AND NEW.session_id IS NOT NULL THEN
          SELECT u.id INTO found_user_id
          FROM public.booking_requests br
          JOIN public.users u ON LOWER(u.email) = LOWER(br.user_email)
          WHERE br.session_id = NEW.session_id
          ORDER BY br.created_at DESC
          LIMIT 1;

          IF found_user_id IS NOT NULL THEN
            NEW.user_id := found_user_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_link_participant_user_id ON booking_participants;
      CREATE TRIGGER trg_link_participant_user_id
      BEFORE INSERT ON booking_participants
      FOR EACH ROW
      EXECUTE FUNCTION auto_link_participant_user_id();
    `);
    logger.info('[DB Init] Trigger: auto_link_participant_user_id created');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping auto_link_participant_user_id trigger: ${getErrorMessage(err)}`);
  }

  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION auto_clear_unmatched_on_terminal()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = ''
      AS $$
      BEGIN
        IF NEW.is_unmatched = true AND NEW.status IN ('cancelled', 'declined', 'deleted', 'attended', 'no_show', 'expired') THEN
          NEW.is_unmatched := false;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_clear_unmatched_on_terminal ON booking_requests;
      CREATE TRIGGER trg_clear_unmatched_on_terminal
        BEFORE INSERT OR UPDATE ON booking_requests
        FOR EACH ROW
        EXECUTE FUNCTION auto_clear_unmatched_on_terminal();
    `);
    logger.info('[DB Init] Trigger: auto_clear_unmatched_on_terminal created');
  } catch (err: unknown) {
    logger.warn(`[DB Init] Skipping auto_clear_unmatched_on_terminal trigger: ${getErrorMessage(err)}`);
  }

  logger.info('[DB Init] Instant data triggers created');
}
