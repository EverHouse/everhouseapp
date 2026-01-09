import { Router } from 'express';
import { db } from '../db';
import { formSubmissions } from '../../shared/schema';
import { eq, desc, and, SQL } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';

const router = Router();

router.get('/api/admin/inquiries', isStaffOrAdmin, async (req, res) => {
  try {
    const { status, formType } = req.query;
    
    const conditions: SQL[] = [];
    
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
    
    const result = await query.orderBy(desc(formSubmissions.createdAt));
    
    res.json(result);
  } catch (error: any) {
    console.error('Inquiries fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch inquiries' });
  }
});

router.get('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [inquiry] = await db.select().from(formSubmissions)
      .where(eq(formSubmissions.id, parseInt(id)));
    
    if (!inquiry) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    res.json(inquiry);
  } catch (error: any) {
    console.error('Inquiry fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch inquiry' });
  }
});

router.put('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const [updated] = await db.update(formSubmissions)
      .set({
        ...(status !== undefined && { status }),
        ...(notes !== undefined && { notes }),
        updatedAt: new Date(),
      })
      .where(eq(formSubmissions.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    console.error('Inquiry update error:', error);
    res.status(500).json({ error: 'Failed to update inquiry' });
  }
});

router.delete('/api/admin/inquiries/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { archive } = req.query;
    
    if (archive === 'true') {
      const [archived] = await db.update(formSubmissions)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(formSubmissions.id, parseInt(id)))
        .returning();
      
      if (!archived) {
        return res.status(404).json({ error: 'Inquiry not found' });
      }
      
      return res.json({ success: true, archived });
    }
    
    const [deleted] = await db.delete(formSubmissions)
      .where(eq(formSubmissions.id, parseInt(id)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error('Inquiry deletion error:', error);
    res.status(500).json({ error: 'Failed to delete inquiry' });
  }
});

export default router;
