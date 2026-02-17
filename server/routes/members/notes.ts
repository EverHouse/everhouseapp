import { Router } from 'express';
import { eq, sql, desc, and } from 'drizzle-orm';
import { db } from '../../db';
import { memberNotes } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { isStaffOrAdmin } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { logFromRequest } from '../../core/auditLog';

const router = Router();

router.get('/api/members/:email/notes', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    
    const notes = await db.select()
      .from(memberNotes)
      .where(sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`)
      .orderBy(desc(memberNotes.isPinned), desc(memberNotes.createdAt));
    
    res.json(notes);
  } catch (error: unknown) {
    if (!isProduction) console.error('Member notes error:', error);
    res.status(500).json({ error: 'Failed to fetch member notes' });
  }
});

router.post('/api/members/:email/notes', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { content, isPinned } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!content?.trim()) {
      return res.status(400).json({ error: 'Note content is required' });
    }
    
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    
    const result = await db.insert(memberNotes)
      .values({
        memberEmail: normalizedEmail,
        content: content.trim(),
        createdBy: sessionUser?.email || 'unknown',
        createdByName: sessionUser?.firstName 
          ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
          : sessionUser?.email?.split('@')[0] || 'Staff',
        isPinned: isPinned || false,
      })
      .returning();
    
    logFromRequest(req, 'create_note' as any, 'note' as any, String(result[0].id), normalizedEmail);
    res.status(201).json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) console.error('Create note error:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

router.put('/api/members/:email/notes/:noteId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, noteId } = req.params;
    const { content, isPinned } = req.body;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    
    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (content !== undefined) updateData.content = content.trim();
    if (isPinned !== undefined) updateData.isPinned = isPinned;
    
    const result = await db.update(memberNotes)
      .set(updateData)
      .where(and(
        eq(memberNotes.id, parseInt(noteId as string)),
        sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    
    logFromRequest(req, 'update_note' as any, 'note' as any, noteId as string, normalizedEmail);
    res.json(result[0]);
  } catch (error: unknown) {
    if (!isProduction) console.error('Update note error:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

router.delete('/api/members/:email/notes/:noteId', isStaffOrAdmin, async (req, res) => {
  try {
    const { email, noteId } = req.params;
    const normalizedEmail = decodeURIComponent(email as string).toLowerCase();
    
    const result = await db.delete(memberNotes)
      .where(and(
        eq(memberNotes.id, parseInt(noteId as string)),
        sql`LOWER(${memberNotes.memberEmail}) = ${normalizedEmail}`
      ))
      .returning();
    
    if (result.length === 0) {
      return res.status(404).json({ error: 'Note not found for this member' });
    }
    
    logFromRequest(req, 'delete_note' as any, 'note' as any, noteId as string, normalizedEmail);
    res.json({ success: true });
  } catch (error: unknown) {
    if (!isProduction) console.error('Delete note error:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

export default router;
