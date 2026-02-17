import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { getStripePublishableKey } from '../../core/stripe';
import { getStripeClient } from '../../core/stripe/client';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';

const router = Router();

router.get('/api/stripe/config', async (req: Request, res: Response) => {
  try {
    const publishableKey = await getStripePublishableKey();
    res.json({ publishableKey });
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting config', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get Stripe configuration' });
  }
});

router.get('/api/stripe/debug-connection', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const stripe = await getStripeClient();
    
    const balance = await stripe.balance.retrieve();
    
    res.json({
      connected: true,
      mode: balance.livemode ? 'live' : 'test',
      available: balance.available,
      pending: balance.pending
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Debug connection error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ 
      connected: false,
      error: getErrorMessage(error) 
    });
  }
});

export default router;
