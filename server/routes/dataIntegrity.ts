import { Router } from 'express';
import { isAdmin } from '../core/middleware';
import { runAllIntegrityChecks, getIntegritySummary } from '../core/dataIntegrity';
import { isProduction } from '../core/db';

const router = Router();

router.get('/api/data-integrity/run', isAdmin, async (req, res) => {
  try {
    const results = await runAllIntegrityChecks();
    res.json({
      success: true,
      results,
      meta: {
        totalChecks: results.length,
        passed: results.filter(r => r.status === 'pass').length,
        warnings: results.filter(r => r.status === 'warning').length,
        failed: results.filter(r => r.status === 'fail').length,
        totalIssues: results.reduce((sum, r) => sum + r.issueCount, 0),
        lastRun: new Date()
      }
    });
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Run error:', error);
    res.status(500).json({ error: 'Failed to run integrity checks', details: error.message });
  }
});

router.get('/api/data-integrity/summary', isAdmin, async (req, res) => {
  try {
    const summary = await getIntegritySummary();
    res.json(summary);
  } catch (error: any) {
    if (!isProduction) console.error('[DataIntegrity] Summary error:', error);
    res.status(500).json({ error: 'Failed to get integrity summary', details: error.message });
  }
});

export default router;
