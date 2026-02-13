import { schedulerTracker } from '../core/schedulerTracker';
import { pool } from '../core/db';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { notifyMember } from '../core/notificationService';
import { logger } from '../core/logger';
import { formatDateDisplayWithDay, formatTime12Hour } from '../utils/dateUtils';

const INVITE_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

async function expireUnacceptedInvites(): Promise<void> {
  try {
    const expiredInvites = await db.execute(sql`
      SELECT 
        bp.id as participant_id,
        bp.user_id,
        bp.display_name,
        bp.session_id,
        bs.session_date,
        bs.start_time,
        br.id as booking_id,
        br.user_email as owner_email,
        br.user_name as owner_name
      FROM booking_participants bp
      JOIN booking_sessions bs ON bp.session_id = bs.id
      JOIN booking_requests br ON br.session_id = bs.id
      WHERE bp.invite_status = 'pending'
        AND bp.invite_expires_at IS NOT NULL
        AND bp.invite_expires_at < NOW()
        AND bp.participant_type = 'member'
    `);
    
    if (expiredInvites.rows.length === 0) {
      return;
    }
    
    console.log(`[Invite Expiry] Processing ${expiredInvites.rows.length} expired invites`);
    schedulerTracker.recordRun('Invite Expiry', true);
    
    for (const invite of expiredInvites.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        await client.query(`
          UPDATE booking_participants 
          SET invite_status = 'expired', 
              expired_reason = 'auto_expired',
              responded_at = $2
          WHERE id = $1
        `, [invite.participant_id, new Date().toISOString()]);
        
        let memberEmail: string | null = null;
        if (invite.user_id) {
          const userResult = await client.query(
            `SELECT email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`,
            [invite.user_id]
          );
          memberEmail = userResult.rows[0]?.email?.toLowerCase() || null;
        }
        
        if (memberEmail) {
          await client.query(
            `DELETE FROM booking_members WHERE booking_id = $1 AND LOWER(user_email) = LOWER($2)`,
            [invite.booking_id, memberEmail]
          );
        }
        
        await client.query('COMMIT');
        
        if (invite.owner_email) {
          const dateDisplay = invite.session_date ? formatDateDisplayWithDay(invite.session_date) : 'your booking';
          const timeDisplay = invite.start_time ? ` at ${formatTime12Hour(invite.start_time)}` : '';
          
          await notifyMember({
            userEmail: invite.owner_email.toLowerCase(),
            type: 'booking',
            title: 'Invite expired',
            message: `${invite.display_name}'s invite to your booking on ${dateDisplay}${timeDisplay} has expired as they did not respond in time.`,
            relatedId: invite.booking_id
          });
        }
        
        logger.info('[Invite Expiry] Invite expired and owner notified', {
          extra: {
            participantId: invite.participant_id,
            bookingId: invite.booking_id,
            invitedMember: invite.display_name,
            ownerEmail: invite.owner_email
          }
        });
      } catch (inviteError) {
        await client.query('ROLLBACK');
        logger.error('[Invite Expiry] Error processing individual invite', {
          error: inviteError as Error,
          extra: { participantId: invite.participant_id }
        });
      } finally {
        client.release();
      }
    }
    
    console.log(`[Invite Expiry] Completed processing ${expiredInvites.rows.length} expired invites`);
    schedulerTracker.recordRun('Invite Expiry', true);
  } catch (err) {
    console.error('[Invite Expiry] Scheduler error:', err);
    schedulerTracker.recordRun('Invite Expiry', false, String(err));
  }
}

export function startInviteExpiryScheduler(): void {
  setInterval(expireUnacceptedInvites, INVITE_EXPIRY_INTERVAL_MS);
  console.log('[Startup] Invite auto-expiry scheduler enabled (runs every 5 minutes)');
}
