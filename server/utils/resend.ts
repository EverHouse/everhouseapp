import { Resend } from 'resend';
import { logger } from '../core/logger';

let connectionSettings: any;

const isDevelopment = process.env.NODE_ENV !== 'production' && !process.env.WEB_REPL_RENEWAL;

const ALLOWED_DEV_EMAILS = [
  '@evenhouse.club',
  'nicholasallanluu@gmail.com',
];

function isAllowedInDev(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  return ALLOWED_DEV_EMAILS.some(allowed => 
    allowed.startsWith('@') 
      ? lowerEmail.endsWith(allowed) 
      : lowerEmail === allowed
  );
}

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=resend',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key)) {
    throw new Error('Resend not connected');
  }
  return { apiKey: connectionSettings.settings.api_key, fromEmail: connectionSettings.settings.from_email };
}

export async function getResendClient(): Promise<{ client: Resend; fromEmail: string | null }> {
  const { apiKey, fromEmail } = await getCredentials();
  return {
    client: new Resend(apiKey),
    fromEmail: fromEmail || null
  };
}

export interface SafeSendOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

export async function safeSendEmail(options: SafeSendOptions): Promise<{ success: boolean; blocked?: boolean; id?: string }> {
  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  
  if (isDevelopment) {
    const blockedRecipients = recipients.filter(email => !isAllowedInDev(email));
    
    if (blockedRecipients.length > 0) {
      logger.warn('DEV MODE: Blocking email to non-allowed recipients', {
        extra: {
          blockedRecipients,
          subject: options.subject,
          allowedRecipients: recipients.filter(email => isAllowedInDev(email))
        }
      });
      
      const allowedRecipients = recipients.filter(email => isAllowedInDev(email));
      if (allowedRecipients.length === 0) {
        return { success: true, blocked: true };
      }
      
      options.to = allowedRecipients;
    }
  }
  
  try {
    const { client, fromEmail } = await getResendClient();
    const result = await client.emails.send({
      from: options.from || fromEmail || 'noreply@everclub.app',
      to: options.to,
      subject: options.subject,
      html: options.html,
      reply_to: options.replyTo
    });
    
    return { success: true, id: result.data?.id };
  } catch (error) {
    logger.error('Failed to send email', { 
      error: error as Error,
      extra: { subject: options.subject, to: options.to }
    });
    return { success: false };
  }
}

export function logDevEmailGuardStatus() {
  if (isDevelopment) {
    logger.info('DEV MODE: Email guard active - only sending to allowed addresses', {
      extra: { allowedPatterns: ALLOWED_DEV_EMAILS }
    });
  } else {
    logger.info('PRODUCTION MODE: All emails will be sent');
  }
}
