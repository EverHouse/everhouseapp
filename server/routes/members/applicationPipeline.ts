import { Router } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { logger } from '../../core/logger';

const router = Router();

router.get('/api/admin/applications', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        fs.id, fs.first_name, fs.last_name, fs.email, fs.phone,
        fs.message, fs.metadata, fs.status, fs.notes,
        fs.created_at, fs.updated_at,
        u.id as user_id, u.membership_status, u.tier, u.first_login_at
      FROM form_submissions fs
      LEFT JOIN users u ON LOWER(u.email) = LOWER(fs.email)
      WHERE fs.form_type = 'membership'
      ORDER BY 
        CASE fs.status 
          WHEN 'new' THEN 1
          WHEN 'read' THEN 2
          WHEN 'reviewing' THEN 3
          WHEN 'approved' THEN 4
          WHEN 'invited' THEN 5
          WHEN 'converted' THEN 6
          WHEN 'declined' THEN 7
          WHEN 'archived' THEN 8
        END,
        fs.created_at DESC
    `);

    res.json(result.rows);
  } catch (error: unknown) {
    logger.error('[Applications] Failed to fetch pipeline', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

router.put('/api/admin/applications/:id/status', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['new', 'read', 'reviewing', 'approved', 'invited', 'converted', 'declined', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await pool.query(
      `UPDATE form_submissions SET status = $1, notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3 AND form_type = 'membership'`,
      [status, notes || null, id]
    );

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Applications] Failed to update status', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

router.post('/api/admin/applications/:id/send-invite', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { tierId } = req.body;

    if (!tierId) return res.status(400).json({ error: 'Tier ID required' });

    const appResult = await pool.query(
      `SELECT id, email, first_name, last_name FROM form_submissions WHERE id = $1 AND form_type = 'membership'`,
      [id]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];

    const internalRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/stripe/staff/send-membership-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || '',
      },
      body: JSON.stringify({
        email: app.email,
        firstName: app.first_name || '',
        lastName: app.last_name || '',
        tierId: tierId,
      }),
    });

    if (!internalRes.ok) {
      const errData = await internalRes.json().catch(() => ({ error: 'Failed to send invite' }));
      return res.status(internalRes.status).json(errData);
    }

    await pool.query(
      `UPDATE form_submissions SET status = 'invited', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    const data = await internalRes.json();
    res.json({ success: true, checkoutUrl: data.checkoutUrl });
  } catch (error: unknown) {
    logger.error('[Applications] Failed to send invite', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

export default router;
