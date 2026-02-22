import { Router } from 'express';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { db } from '../db';
import { staffUsers, users } from '../../shared/schema';
import { isProduction } from '../core/db';
import { isAdmin, isStaffOrAdmin } from '../core/middleware';
import { normalizeEmail } from '../core/utils/emailNormalization';
import { getErrorCode } from '../utils/errorUtils';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';

const router = Router();

router.get('/api/staff-users/by-email/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = normalizeEmail(decodeURIComponent(email as string));
    
    const result = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      name: staffUsers.name,
      first_name: staffUsers.firstName,
      last_name: staffUsers.lastName,
      phone: staffUsers.phone,
      job_title: staffUsers.jobTitle,
      is_active: staffUsers.isActive,
      created_at: staffUsers.createdAt,
      created_by: staffUsers.createdBy
    })
      .from(staffUsers)
      .where(eq(staffUsers.email, normalizedEmail));
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Staff user not found' });
    }
    
    res.json(result[0]);
  } catch (error: unknown) {
    logger.error('API error fetching staff user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch staff user' });
  }
});

router.get('/api/staff-users', isStaffOrAdmin, async (req, res) => {
  try {
    const includeAll = req.query.include_all === 'true';
    
    const baseQuery = db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      name: staffUsers.name,
      first_name: staffUsers.firstName,
      last_name: staffUsers.lastName,
      phone: staffUsers.phone,
      job_title: staffUsers.jobTitle,
      role: staffUsers.role,
      is_active: staffUsers.isActive,
      created_at: staffUsers.createdAt,
      created_by: staffUsers.createdBy
    })
      .from(staffUsers);
    
    const result = includeAll 
      ? await baseQuery.orderBy(desc(staffUsers.createdAt))
      : await baseQuery
          .where(sql`${staffUsers.role} = 'staff' OR ${staffUsers.role} IS NULL`)
          .orderBy(desc(staffUsers.createdAt));
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error fetching staff users', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch staff users' });
  }
});

router.post('/api/staff-users', isAdmin, async (req, res) => {
  try {
    const { email: rawEmail, name, first_name, last_name, phone, job_title, role, created_by } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const result = await db.insert(staffUsers)
      .values({
        email: normalizeEmail(email),
        name: name || null,
        firstName: first_name || null,
        lastName: last_name || null,
        phone: phone || null,
        jobTitle: job_title || null,
        role: role || 'staff',
        isActive: true,
        createdBy: created_by || null
      })
      .returning();
    
    logFromRequest(req, 'create_staff_user', 'staff_user', String(result[0].id), result[0].email || '', { role: result[0].role });
    res.status(201).json({
      id: result[0].id,
      email: result[0].email,
      name: result[0].name,
      first_name: result[0].firstName,
      last_name: result[0].lastName,
      phone: result[0].phone,
      job_title: result[0].jobTitle,
      role: result[0].role,
      is_active: result[0].isActive,
      created_at: result[0].createdAt,
      created_by: result[0].createdBy
    });
  } catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      return res.status(400).json({ error: 'This email is already a team member' });
    }
    logger.error('API error adding staff user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add staff user' });
  }
});

router.put('/api/staff-users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email: rawEmail, name, first_name, last_name, phone, job_title, role, is_active } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    const updateData: Record<string, any> = {};
    if (email !== undefined) updateData.email = normalizeEmail(email);
    if (name !== undefined) updateData.name = name;
    if (first_name !== undefined) updateData.firstName = first_name;
    if (last_name !== undefined) updateData.lastName = last_name;
    if (phone !== undefined) updateData.phone = phone;
    if (job_title !== undefined) updateData.jobTitle = job_title;
    if (role !== undefined) updateData.role = role;
    if (is_active !== undefined) updateData.isActive = is_active;
    
    if (is_active === false || (role !== undefined && role !== 'admin')) {
      const currentUser = await db.select({ role: staffUsers.role, isActive: staffUsers.isActive })
        .from(staffUsers)
        .where(eq(staffUsers.id, parseInt(id as string)));
      
      if (currentUser.length > 0 && currentUser[0].role === 'admin' && currentUser[0].isActive) {
        const adminCount = await db.select({ count: sql<number>`count(*)::int` })
          .from(staffUsers)
          .where(and(eq(staffUsers.isActive, true), eq(staffUsers.role, 'admin')));
        
        if (adminCount[0].count <= 1) {
          return res.status(400).json({ error: 'Cannot deactivate or demote the last active admin' });
        }
      }
    }

    const result = await db.update(staffUsers)
      .set(updateData)
      .where(eq(staffUsers.id, parseInt(id as string)))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Staff user not found' });
    }
    
    logFromRequest(req, 'update_staff_user', 'staff_user', req.params.id as any, '', { changes: req.body });
    res.json({
      id: result[0].id,
      email: result[0].email,
      name: result[0].name,
      first_name: result[0].firstName,
      last_name: result[0].lastName,
      phone: result[0].phone,
      job_title: result[0].jobTitle,
      role: result[0].role,
      is_active: result[0].isActive,
      created_at: result[0].createdAt,
      created_by: result[0].createdBy
    });
  } catch (error: unknown) {
    logger.error('API error updating staff user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update staff user' });
  }
});

router.delete('/api/staff-users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.delete(staffUsers)
      .where(eq(staffUsers.id, parseInt(id as string)))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Staff user not found' });
    }
    
    logFromRequest(req, 'delete_staff_user', 'staff_user', req.params.id as any, '', {});
    res.json({ 
      message: 'Staff user removed', 
      staff: {
        id: result[0].id,
        email: result[0].email,
        name: result[0].name,
        first_name: result[0].firstName,
        last_name: result[0].lastName,
        phone: result[0].phone,
        job_title: result[0].jobTitle,
        is_active: result[0].isActive,
        created_at: result[0].createdAt,
        created_by: result[0].createdBy
      }
    });
  } catch (error: unknown) {
    logger.error('API error removing staff user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove staff user' });
  }
});

