import { db } from '../db';
import { sql } from 'drizzle-orm';

interface AlertEntry {
  id: number;
  title: string;
  message: string;
  createdAt: string;
  isRead: boolean;
  userEmail: string;
}

interface AlertQueryParams {
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export async function getAlertHistory(params: AlertQueryParams): Promise<AlertEntry[]> {
  const limit = Math.min(params.limit || 100, 200);

  // Build parameterized WHERE clause
  const conditions = [sql`type = 'system'`];

  if (params.startDate) {
    conditions.push(sql`created_at >= ${params.startDate}`);
  }
  if (params.endDate) {
    conditions.push(sql`created_at <= ${params.endDate}::date + INTERVAL '1 day'`);
  }

  const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    SELECT DISTINCT ON (title, DATE_TRUNC('minute', created_at))
      id, user_email, title, message, created_at, is_read
    FROM notifications
    ${whereClause}
    ORDER BY title, DATE_TRUNC('minute', created_at) DESC, id DESC
    LIMIT ${limit}
  `);

  const alerts: AlertEntry[] = result.rows.map(r => ({
    id: r.id,
    title: r.title,
    message: r.message,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
    isRead: r.is_read,
    userEmail: r.user_email,
  }));

  alerts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return alerts;
}
