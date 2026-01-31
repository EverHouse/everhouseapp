import { Router } from 'express';
import { pool } from '../../core/db';
import { isStaffOrAdmin } from '../../core/middleware';

const router = Router();

router.get('/api/staff/list', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT su.id, su.email, su.first_name, su.last_name, su.role,
             u.id as user_id
      FROM staff_users su
      LEFT JOIN users u ON LOWER(u.email) = LOWER(su.email)
      WHERE su.is_active = true
      ORDER BY 
        CASE su.role 
          WHEN 'golf_instructor' THEN 1 
          WHEN 'admin' THEN 2 
          WHEN 'staff' THEN 3 
          ELSE 4 
        END,
        su.first_name
    `);
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching staff list:', error);
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

router.get('/api/directory/team', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        su.id as staff_id,
        su.email,
        su.first_name,
        su.last_name,
        su.phone,
        su.job_title,
        su.role,
        su.is_active,
        u.id as user_id,
        u.tier,
        u.membership_status,
        u.stripe_customer_id,
        u.hubspot_id
      FROM staff_users su
      LEFT JOIN users u ON LOWER(u.email) = LOWER(su.email)
      WHERE su.is_active = true
      ORDER BY 
        CASE su.role 
          WHEN 'golf_instructor' THEN 1 
          WHEN 'admin' THEN 2 
          WHEN 'staff' THEN 3 
          ELSE 4 
        END,
        su.first_name,
        su.last_name
    `);
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching directory team:', error);
    res.status(500).json({ error: 'Failed to fetch team directory' });
  }
});

export default router;
