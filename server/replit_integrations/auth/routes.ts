import type { Express } from "express";
import { isAuthenticated, isAdminEmail } from "./replitAuth";
import { Pool } from "pg";
import { logger } from "../../core/logger";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function isStaffEmail(email: string): Promise<boolean> {
  if (!email) return false;
  try {
    const result = await pool.query(
      'SELECT id FROM staff_users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error('Error checking staff status:', { error: error as Error });
    return false;
  }
}

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/user", isAuthenticated, async (req, res) => {
    try {
      const user = req.session?.user;
      
      if (!user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      
      const isStaff = await isStaffEmail(user.email);
      const isAdmin = await isAdminEmail(user.email);
      
      const userResult = await pool.query(
        'SELECT id, tags FROM users WHERE LOWER(email) = LOWER($1)',
        [user.email]
      );
      const dbUser = userResult.rows[0];
      
      // Count past bookings using UNION for deduplication
      // Include: host (owner), player (booking_members), guest (booking_guests)
      const bookingsResult = await pool.query(
        `SELECT COUNT(*) as count FROM (
           -- As host
           SELECT br.id FROM booking_requests br
           WHERE LOWER(br.user_email) = LOWER($1)
             AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
             AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           UNION
           -- As added player
           SELECT br.id FROM booking_requests br
           JOIN booking_members bm ON br.id = bm.booking_id
           WHERE LOWER(bm.user_email) = LOWER($1)
             AND bm.is_primary IS NOT TRUE
             AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
             AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           UNION
           -- As guest
           SELECT br.id FROM booking_requests br
           JOIN booking_guests bg ON br.id = bg.booking_id
           WHERE LOWER(bg.guest_email) = LOWER($1)
             AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
             AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
         ) unified_bookings`,
        [user.email]
      );
      const pastBookingsCount = parseInt(bookingsResult.rows[0]?.count || '0', 10);
      
      // Count past event RSVPs (event date < today, excluding cancelled)
      const eventRsvpResult = await pool.query(
        `SELECT COUNT(*) as rsvp_count FROM event_rsvps er
         JOIN events e ON er.event_id = e.id
         WHERE e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date
         AND er.status != 'cancelled'
         AND (
           LOWER(er.user_email) = LOWER($1) 
           OR er.matched_user_id = $2
         )`,
        [user.email, dbUser?.id || null]
      );
      const pastEventsCount = parseInt(eventRsvpResult.rows[0]?.rsvp_count || '0', 10);
      
      // Count past wellness enrollments (class date < today, excluding cancelled)
      const wellnessResult = await pool.query(
        `SELECT COUNT(*) as wellness_count FROM wellness_enrollments we
         JOIN wellness_classes wc ON we.class_id = wc.id
         WHERE LOWER(we.user_email) = LOWER($1) 
         AND we.status != 'cancelled'
         AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date`,
        [user.email]
      );
      const pastWellnessCount = parseInt(wellnessResult.rows[0]?.wellness_count || '0', 10);
      
      // Get last activity date from all visit sources using UNION
      const lastActivityResult = await pool.query(
        `SELECT MAX(last_date) as last_date FROM (
           -- Bookings as host
           SELECT MAX(request_date) as last_date FROM booking_requests
           WHERE LOWER(user_email) = LOWER($1) AND request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           UNION ALL
           -- Bookings as player
           SELECT MAX(br.request_date) as last_date FROM booking_requests br
           JOIN booking_members bm ON br.id = bm.booking_id
           WHERE LOWER(bm.user_email) = LOWER($1) AND bm.is_primary IS NOT TRUE
             AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           UNION ALL
           -- Bookings as guest
           SELECT MAX(br.request_date) as last_date FROM booking_requests br
           JOIN booking_guests bg ON br.id = bg.booking_id
           WHERE LOWER(bg.guest_email) = LOWER($1)
             AND br.request_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND br.status NOT IN ('cancelled', 'declined', 'cancellation_pending')
           UNION ALL
           -- Events
           SELECT MAX(e.event_date) as last_date FROM event_rsvps er
           JOIN events e ON er.event_id = e.id
           WHERE (LOWER(er.user_email) = LOWER($1) OR er.matched_user_id = $2)
             AND e.event_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND er.status != 'cancelled'
           UNION ALL
           -- Wellness
           SELECT MAX(wc.date) as last_date FROM wellness_enrollments we
           JOIN wellness_classes wc ON we.class_id = wc.id
           WHERE LOWER(we.user_email) = LOWER($1) AND wc.date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Los_Angeles')::date AND we.status != 'cancelled'
         ) all_activities`,
        [user.email, dbUser?.id || null]
      );
      const lastActivityDate = lastActivityResult.rows[0]?.last_date || null;
      
      const walkInResult = await pool.query(
        `SELECT COUNT(*)::int as count FROM walk_in_visits WHERE LOWER(member_email) = LOWER($1)`,
        [user.email]
      );
      const walkInCount = walkInResult.rows[0]?.count || 0;

      // Total lifetime visits = past bookings + past event RSVPs + past wellness enrollments + walk-ins
      const totalLifetimeVisits = pastBookingsCount + pastEventsCount + pastWellnessCount + walkInCount;
      
      res.json({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tier: user.tier,
        role: user.role,
        isStaff,
        isAdmin,
        lifetimeVisits: totalLifetimeVisits,
        tags: dbUser?.tags || [],
        lastBookingDate: lastActivityDate
      });
    } catch (error) {
      logger.error("Error fetching user:", { error: error as Error });
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });
}
