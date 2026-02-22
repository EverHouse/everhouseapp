import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { logger } from '../core/logger';
import { Webhook } from 'svix';

const router = Router();

interface ResendEmailEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    created_at?: string;
    [key: string]: unknown;
  };
}

async function ensureEmailEventsTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS email_events (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE,
      event_type VARCHAR(100) NOT NULL,
      email_id VARCHAR(255),
      recipient_email VARCHAR(255),
      subject VARCHAR(500),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      event_data JSONB,
      processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    
    CREATE INDEX IF NOT EXISTS idx_email_events_recipient ON email_events(recipient_email);
    CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_email_events_created ON email_events(created_at);
  `);
  
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_delivery_status VARCHAR(50) DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_bounced_at TIMESTAMP WITH TIME ZONE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_marketing_opt_in BOOLEAN DEFAULT true;
  `).catch((err) => { logger.warn('[Resend] Non-critical email tracking column migration failed:', err); });
}

async function initEmailEventsWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureEmailEventsTable();
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        logger.error('Failed to create email_events table after retries', { error: err });
        return;
      }
      const delay = Math.pow(2, attempt) * 1000;
      logger.info(`[Email Events] Table init failed (attempt ${attempt}/${maxRetries}), retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

initEmailEventsWithRetry();

async function handleEmailDelivered(event: ResendEmailEvent) {
  const { email_id, to, subject } = event.data;
  
  logger.info('Email delivered', {
    extra: {
      event: 'email.delivered',
      emailId: email_id,
      recipient: to[0],
      subject
    }
  });
}

async function handleEmailBounced(event: ResendEmailEvent) {
  const { email_id, to, subject } = event.data;
  const recipientEmail = to[0]?.toLowerCase();
  
  logger.warn('Email bounced', {
    extra: {
      event: 'email.bounced',
      emailId: email_id,
      recipient: recipientEmail,
      subject
    }
  });

  if (recipientEmail) {
    try {
      await db.execute(sql`
        UPDATE users 
        SET 
          email_delivery_status = 'bounced',
          email_bounced_at = NOW(),
          notes = COALESCE(notes, '') || E'\n[' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '] Email bounced - may need to update contact info'
        WHERE LOWER(email) = ${recipientEmail}
      `);
      
      logger.info('Marked user email as bounced', {
        extra: { email: recipientEmail }
      });
    } catch (err: unknown) {
      logger.error('Failed to update user bounce status', { error: err as Error });
    }
  }
}

async function handleEmailComplained(event: ResendEmailEvent) {
  const { email_id, to, subject } = event.data;
  const recipientEmail = to[0]?.toLowerCase();
  
  logger.warn('Email complaint received', {
    extra: {
      event: 'email.complained',
      emailId: email_id,
      recipient: recipientEmail,
      subject
    }
  });

  if (recipientEmail) {
    try {
      await db.execute(sql`
        UPDATE users 
        SET 
          email_delivery_status = 'complained',
          email_marketing_opt_in = false,
          notes = COALESCE(notes, '') || E'\n[' || TO_CHAR(NOW(), 'YYYY-MM-DD') || '] Marked email as spam - unsubscribed from marketing'
        WHERE LOWER(email) = ${recipientEmail}
      `);
      
      logger.info('Unsubscribed user after complaint', {
        extra: { email: recipientEmail }
      });
    } catch (err: unknown) {
      logger.error('Failed to update user complaint status', { error: err as Error });
    }
  }
}

async function handleEmailDeliveryDelayed(event: ResendEmailEvent) {
  const { email_id, to, subject } = event.data;
  
  logger.warn('Email delivery delayed', {
    extra: {
      event: 'email.delivery_delayed',
      emailId: email_id,
      recipient: to[0],
      subject
    }
  });
}

router.post('/api/webhooks/resend', async (req: Request, res: Response) => {
  const svixHeaders = {
    'svix-id': req.headers['svix-id'] as string,
    'svix-timestamp': req.headers['svix-timestamp'] as string,
    'svix-signature': req.headers['svix-signature'] as string,
  };

  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (webhookSecret) {
    try {
      const wh = new Webhook(webhookSecret);
      const rawBody = JSON.stringify(req.body);
      wh.verify(rawBody, svixHeaders);
    } catch (err: unknown) {
      logger.warn('Resend webhook signature verification failed', {
        error: err as Error
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (isProduction) {
    logger.error('RESEND_WEBHOOK_SECRET is not configured in production — rejecting webhook request');
    return res.status(500).json({ error: 'Webhook signature verification is not configured' });
  } else {
    logger.warn('RESEND_WEBHOOK_SECRET is not configured — skipping signature verification (development mode)');
  }

  const event = req.body as ResendEmailEvent;
  
  if (!event || !event.type) {
    return res.status(400).json({ error: 'Invalid event payload' });
  }

  try {
    const eventId = svixHeaders['svix-id'] || `${event.type}-${event.data?.email_id}-${Date.now()}`;
    const recipientEmail = event.data?.to?.[0] || null;

    const insertResult = await db.execute(sql`
      INSERT INTO email_events (event_id, event_type, email_id, recipient_email, subject, event_data)
      VALUES (${eventId}, ${event.type}, ${event.data?.email_id || null}, ${recipientEmail}, ${event.data?.subject || null}, ${JSON.stringify(event.data)})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `);

    if (insertResult.rowCount === 0) {
      logger.info('Duplicate Resend webhook event ignored', {
        extra: { eventId, eventType: event.type }
      });
      return res.status(200).json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case 'email.delivered':
        await handleEmailDelivered(event);
        break;
      case 'email.bounced':
        await handleEmailBounced(event);
        break;
      case 'email.complained':
        await handleEmailComplained(event);
        break;
      case 'email.delivery_delayed':
        await handleEmailDeliveryDelayed(event);
        break;
      default:
        logger.info('Unhandled Resend event type', {
          extra: { eventType: event.type }
        });
    }

    res.status(200).json({ received: true });
  } catch (error: unknown) {
    logger.error('Failed to process Resend webhook', {
      error: error as Error,
      extra: { eventType: event.type }
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/webhooks/resend/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', endpoint: '/api/webhooks/resend' });
});

export default router;
