import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { normalizeToISODate } from '../../utils/dateNormalize';

export async function fetchOverlappingNotices(params: {
  startDate: string;
  endDate?: string;
  startTime: string;
  endTime: string;
  sameDayOnly: boolean;
}) {
  const queryDate = normalizeToISODate(params.startDate);
  const queryEndDate = normalizeToISODate(params.endDate || queryDate);
  const queryStartTime = params.startTime;
  const queryEndTime = params.endTime;
  
  const timeOverlapCondition = params.sameDayOnly
    ? sql``
    : sql`AND (
        (fc.start_time IS NULL AND fc.end_time IS NULL)
        OR (fc.start_time < ${queryEndTime} AND fc.end_time > ${queryStartTime})
      )`;
  
  const result = await db.execute(sql`
    SELECT 
      fc.id,
      fc.title,
      fc.reason,
      fc.notice_type,
      fc.start_date,
      fc.end_date,
      fc.start_time,
      fc.end_time,
      fc.affected_areas,
      fc.google_calendar_id,
      fc.created_at,
      fc.created_by,
      CASE 
        WHEN fc.google_calendar_id IS NOT NULL THEN 'Google Calendar'
        WHEN fc.created_by = 'system_cleanup' THEN 'Auto-generated'
        ELSE 'Manual'
      END as source
    FROM facility_closures fc
    WHERE fc.is_active = true
      AND fc.start_date <= ${queryEndDate}
      AND fc.end_date >= ${queryDate}
      ${timeOverlapCondition}
    ORDER BY fc.start_date, fc.start_time
    LIMIT 20
  `);
  
  return result.rows;
}
