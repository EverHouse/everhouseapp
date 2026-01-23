import { sql } from 'drizzle-orm';
import { db } from './db';
import { pool } from './core/db';

export async function createStripeTransactionCache(): Promise<void> {
  try {
    await pool.query(`
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
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stripe_cache_created_at ON stripe_transaction_cache(created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stripe_cache_customer_email ON stripe_transaction_cache(customer_email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stripe_cache_status ON stripe_transaction_cache(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stripe_cache_object_type ON stripe_transaction_cache(object_type)`);
    
    console.log('[DB Init] stripe_transaction_cache table created/verified');
  } catch (error: any) {
    console.error('[DB Init] Failed to create stripe_transaction_cache:', error.message);
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
  } catch (error: any) {
    console.error('[DB Init] Failed to seed notice types:', error.message);
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
          CHECK (duration_minutes IN (30, 60, 90, 120, 150, 180, 210, 240, 270, 300));
      END $$;
    `);
    
    // Add reschedule_booking_id column for reschedule workflow
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
    
    // Create performance indexes for common queries (execute each separately, with error handling)
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
      } catch (err: any) {
        console.warn(`[DB Init] Skipping index ${name}: ${err.message}`);
      }
    }
    
    console.log('[DB Init] Performance indexes processed');
  } catch (error: any) {
    console.error('[DB Init] Failed to ensure constraints:', error.message);
  }
}