router.get('/api/admin-users', isAdmin, async (req, res) => {
  try {
    const result = await db.select({
      id: staffUsers.id,
      email: staffUsers.email,
      name: staffUsers.name,
      first_name: staffUsers.firstName,
      last_name: staffUsers.lastName,
      phone: staffUsers.phone,
      job_title: staffUsers.jobTitle,
      is_active: staffUsers.isActive,
      created_at: staffUsers.createdAt,
      created_by: staffUsers.createdBy
    })
      .from(staffUsers)
      .where(eq(staffUsers.role, 'admin'))
      .orderBy(desc(staffUsers.createdAt));
    res.json(result);
  } catch (error: unknown) {
    logger.error('API error fetching admin users', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch admin users' });
  }
});

router.post('/api/admin-users', isAdmin, async (req, res) => {
  try {
    const { email: rawEmail, name, created_by } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const result = await db.insert(staffUsers)
      .values({
        email: normalizeEmail(email),
        name: name || null,
        role: 'admin',
        isActive: true,
        createdBy: created_by || null
      })
      .returning();
    
    logFromRequest(req, 'create_admin_user', 'staff_user', String(result[0].id), result[0].email || '', { role: 'admin' });
    res.status(201).json({
      id: result[0].id,
      email: result[0].email,
      name: result[0].name,
      first_name: result[0].firstName,
      last_name: result[0].lastName,
      phone: result[0].phone,
      job_title: result[0].jobTitle,
      is_active: result[0].isActive,
      created_at: result[0].createdAt,
      created_by: result[0].createdBy
    });
  } catch (error: unknown) {
    if (getErrorCode(error) === '23505') {
      return res.status(400).json({ error: 'This email is already an admin' });
    }
    logger.error('API error adding admin user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to add admin user' });
  }
});

router.put('/api/admin-users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email: rawEmail, name, first_name, last_name, phone, job_title, is_active } = req.body;
    const email = rawEmail?.trim()?.toLowerCase();
    
    const updateData: Record<string, any> = {};
    if (email !== undefined) updateData.email = normalizeEmail(email);
    if (name !== undefined) updateData.name = name;
    if (first_name !== undefined) updateData.firstName = first_name;
    if (last_name !== undefined) updateData.lastName = last_name;
    if (phone !== undefined) updateData.phone = phone;
    if (job_title !== undefined) updateData.jobTitle = job_title;
    if (is_active !== undefined) updateData.isActive = is_active;
    
    if (is_active === false) {
      const adminCount = await db.select({ count: sql<number>`count(*)::int` })
        .from(staffUsers)
        .where(and(eq(staffUsers.isActive, true), eq(staffUsers.role, 'admin')));
      
      if (adminCount[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
      }
    }

    const result = await db.update(staffUsers)
      .set(updateData)
      .where(and(eq(staffUsers.id, parseInt(id as string)), eq(staffUsers.role, 'admin')))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }
    
    logFromRequest(req, 'update_admin_user', 'staff_user', req.params.id as any, '', { changes: req.body });
    res.json({
      id: result[0].id,
      email: result[0].email,
      name: result[0].name,
      first_name: result[0].firstName,
      last_name: result[0].lastName,
      phone: result[0].phone,
      job_title: result[0].jobTitle,
      is_active: result[0].isActive,
      created_at: result[0].createdAt,
      created_by: result[0].createdBy
    });
  } catch (error: unknown) {
    logger.error('API error updating admin user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update admin user' });
  }
});

router.delete('/api/admin-users/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const targetAdmin = await db.select({ isActive: staffUsers.isActive })
      .from(staffUsers)
      .where(and(eq(staffUsers.id, parseInt(id as string)), eq(staffUsers.role, 'admin')))
      .limit(1);
    
    if (targetAdmin.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }
    
    if (targetAdmin[0].isActive) {
      const adminCount = await db.select({ count: sql<number>`count(*)::int` })
        .from(staffUsers)
        .where(and(eq(staffUsers.isActive, true), eq(staffUsers.role, 'admin')));
      
      if (adminCount[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last active admin' });
      }
    }
    
    const result = await db.delete(staffUsers)
      .where(and(eq(staffUsers.id, parseInt(id as string)), eq(staffUsers.role, 'admin')))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }
    
    logFromRequest(req, 'delete_admin_user', 'staff_user', req.params.id as any, '', {});
    res.json({ 
      message: 'Admin user removed', 
      admin: {
        id: result[0].id,
        email: result[0].email,
        name: result[0].name,
        first_name: result[0].firstName,
        last_name: result[0].lastName,
        phone: result[0].phone,
        job_title: result[0].jobTitle,
        is_active: result[0].isActive,
        created_at: result[0].createdAt,
        created_by: result[0].createdBy
      }
    });
  } catch (error: unknown) {
    logger.error('API error removing admin user', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to remove admin user' });
  }
});

router.post('/api/users/batch-emails', isStaffOrAdmin, async (req, res) => {
  try {
    const { userIds } = req.body;
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.json({ emails: {} });
    }
    
    if (userIds.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 user IDs allowed' });
    }
    
    const result = await db.select({
      id: users.id,
      email: users.email
    })
      .from(users)
      .where(inArray(users.id, userIds));
    
    const emails: Record<string, string> = {};
    for (const user of result) {
      if (user.email) {
        emails[user.id] = user.email.toLowerCase();
      }
    }
    
    res.json({ emails });
  } catch (error: unknown) {
    logger.error('API error fetching user emails', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch user emails' });
  }
});

export default router;
