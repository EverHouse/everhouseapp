import { pool } from '../db';

export type VisitorType = 'day_pass' | 'guest' | 'lead';
export type ActivitySource = 'day_pass_purchase' | 'guest_booking' | 'booking_participant';

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
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = $2,
          updated_at = NOW()
        WHERE LOWER(email) = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND visitor_type IS NULL
        RETURNING id
      `;
      params = [normalizedEmail, type];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[VisitorType] Updated ${normalizedEmail} to type '${type}' (source: ${activitySource})\n`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('[VisitorType] Error updating visitor type:', error);
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
      updateQuery = `
        UPDATE users
        SET 
          visitor_type = $2,
          updated_at = NOW()
        WHERE id = $1
          AND (role = 'visitor' OR membership_status IN ('visitor', 'non-member'))
          AND role NOT IN ('admin', 'staff', 'member')
          AND tier IS NULL
          AND visitor_type IS NULL
        RETURNING id
      `;
      params = [userId, type];
    }
    
    const result = await pool.query(updateQuery, params);
    
    if (result.rowCount && result.rowCount > 0) {
      process.stderr.write(`[VisitorType] Updated user ${userId} to type '${type}' (source: ${activitySource})\n`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('[VisitorType] Error updating visitor type by ID:', error);
    return false;
  }
}
