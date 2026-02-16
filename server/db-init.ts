import { sql } from 'drizzle-orm';
import { db } from './db';
import { getErrorMessage } from './utils/errorUtils';

export async function setupEmailNormalization(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION normalize_email()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Normalize user_email column for tables that have it
        IF TG_TABLE_NAME IN ('booking_requests', 'notifications', 'push_subscriptions') THEN
          IF NEW.user_email IS NOT NULL THEN
            NEW.user_email := LOWER(TRIM(NEW.user_email));
          END IF;
        END IF;
        
        -- Normalize email column only for users table
        IF TG_TABLE_NAME = 'users' THEN
          IF NEW.email IS NOT NULL THEN
            NEW.email := LOWER(TRIM(NEW.email));
          END IF;
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
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
        console.warn(`[DB Init] Skipping email trigger on ${table}: ${getErrorMessage(err)}`);
      }
    }

    console.log('[DB Init] Email normalization triggers created');
  } catch (error: unknown) {
    console.error('[DB Init] Failed to create email normalization triggers:', getErrorMessage(error));
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

    console.log(`[DB Init] Normalized ${totalUpdated} email records`);
  } catch (error: unknown) {
    console.error('[DB Init] Failed to normalize existing emails:', getErrorMessage(error));
  }
  
  return { updated: totalUpdated };
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
    console.log(`[DB Init] Cleaned up ${notificationsDeleted} orphaned notifications (older than 30 days)`);

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
    console.log(`[DB Init] Marked ${oldBookingsArchived} orphaned old booking records`);
  } catch (error: unknown) {
    console.error('[DB Init] Failed to cleanup orphaned records:', getErrorMessage(error));
  }
  
  return { notifications: notificationsDeleted, oldBookings: oldBookingsArchived };
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
    
    console.log('[DB Init] stripe_transaction_cache table created/verified');
  } catch (error: unknown) {
    console.error('[DB Init] Failed to create stripe_transaction_cache:', getErrorMessage(error));
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
    console.log('[DB Init] Default notice types seeded');
  } catch (error: unknown) {
    console.error('[DB Init] Failed to seed notice types:', getErrorMessage(error));
  }
}

export async function ensureDatabaseConstraints() {
  try {
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
          CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'attended', 'no_show'));

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
    
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'booking_requests' AND column_name = 'reschedule_booking_id'
        ) THEN
          ALTER TABLE booking_requests ADD COLUMN reschedule_booking_id INTEGER;
        END IF;
      END $$;
    `);
    
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'booking_guests' AND column_name = 'guest_phone'
        ) THEN
          ALTER TABLE booking_guests ADD COLUMN guest_phone VARCHAR(50);
        END IF;
      END $$;
    `);

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION prevent_booking_session_overlap()
        RETURNS TRIGGER AS $$
        DECLARE
          conflict_count INTEGER;
        BEGIN
          SELECT COUNT(*) INTO conflict_count
          FROM booking_sessions
          WHERE resource_id = NEW.resource_id
            AND session_date = NEW.session_date
            AND id != COALESCE(NEW.id, 0)
            AND tsrange(
              (session_date + start_time)::timestamp,
              (session_date + end_time)::timestamp,
              '[)'
            ) && tsrange(
              (NEW.session_date + NEW.start_time)::timestamp,
              (NEW.session_date + NEW.end_time)::timestamp,
              '[)'
            );
          
          IF conflict_count > 0 THEN
            RAISE EXCEPTION 'Double-booking not allowed: This time slot on this bay already has a session';
          END IF;
          
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS check_booking_session_overlap ON booking_sessions;
        CREATE TRIGGER check_booking_session_overlap
        BEFORE INSERT OR UPDATE OF resource_id, session_date, start_time, end_time ON booking_sessions
        FOR EACH ROW
        EXECUTE FUNCTION prevent_booking_session_overlap();
      `);
      console.log('[DB Init] Double-booking prevention trigger created/verified');
    } catch (err: unknown) {
      console.warn(`[DB Init] Skipping overlap trigger: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION normalize_tier_value()
        RETURNS TRIGGER AS $$
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
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS normalize_tier_before_write ON users;
        CREATE TRIGGER normalize_tier_before_write
          BEFORE INSERT OR UPDATE OF tier ON users
          FOR EACH ROW
          EXECUTE FUNCTION normalize_tier_value();
      `);
      console.log('[DB Init] Tier normalization trigger created/verified');
    } catch (err: unknown) {
      console.warn(`[DB Init] Skipping tier normalization trigger: ${getErrorMessage(err)}`);
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
      console.log('[DB Init] Tier CHECK constraint created/verified');
    } catch (err: unknown) {
      console.warn(`[DB Init] Skipping tier CHECK constraint: ${getErrorMessage(err)}`);
    }

    try {
      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'users_billing_provider_check'
          ) THEN
            ALTER TABLE users ADD CONSTRAINT users_billing_provider_check
              CHECK (billing_provider IS NULL OR billing_provider IN ('stripe', 'mindbody', 'manual', 'comped', 'family_addon'));
          END IF;
        END $$;
      `);
      console.log('[DB Init] Billing provider CHECK constraint created/verified');
    } catch (err: unknown) {
      console.warn(`[DB Init] Skipping billing provider CHECK constraint: ${getErrorMessage(err)}`);
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
    ];
    
    for (const { name, query } of indexQueries) {
      try {
        await db.execute(query);
      } catch (err: unknown) {
        console.warn(`[DB Init] Skipping index ${name}: ${getErrorMessage(err)}`);
      }
    }
    
    console.log('[DB Init] Performance indexes processed');
  } catch (error: unknown) {
    console.error('[DB Init] Failed to ensure constraints:', getErrorMessage(error));
  }
}

export async function seedTierFeatures(): Promise<void> {
  try {
    const existing = await db.execute(sql`SELECT COUNT(*) FROM tier_features`);
    if (parseInt(existing.rows[0].count as string) > 0) {
      console.log('[DB Init] Tier features already seeded, skipping');
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
    const tierIds = tiersResult.rows.map((r: any) => r.id);

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

    console.log(`[DB Init] Seeded ${features.length} tier features with values for ${tierIds.length} tiers`);
  } catch (error: unknown) {
    console.error('[DB Init] Failed to seed tier features:', getErrorMessage(error));
  }
}
