import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { notifyAllStaff } from '../core/notificationService';
import { getResendClient } from '../utils/resend';
import {logAndRespond, logger } from '../core/logger';
import { isAuthenticated } from '../core/middleware';

const router = Router();

router.post('/api/account/delete-request', isAuthenticated, async (req: Request, res: Response) => {
  const userEmail = req.session?.user?.email;

  try {
    const userResult = await db.execute(sql`SELECT id, email, first_name, last_name FROM users WHERE LOWER(email) = LOWER(${userEmail})`
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.email;

    const existingRequest = await db.execute(sql`SELECT id FROM account_deletion_requests 
       WHERE user_id = ${user.id} AND status = 'pending'`
    );
    
    if (existingRequest.rows.length > 0) {
      return res.status(400).json({ 
        error: 'You already have a pending deletion request. Our team will process it shortly.' 
      });
    }

    await db.execute(sql`INSERT INTO account_deletion_requests (user_id, email, requested_at, status)
       SELECT ${user.id}, ${user.email}, NOW(), 'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM account_deletion_requests 
         WHERE user_id = ${user.id} AND status = 'pending'
       )`
    );

    await notifyAllStaff(
      'Account Deletion Request',
      `${userName} (${user.email}) has requested account deletion`,
      'account_deletion'
    );

    try {
      const { client, fromEmail } = await getResendClient();
      await client.emails.send({
        from: fromEmail,
        to: user.email,
        subject: 'Account Deletion Request Received',
        html: `
          <p>Hello ${user.first_name || 'Member'},</p>
          <p>We've received your request to delete your Ever Club account.</p>
          <p>Our team will process this request within 7 business days. You will receive a confirmation email once your account has been deleted.</p>
          <p>If you did not make this request or have changed your mind, please contact us immediately at <a href="mailto:info@everclub.app">info@everclub.app</a>.</p>
          <p>Thank you for being a part of the Ever Club community.</p>
          <p>Best regards,<br>The Ever Club Team</p>
        `
      });
    } catch (emailError: unknown) {
      logger.warn('[Account] Failed to send deletion confirmation email (non-blocking)', { extra: { emailError } });
    }

    logger.info('[Account] Deletion request submitted for', { extra: { userEmail: user.email } });
    
    return res.json({ 
      success: true,
      message: 'Your deletion request has been submitted. Our team will process it within 7 business days.'
    });
  } catch (error: unknown) {
    return logAndRespond(req, res, 500, 'Failed to submit deletion request', error);
  }
});

export default router;
