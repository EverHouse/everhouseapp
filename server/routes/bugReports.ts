import { Router } from 'express';
import { db } from '../db';
import { bugReports } from '../../shared/schema';
import { eq, desc, and, SQL } from 'drizzle-orm';
import { isAuthenticated, isStaffOrAdmin } from '../core/middleware';
import { notifyAllStaff, notifyMember } from '../core/notificationService';
import { getSessionUser } from '../types/session';

const router = Router();

router.post('/api/bug-reports', isAuthenticated, async (req, res) => {
  try {
    const { description, screenshotUrl, pageUrl } = req.body;
    const user = getSessionUser(req);
    
    if (!user?.email) {
      return res.status(401).json({ error: 'Please log in to submit a bug report' });
    }
    
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    
    const [report] = await db.insert(bugReports).values({
      userEmail: user.email,
      userName: user.firstName && user.lastName 
        ? `${user.firstName} ${user.lastName}`.trim() 
        : user.firstName || user.email,
      userRole: user.role || 'member',
      description: description.trim(),
      screenshotUrl: screenshotUrl || null,
      pageUrl: pageUrl || null,
      userAgent: req.headers['user-agent'] || null,
      status: 'open',
    }).returning();
    
    // Notify staff about new bug report
    await notifyAllStaff(
      'New Bug Report',
      `${report.userName || report.userEmail} submitted a bug report: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`,
      'system',
      { relatedId: report.id, relatedType: 'bug_report', url: '/#/admin/bug-reports' }
    );
    
    res.status(201).json(report);
  } catch (error: any) {
    console.error('Bug report creation error:', error);
    res.status(500).json({ error: 'Failed to submit bug report' });
  }
});

router.get('/api/admin/bug-reports', isStaffOrAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    
    const conditions: SQL[] = [];
    
    if (status && typeof status === 'string' && status !== 'all') {
      conditions.push(eq(bugReports.status, status));
    }
    
    let query = db.select().from(bugReports);
    if (conditions.length > 0) {
      query = query.where(conditions[0]) as typeof query;
    }
    
    const result = await query.orderBy(desc(bugReports.createdAt));
    
    res.json(result);
  } catch (error: any) {
    console.error('Bug reports fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bug reports' });
  }
});

router.get('/api/admin/bug-reports/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [report] = await db.select().from(bugReports)
      .where(eq(bugReports.id, parseInt(id)));
    
    if (!report) {
      return res.status(404).json({ error: 'Bug report not found' });
    }
    
    res.json(report);
  } catch (error: any) {
    console.error('Bug report fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch bug report' });
  }
});

router.put('/api/admin/bug-reports/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, staffNotes } = req.body;
    const user = (req as any).user;
    
    const updateData: any = {
      updatedAt: new Date(),
    };
    
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'resolved') {
        updateData.resolvedBy = user.email;
        updateData.resolvedAt = new Date();
      }
    }
    
    if (staffNotes !== undefined) {
      updateData.staffNotes = staffNotes;
    }
    
    // Notify the member when their bug report is resolved
    if (status === 'resolved') {
      // Need to fetch the original report to get the user email
      const [original] = await db.select().from(bugReports).where(eq(bugReports.id, parseInt(id)));
      if (original?.userEmail) {
        await notifyMember({
          userEmail: original.userEmail,
          title: 'Bug Report Resolved',
          message: 'Your bug report has been resolved. Thank you for helping us improve!',
          type: 'system',
          relatedId: parseInt(id),
          relatedType: 'bug_report',
          url: '/#/profile'
        });
      }
    }
    
    const [updated] = await db.update(bugReports)
      .set(updateData)
      .where(eq(bugReports.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Bug report not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    console.error('Bug report update error:', error);
    res.status(500).json({ error: 'Failed to update bug report' });
  }
});

router.delete('/api/admin/bug-reports/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [deleted] = await db.delete(bugReports)
      .where(eq(bugReports.id, parseInt(id)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Bug report not found' });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Bug report delete error:', error);
    res.status(500).json({ error: 'Failed to delete bug report' });
  }
});

export default router;
