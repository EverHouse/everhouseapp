import { logger } from '../../core/logger';
import { Router, Request, Response } from 'express';
import { isStaffOrAdmin } from '../../core/middleware';
import { pool } from '../../core/db';
import { getSessionUser } from '../../types/session';
import {
  createInvoice,
  previewInvoice,
  finalizeAndSendInvoice,
  listCustomerInvoices,
  getInvoice,
  voidInvoice
} from '../../core/stripe';
import { sendNotificationToUser, broadcastBillingUpdate } from '../../core/websocket';
import { logFromRequest } from '../../core/auditLog';

const router = Router();

router.get('/api/stripe/invoices/preview', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, priceId } = req.query;
    
    if (!customerId || !priceId) {
      return res.status(400).json({ error: 'Missing required query params: customerId, priceId' });
    }
    
    const result = await previewInvoice({
      customerId: customerId as string,
      priceId: priceId as string,
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to preview invoice' });
    }
    
    res.json({ preview: result.preview });
  } catch (error: unknown) {
    logger.error('[Stripe] Error previewing invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to preview invoice' });
  }
});

router.get('/api/stripe/invoices/:customerId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    
    const result = await listCustomerInvoices(customerId as string);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list invoices' });
    }
    
    res.json({
      invoices: result.invoices,
      count: result.invoices?.length || 0
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error listing invoices', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

router.post('/api/stripe/invoices', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { customerId, items, description } = req.body;
    
    if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: customerId, items (array)' });
    }
    
    const result = await createInvoice({
      customerId,
      items,
      description,
    });
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to create invoice' });
    }
    
    try {
      const memberLookup = await pool.query(
        'SELECT email FROM users WHERE stripe_customer_id = $1',
        [customerId]
      );
      if (memberLookup.rows.length > 0) {
        const memberEmail = memberLookup.rows[0].email;
        sendNotificationToUser(memberEmail, {
          type: 'billing_update',
          title: 'New Invoice',
          message: 'A new invoice has been created for your account.',
          data: { invoiceId: result.invoice?.id }
        });
        broadcastBillingUpdate({ action: 'invoice_created', memberEmail });
      }
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send invoice notification', { extra: { notifyError } });
    }
    
    res.json({
      success: true,
      invoice: result.invoice
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error creating invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

router.post('/api/stripe/invoices/:invoiceId/finalize', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const result = await finalizeAndSendInvoice(invoiceId as string);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to finalize invoice' });
    }
    
    try {
      if (result.invoice?.customer) {
        const customerId = typeof result.invoice.customer === 'string' 
          ? result.invoice.customer 
          : result.invoice.customer.id;
        const memberLookup = await pool.query(
          'SELECT email FROM users WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (memberLookup.rows.length > 0) {
          const memberEmail = memberLookup.rows[0].email;
          sendNotificationToUser(memberEmail, {
            type: 'billing_update',
            title: 'Invoice Ready',
            message: 'Your invoice is ready for payment.',
            data: { invoiceId: result.invoice.id }
          });
          broadcastBillingUpdate({ action: 'invoice_finalized', memberEmail });
        }
      }
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send invoice finalize notification', { extra: { notifyError } });
    }
    
    res.json({
      success: true,
      invoice: result.invoice
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error finalizing invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to finalize invoice' });
  }
});

router.get('/api/stripe/invoice/:invoiceId', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const result = await getInvoice(invoiceId as string);
    
    if (!result.success) {
      return res.status(404).json({ error: result.error || 'Invoice not found' });
    }
    
    res.json({ invoice: result.invoice });
  } catch (error: unknown) {
    logger.error('[Stripe] Error getting invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

router.post('/api/stripe/invoices/:invoiceId/void', isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    
    const invoiceResult = await getInvoice(invoiceId as string);
    const customerId = invoiceResult.invoice?.customer 
      ? (typeof invoiceResult.invoice.customer === 'string' 
          ? invoiceResult.invoice.customer 
          : invoiceResult.invoice.customer.id)
      : null;
    
    const result = await voidInvoice(invoiceId as string);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to void invoice' });
    }
    
    try {
      if (customerId) {
        const memberLookup = await pool.query(
          'SELECT email FROM users WHERE stripe_customer_id = $1',
          [customerId]
        );
        if (memberLookup.rows.length > 0) {
          const memberEmail = memberLookup.rows[0].email;
          sendNotificationToUser(memberEmail, {
            type: 'billing_update',
            title: 'Invoice Voided',
            message: 'An invoice on your account has been voided.',
            data: { invoiceId }
          });
          broadcastBillingUpdate({ action: 'invoice_voided', memberEmail });
        }
      }
    } catch (notifyError) {
      logger.error('[Stripe] Failed to send invoice void notification', { extra: { notifyError } });
    }
    
    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('[Stripe] Error voiding invoice', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to void invoice' });
  }
});

router.get('/api/my-invoices', async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionEmail;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      const userRole = sessionUser?.role;
      if (userRole === 'admin' || userRole === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
        logFromRequest(req, {
          action: 'staff_view_member_billing',
          resourceType: 'invoices',
          resourceId: targetEmail,
          resourceName: targetEmail,
          details: { viewedBy: sessionEmail, targetEmail }
        });
      }
    }
    
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE LOWER(email) = $1',
      [targetEmail.toLowerCase()]
    );
    
    const stripeCustomerId = userResult.rows[0]?.stripe_customer_id;
    
    if (!stripeCustomerId) {
      return res.json({ invoices: [], count: 0 });
    }
    
    const result = await listCustomerInvoices(stripeCustomerId);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to list invoices' });
    }
    
    logger.info('[Stripe] my-invoices for : found invoices', { extra: { targetEmail, resultInvoices: result.invoices?.length || 0 } });
    
    res.json({
      invoices: result.invoices,
      count: result.invoices?.length || 0
    });
  } catch (error: unknown) {
    logger.error('[Stripe] Error listing member invoices', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

export default router;
