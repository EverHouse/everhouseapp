import { Router, Request } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { logger } from '../../core/logger';
import { 
  findAttendanceDiscrepancies, 
  markAsReconciled, 
  adjustLedgerForReconciliation, 
  getReconciliationSummary 
} from '../../core/bookingService/trackmanReconciliation';
import { validateQuery } from '../../middleware/validate';
import { z } from 'zod';

const router = Router();

const reconciliationQuerySchema = z.object({
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: z.enum(['pending', 'reviewed', 'adjusted', 'all']).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
}).passthrough();

router.get('/api/admin/trackman/reconciliation', isStaffOrAdmin, validateQuery(reconciliationQuerySchema), async (req, res) => {
  try {
    const vq = (req as Request & { validatedQuery: z.infer<typeof reconciliationQuerySchema> }).validatedQuery;
    const startDate = vq.start_date;
    const endDate = vq.end_date;
    const status = vq.status;
    const limit = parseInt(vq.limit || '', 10) || 100;
    const offset = parseInt(vq.offset || '', 10) || 0;
    
    const result = await findAttendanceDiscrepancies({
      startDate,
      endDate,
      status: status || 'all',
      limit,
      offset
    });
    
    res.json({
      discrepancies: result.discrepancies,
      stats: result.stats,
      totalCount: result.totalCount
    });
  } catch (error: unknown) {
    logger.error('Fetch reconciliation discrepancies error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch attendance discrepancies' });
  }
});

router.get('/api/admin/trackman/reconciliation/summary', isStaffOrAdmin, async (req, res) => {
  try {
    const summary = await getReconciliationSummary();
    res.json(summary);
  } catch (error: unknown) {
    logger.error('Fetch reconciliation summary error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch reconciliation summary' });
  }
});

router.put('/api/admin/trackman/reconciliation/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, adjustLedger } = req.body;
    const staffEmail = req.session?.user?.email || 'admin';
    
    if (!status || !['reviewed', 'adjusted'].includes(status)) {
      return res.status(400).json({ 
        error: 'status is required and must be "reviewed" or "adjusted"' 
      });
    }
    
    const reconciliationId = parseInt(id as string, 10);
    if (isNaN(reconciliationId)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    
    let result;
    
    if (status === 'adjusted' && adjustLedger) {
      const adjustResult = await adjustLedgerForReconciliation(
        reconciliationId,
        staffEmail,
        notes
      );
      
      if (!adjustResult.success) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      result = { 
        success: true, 
        status: 'adjusted',
        adjustmentAmount: adjustResult.adjustmentAmount 
      };
    } else {
      const reconcileResult = await markAsReconciled(
        reconciliationId,
        staffEmail,
        status,
        notes
      );
      
      if (!reconcileResult.success) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      result = { 
        success: true, 
        status,
        booking: reconcileResult.booking 
      };
    }
    
    res.json(result);
  } catch (error: unknown) {
    logger.error('Update reconciliation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update reconciliation status' });
  }
});

export default router;
