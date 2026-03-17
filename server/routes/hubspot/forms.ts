import { logger } from '../../core/logger';
import { Router } from 'express';
import { isProduction } from '../../core/db';
import { db } from '../../db';
import { formSubmissions } from '../../../shared/schema';
import { sql } from 'drizzle-orm';
import { notifyAllStaff } from '../../core/notificationService';
import { getSessionUser } from '../../types/session';

const router = Router();

const HUBSPOT_PORTAL_ID_DEFAULT = '244200670';
const VALID_FORM_TYPES = new Set([
  'membership', 'private-hire',
  'event-inquiry', 'guest-checkin', 'contact'
]);

router.post('/api/hubspot/forms/:formType', async (req, res) => {
  try {
    const { formType } = req.params;
    const portalId = process.env.HUBSPOT_PORTAL_ID || HUBSPOT_PORTAL_ID_DEFAULT;

    if (!VALID_FORM_TYPES.has(formType)) {
      logger.warn(`[HubSpot Forms] Rejected unknown form type: "${formType}"`);
      return res.status(400).json({ error: 'Invalid form type' });
    }

    const { resolveFormId } = await import('../../core/hubspot/formSync');
    const formId = await resolveFormId(formType);

    if (!formId) {
      logger.error(`[HubSpot Forms] No form ID resolved for form type "${formType}". Configure via Admin Settings, set HUBSPOT_FORM_${formType.toUpperCase().replace(/-/g, '_')} env var, or ensure form sync has discovered this form.`);
      return res.status(400).json({ error: 'Form configuration missing. Please contact support.' });
    }
    
    const { fields, context } = req.body;
    
    if (!Array.isArray(fields)) {
      return res.status(400).json({ error: 'Fields must be an array' });
    }
    
    for (const field of fields) {
      if (typeof field !== 'object' || field === null) {
        return res.status(400).json({ error: 'Each field must be an object' });
      }
      if (typeof field.name !== 'string' || field.name.length === 0 || field.name.length > 100) {
        return res.status(400).json({ error: 'Field name must be a non-empty string (max 100 chars)' });
      }
      if (typeof field.value !== 'string' || field.value.length > 5000) {
        return res.status(400).json({ error: 'Field value must be a string (max 5000 chars)' });
      }
    }
    
    if (context !== undefined && (typeof context !== 'object' || context === null)) {
      return res.status(400).json({ error: 'Context must be an object if provided' });
    }
    
    let guestCheckinMemberEmail: string | null = null;
    if (formType === 'guest-checkin') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser || !sessionUser.isStaff) {
        return res.status(401).json({ error: 'Authentication required. Guest check-in is a staff-only action.' });
      }

      const memberEmailField = fields.find((f: { name: string; value: string }) => f.name === 'member_email');
      if (!memberEmailField?.value) {
        return res.status(400).json({ error: 'Member email is required for guest check-in' });
      }
      
      guestCheckinMemberEmail = memberEmailField.value;
      
      const passCheck = await db.execute(sql`SELECT passes_used, passes_total FROM guest_passes WHERE member_email = ${guestCheckinMemberEmail}`);
      
      if (passCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Guest pass record not found. Please contact staff.' });
      }
      
      const passRow = passCheck.rows[0] as { passes_used: number; passes_total: number };
      if (passRow.passes_used >= passRow.passes_total) {
        return res.status(400).json({ error: 'No guest passes remaining. Please contact staff for assistance.' });
      }
    }
    
    const VALID_HUBSPOT_CONTACT_FIELDS = new Set([
      'firstname', 'lastname', 'email', 'phone', 'company', 'message',
      'membership_interest', 'event_type', 'guest_count',
      'eh_email_updates_opt_in',
      'event_date', 'event_time', 'additional_details', 'event_services',
      'topic',
      'guest_firstname', 'guest_lastname', 'guest_email', 'guest_phone',
      'member_name', 'member_email',
    ]);

    const hubspotFields: Array<{ name: string; value: string }> = [];

    for (const field of fields as Array<{ name: string; value: string }>) {
      if (field.name === 'marketing_consent') {
        hubspotFields.push({
          name: 'eh_email_updates_opt_in',
          value: field.value === 'Yes' ? 'true' : 'false',
        });
        continue;
      }

      if (field.name === 'membership_interest' && field.value === 'Not sure yet') {
        hubspotFields.push({ name: field.name, value: 'Not Sure Yet' });
        continue;
      }

      if (VALID_HUBSPOT_CONTACT_FIELDS.has(field.name)) {
        hubspotFields.push({ name: field.name, value: field.value });
      }
    }

    const hubspotPayload = {
      fields: hubspotFields.map((f) => ({
        objectTypeId: '0-1',
        name: f.name,
        value: f.value
      })),
      context: {
        pageUri: context?.pageUri || '',
        pageName: context?.pageName || '',
        ...(context?.hutk && { hutk: context.hutk })
      }
    };
    
    const response = await fetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hubspotPayload)
      }
    );
    
    if (!response.ok) {
      let errorData: unknown;
      try {
        errorData = await response.json();
      } catch {
        errorData = await response.text().catch(() => 'Unable to read response body');
      }
      logger.error(`[HubSpot Forms] Submission failed for form type "${formType}" (formId: ${formId}, portalId: ${portalId}, status: ${response.status})`, { extra: { errorData } });
      return res.status(response.status).json({ error: 'Form submission failed' });
    }

    if (guestCheckinMemberEmail) {
      const updateResult = await db.execute(sql`UPDATE guest_passes 
         SET passes_used = passes_used + 1 
         WHERE member_email = ${guestCheckinMemberEmail} AND passes_used < passes_total
         RETURNING passes_used, passes_total`);
      
      if (updateResult.rows.length === 0) {
        logger.warn('[Guest Check-in] HubSpot form submitted but guest pass deduction failed (pass may have been used concurrently)', {
          extra: { memberEmail: guestCheckinMemberEmail }
        });
      }
    }
    
    const result = await response.json() as Record<string, unknown>;
    
    const getFieldValue = (name: string): string | undefined => {
      const field = fields.find((f: { name: string; value: string }) => f.name === name);
      return field?.value;
    };
    
    try {
      const metadata: Record<string, string> = {};
      for (const field of fields) {
        if (!['firstname', 'lastname', 'email', 'phone', 'message'].includes(field.name)) {
          metadata[field.name] = field.value;
        }
      }
      
      const insertResult = await db.insert(formSubmissions).values({
        formType,
        firstName: getFieldValue('firstname') || getFieldValue('first_name') || null,
        lastName: getFieldValue('lastname') || getFieldValue('last_name') || null,
        email: getFieldValue('email') || '',
        phone: getFieldValue('phone') || null,
        message: getFieldValue('message') || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        status: 'new',
      }).returning();
      
      const formTypeLabels: Record<string, string> = {
        'membership': 'Membership Application',
        'private-hire': 'Private Hire Inquiry',
        'guest-checkin': 'Guest Check-in',
        'contact': 'Contact Form'
      };
      const formLabel = formTypeLabels[formType] || 'Form Submission';
      const submitterName = [getFieldValue('firstname') || getFieldValue('first_name'), getFieldValue('lastname') || getFieldValue('last_name')].filter(Boolean).join(' ') || getFieldValue('email') || 'Someone';
      const staffMessage = `${submitterName} submitted a ${formLabel}`;
      
      const notificationUrl = formType === 'membership' ? '/admin/applications' : '/admin/inquiries';
      const notificationRelatedType = formType === 'membership' ? 'application' : 'inquiry';
      
      notifyAllStaff(
        `New ${formLabel}`,
        staffMessage,
        'system',
        {
          relatedId: insertResult[0]?.id,
          relatedType: notificationRelatedType,
          url: notificationUrl
        }
      ).catch(err => logger.error('Staff inquiry notification failed:', { extra: { err } }));

    } catch (dbError: unknown) {
      logger.error('Failed to save form submission locally', { extra: { dbError } });
    }
    
    res.json({ success: true, message: result.inlineMessage || 'Form submitted successfully' });
  } catch (error: unknown) {
    if (!isProduction) logger.error('HubSpot form submission error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Form submission failed' });
  }
});

export default router;
