import { Router } from 'express';
import { db } from '../db';
import { formSubmissions } from '../../shared/schema';
import { eq, desc, and, ne, SQL } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';

const router = Router();

router.get('/api/admin/inquiries', isStaffOrAdmin, async (req, res) => {
  try {
    const { status, formType, limit: limitParam } = req.query;
    const queryLimit = Math.min(Math.max(parseInt(limitParam as string) || 500, 1), 5000);
    
    const conditions: SQL[] = [
      ne(formSubmissions.formType, 'membership'),
    ];
    
    if (status && typeof status === 'string') {
      conditions.push(eq(formSubmissions.status, status));
    }
    
    if (formType && typeof formType === 'string') {
      conditions.push(eq(formSubmissions.formType, formType));
    }
    
    let query = db.select().from(formSubmissions);
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions)) as typeof query;
    }
    
    const result = await query.orderBy(desc(formSubmissions.createdAt)).limit(queryLimit);
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('Inquiries fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch inquiries' });
  }
});

router.get('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const parsedId = parseInt(id as string);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'Invalid ID' });
    
    const [inquiry] = await db.select().from(formSubmissions)
      .where(eq(formSubmissions.id, parsedId));
    
    if (!inquiry) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    res.json(inquiry);
  } catch (error: unknown) {
    logger.error('Inquiry fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch inquiry' });
  }
});

router.put('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const parsedId = parseInt(id as string);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'Invalid ID' });
    const { status, notes } = req.body;
    
    const [updated] = await db.update(formSubmissions)
      .set({
        ...(status !== undefined && { status }),
        ...(notes !== undefined && { notes }),
        updatedAt: new Date(),
      })
      .where(eq(formSubmissions.id, parsedId))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    logFromRequest(req, 'update_inquiry', 'inquiry', id as string);
    
    res.json(updated);
  } catch (error: unknown) {
    logger.error('Inquiry update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update inquiry' });
  }
});

router.delete('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const parsedId = parseInt(id as string);
    if (isNaN(parsedId)) return res.status(400).json({ error: 'Invalid ID' });
    const { archive } = req.query;
    
    if (archive === 'true') {
      const [archived] = await db.update(formSubmissions)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(formSubmissions.id, parsedId))
        .returning();
      
      if (!archived) {
        return res.status(404).json({ error: 'Inquiry not found' });
      }
      
      return res.json({ success: true, archived });
    }
    
    const [deleted] = await db.delete(formSubmissions)
      .where(eq(formSubmissions.id, parsedId))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    logFromRequest(req, 'delete_inquiry', 'inquiry', id as string);
    
    res.json({ success: true, deleted });
  } catch (error: unknown) {
    logger.error('Inquiry deletion error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete inquiry' });
  }
});

export default router;
