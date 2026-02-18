import { pool } from '../db';

import { logger } from '../logger';
export type VisitorType = 'classpass' | 'sim_walkin' | 'private_lesson' | 'guest' | 'day_pass' | 'lead' | 'golfnow' | 'private_event';
export type ActivitySource = 'day_pass_purchase' | 'guest_booking' | 'booking_participant' | 'legacy_purchase' | 'trackman_auto_match';

interface UpdateVisitorTypeParams {
  email: string;
  type: VisitorType;
  activitySource: ActivitySource;
  activityDate?: Date;
}

export async function updateVisitorType({
  email,
  type,
  activitySource,
  activityDate = new Date()
}: UpdateVisitorTypeParams): Promise<boolean> {
  if (!email) return false;
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    let updateQuery: string;
    let params: any[];
    
    if (type === 'day_pass') {
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = 'day_pass',
          last_activity_at = $2,
          last_activity_source = $3,
          updated_at = NOW()
        WHERE LOWER(email) = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
        RETURNING id
      `;
      params = [normalizedEmail, activityDate, activitySource];
    } else if (type === 'guest') {
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = 'guest',
          last_activity_at = $2,
          last_activity_source = $3,
          updated_at = NOW()
        WHERE LOWER(email) = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND (visitor_type IS NULL OR visitor_type = 'lead')
        RETURNING id
      `;
      params = [normalizedEmail, activityDate, activitySource];
    } else {
      // For classpass, golfnow, private_lesson, sim_walkin - allow updating from NULL or lead
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = $2,
          last_activity_at = $3,
          last_activity_source = $4,
          updated_at = NOW()
        WHERE LOWER(email) = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND (visitor_type IS NULL OR visitor_type = 'lead' OR visitor_type = 'guest')
        RETURNING id
      `;
      params = [normalizedEmail, type, activityDate, activitySource];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[VisitorType] Updated ${normalizedEmail} to type '${type}' (source: ${activitySource})\n`);
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error('[VisitorType] Error updating visitor type:', { error: error });
    return false;
  }
}

export async function updateVisitorTypeByUserId(
  userId: number,
  type: VisitorType,
  activitySource: ActivitySource,
  activityDate: Date = new Date()
): Promise<boolean> {
  try {
    let updateQuery: string;
    let params: any[];
    
    if (type === 'day_pass') {
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = 'day_pass',
          last_activity_at = $2,
          last_activity_source = $3,
          updated_at = NOW()
        WHERE id = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
        RETURNING id
      `;
      params = [userId, activityDate, activitySource];
    } else if (type === 'guest') {
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = 'guest',
          last_activity_at = $2,
          last_activity_source = $3,
          updated_at = NOW()
        WHERE id = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND (visitor_type IS NULL OR visitor_type = 'lead')
        RETURNING id
      `;
      params = [userId, activityDate, activitySource];
    } else {
      // For classpass, golfnow, private_lesson, sim_walkin - allow updating from NULL or lead
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = $2,
          last_activity_at = $3,
          last_activity_source = $4,
          updated_at = NOW()
        WHERE id = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND (visitor_type IS NULL OR visitor_type = 'lead' OR visitor_type = 'guest')
        RETURNING id
      `;
      params = [userId, type, activityDate, activitySource];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[VisitorType] Updated user ${userId} to type '${type}' (source: ${activitySource})\n`);
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error('[VisitorType] Error updating visitor type by ID:', { error: error });
    return false;
  }
}

export async function calculateVisitorTypeFromHistory(email: string): Promise<VisitorType | null> {
  if (!email) return null;
  
  const normalizedEmail = email.toLowerCase().trim();
  
  try {
    const purchaseQuery = `
      SELECT 
        item_name,
        sale_date as activity_date
      FROM legacy_purchases
      WHERE LOWER(member_email) = $1
      ORDER BY sale_date DESC
      LIMIT 1
    `;
    
    const guestQuery = `
      SELECT 
        bs.session_date::timestamp as activity_date
      FROM booking_participants bp
      JOIN guests g ON bp.guest_id = g.id
      JOIN booking_sessions bs ON bp.session_id = bs.id
      WHERE LOWER(g.email) = $1
        AND bp.participant_type = 'guest'
      ORDER BY bs.session_date DESC
      LIMIT 1
    `;
    
    const [purchaseResult, guestResult] = await Promise.all([
      pool.query(purchaseQuery, [normalizedEmail]),
      pool.query(guestQuery, [normalizedEmail])
    ]);
    
    const lastPurchase = purchaseResult.rows[0];
    const lastGuestAppearance = guestResult.rows[0];
    
    let purchaseType: VisitorType | null = null;
    let purchaseDate: Date | null = null;
    
    if (lastPurchase) {
      const itemName = (lastPurchase.item_name || '').toLowerCase();
      purchaseDate = new Date(lastPurchase.activity_date);
      
      if (itemName.includes('classpass')) {
        purchaseType = 'classpass';
      } else if (itemName.includes('simulator walk-in') || itemName.includes('sim walk-in')) {
        purchaseType = 'sim_walkin';
      } else if (itemName.includes('private lesson')) {
        purchaseType = 'private_lesson';
      } else if (itemName.includes('day pass')) {
        purchaseType = 'day_pass';
      }
    }
    
    let guestDate: Date | null = null;
    if (lastGuestAppearance) {
      guestDate = new Date(lastGuestAppearance.activity_date);
    }
    
    if (!purchaseType && !guestDate) {
      return null;
    }
    
    if (purchaseType && !guestDate) {
      return purchaseType;
    }
    
    if (!purchaseType && guestDate) {
      return 'guest';
    }
    
    if (purchaseDate && guestDate) {
      if (guestDate > purchaseDate) {
        return 'guest';
      }
      return purchaseType;
    }
    
    return purchaseType || null;
  } catch (error) {
    logger.error('[VisitorType] Error calculating visitor type from history:', { error: error });
    return null;
  }
}
