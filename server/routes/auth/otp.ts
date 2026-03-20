import { logger } from '../../core/logger';
import { Router } from 'express';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, magicLinks, staffUsers } from '../../../shared/schema';
import { isProduction } from '../../core/db';
import { getHubSpotClient } from '../../core/integrations';
import { retryableHubSpotRequest } from '../../core/hubspot/request';
import { normalizeTierName } from '../../../shared/constants/tiers';
import { getResendClient } from '../../utils/resend';
import { withResendRetry } from '../../core/retryUtils';
import { getSessionUser, SessionUser } from '../../types/session';
import { sendWelcomeEmail } from '../../emails/welcomeEmail';
import { normalizeEmail, getAlternateDomainEmail } from '../../core/utils/emailNormalization';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts';
import { getErrorMessage } from '../../utils/errorUtils';
import { getOtpEmailHtml } from '../../emails/otpEmail';
import { authRateLimiter } from '../../middleware/rateLimiting';
import {
  getStaffUserByEmail,
  getUserRole,
  isStaffOrAdminEmail,
  upsertUserWithTier,
  createSupabaseToken,
} from './helpers';
import {
  checkOtpRequestLimit,
  checkOtpVerifyAttempts,
  recordOtpVerifyFailure,
  clearOtpVerifyAttempts,
} from './rateLimiting';

export const otpRouter = Router();

// PUBLIC ROUTE - verify if email is a member (used before login to route user)
otpRouter.post('/api/auth/verify-member', ...authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    
    const staffUserData = await getStaffUserByEmail(normalizedEmail);
    const isStaffOrAdmin = staffUserData !== null;
    
    const dbUser = await db.select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
      tier: users.tier,
      tags: users.tags,
      membershipStatus: users.membershipStatus,
      stripeSubscriptionId: users.stripeSubscriptionId,
      stripeCustomerId: users.stripeCustomerId,
      mindbodyClientId: users.mindbodyClientId,
      hubspotId: users.hubspotId,
      role: users.role,
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
      .limit(1);
    
    const hasDbUser = dbUser.length > 0;
    const isVisitorUser = hasDbUser && dbUser[0].role === 'visitor';
    const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
    
    if (hasDbUser && isStripeBilled && !isStaffOrAdmin) {
      let dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      
      if (!activeStatuses.includes(dbMemberStatus) && dbUser[0].stripeSubscriptionId) {
        try {
          const { getStripeClient } = await import('../../core/stripe/client');
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(dbUser[0].stripeSubscriptionId);
          
          const stripeActiveStatuses = ['active', 'trialing', 'past_due'];
          if (stripeActiveStatuses.includes(subscription.status)) {
            await db.update(users).set({ membershipStatus: subscription.status, updatedAt: new Date() }).where(eq(users.id, dbUser[0].id));
            logger.info('[Auth] Auto-fixed membership_status for : ->', { extra: { normalizedEmail, dbMemberStatus, subscriptionStatus: subscription.status } });
            dbMemberStatus = subscription.status;
            
            try {
              const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              logger.info('[Auth] Synced auto-fixed status to HubSpot for', { extra: { normalizedEmail } });
            } catch (hubspotError: unknown) {
              logger.error('[Auth] HubSpot sync failed for auto-fix', { error: getErrorMessage(hubspotError) });
            }
          } else {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: unknown) {
          logger.error('[Auth] Failed to verify Stripe subscription', { error: getErrorMessage(stripeError), extra: { email: normalizedEmail } });
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      } else if (!activeStatuses.includes(dbMemberStatus)) {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
      
      const statusMap: { [key: string]: string } = {
        'active': 'Active',
        'trialing': 'Trialing',
        'past_due': 'Past Due',
        'suspended': 'Suspended',
        'terminated': 'Terminated',
        'expired': 'Expired',
        'cancelled': 'Cancelled',
        'frozen': 'Frozen',
        'paused': 'Paused',
        'pending': 'Pending'
      };
      let memberFirstName = dbUser[0].firstName || '';
      let memberLastName = dbUser[0].lastName || '';

      if (!memberFirstName) {
        try {
          const hubspotClient = await getHubSpotClient();
          const hsSearch = await hubspotClient.crm.contacts.searchApi.doSearch({
            filterGroups: [{ filters: [{ propertyName: 'email', operator: FilterOperatorEnum.Eq, value: normalizedEmail }] }],
            properties: ['firstname', 'lastname'],
            limit: 1
          });
          const hsContact = hsSearch.results[0];
          if (hsContact?.properties?.firstname) {
            memberFirstName = hsContact.properties.firstname;
            memberLastName = memberLastName || hsContact.properties.lastname || '';
            await db.update(users).set({
              firstName: memberFirstName,
              lastName: memberLastName || undefined,
              updatedAt: new Date()
            }).where(eq(users.id, dbUser[0].id));
          }
        } catch (hsErr: unknown) {
          logger.warn('[Auth] HubSpot name backfill failed during verify-member', { error: hsErr instanceof Error ? hsErr : new Error(String(hsErr)) });
        }
      }

      const member = {
        id: dbUser[0].id,
        firstName: memberFirstName,
        lastName: memberLastName,
        email: dbUser[0].email || normalizedEmail,
        phone: dbUser[0].phone || '',
        jobTitle: '',
        tier: isVisitorUser ? null : (normalizeTierName(dbUser[0].tier) || null),
        tags: dbUser[0].tags || [],
        mindbodyClientId: dbUser[0].mindbodyClientId || '',
        status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
        role: (isVisitorUser ? 'visitor' : 'member') as 'member' | 'visitor'
      };
      
      return res.json({ success: true, member });
    }
    
    const hubspot = await getHubSpotClient();
    
    const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: normalizedEmail
        }]
      }],
      properties: [
        'firstname',
        'lastname',
        'email',
        'phone',
        'membership_tier',
        'membership_status',
        'membership_discount_reason',
        'mindbody_client_id'
      ],
      limit: 1
    }));
    
    const contact = searchResponse.results[0];
    
    if (!contact && !isStaffOrAdmin) {
      if (!isStripeBilled) {
        return res.status(404).json({ error: 'No member found with this email address' });
      }
    }
    
    if (!isStaffOrAdmin && !isStripeBilled && contact) {
      const status = (contact.properties.membership_status || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      if (!activeStatuses.includes(status) && status !== '') {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
    }
    
    const role = isStaffOrAdmin ? staffUserData!.role : (isVisitorUser ? 'visitor' : 'member');

    let firstName = dbUser[0]?.firstName || contact?.properties?.firstname || '';
    let lastName = dbUser[0]?.lastName || contact?.properties?.lastname || '';
    let phone = dbUser[0]?.phone || contact?.properties?.phone || '';
    let jobTitle = '';

    if (hasDbUser && !dbUser[0]?.firstName && firstName) {
      try {
        await db.update(users).set({
          firstName: firstName,
          lastName: lastName || undefined,
          updatedAt: new Date()
        }).where(eq(users.id, dbUser[0].id));
      } catch (backfillErr: unknown) {
        logger.warn('[Auth] Name backfill from HubSpot failed during verify-member', { error: backfillErr instanceof Error ? backfillErr : new Error(String(backfillErr)) });
      }
    }

    if (isStaffOrAdmin && staffUserData) {
      firstName = staffUserData.firstName || firstName;
      lastName = staffUserData.lastName || lastName;
      phone = staffUserData.phone || phone;
      jobTitle = staffUserData.jobTitle || '';
    }

    const memberId = dbUser[0]?.id 
      || contact?.id 
      || (isStaffOrAdmin && staffUserData ? `staff-${staffUserData.id}` : crypto.randomUUID());
    
    const statusMap: { [key: string]: string } = {
      'active': 'Active',
      'trialing': 'Trialing',
      'past_due': 'Past Due',
      'suspended': 'Suspended',
      'terminated': 'Terminated',
      'expired': 'Expired',
      'cancelled': 'Cancelled',
      'frozen': 'Frozen',
      'paused': 'Paused',
      'pending': 'Pending'
    };
    const memberStatusStr = isStaffOrAdmin ? 'active' : ((dbUser[0]?.membershipStatus || contact?.properties?.membership_status || '').toLowerCase());
    
    const member = {
      id: memberId,
      firstName,
      lastName,
      email: dbUser[0]?.email || contact?.properties?.email || normalizedEmail,
      phone,
      jobTitle,
      tier: isVisitorUser ? null : (isStaffOrAdmin ? 'VIP' : (normalizeTierName(dbUser[0]?.tier || contact?.properties?.membership_tier) || null)),
      tags: dbUser[0]?.tags || [],
      mindbodyClientId: dbUser[0]?.mindbodyClientId || contact?.properties?.mindbody_client_id || '',
      status: statusMap[memberStatusStr] || (memberStatusStr ? memberStatusStr.charAt(0).toUpperCase() + memberStatusStr.slice(1) : 'Active'),
      role
    };
    
    res.json({ success: true, member });
  } catch (error: unknown) {
    logger.error('Member verification error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to verify membership' });
  }
});

import crypto from 'crypto';

// PUBLIC ROUTE - send one-time password to email (no auth required)
otpRouter.post('/api/auth/request-otp', ...authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = normalizeEmail(email);
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    
    const rateCheck = await checkOtpRequestLimit(normalizedEmail, clientIp);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many code requests. Please try again in ${Math.ceil((rateCheck.retryAfter || 0) / 60)} minutes.` 
      });
    }
    
    const isStaffOrAdmin = await isStaffOrAdminEmail(normalizedEmail);
    
    const dbUser = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    const hasDbUser = dbUser.length > 0;
    const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
    
    let firstName = isStaffOrAdmin ? 'Team Member' : 'Member';
    
    if (hasDbUser && isStripeBilled && !isStaffOrAdmin) {
      const dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
      const activeStatuses = ['active', 'trialing', 'past_due'];
      
      if (!activeStatuses.includes(dbMemberStatus) && dbUser[0].stripeSubscriptionId) {
        try {
          const { getStripeClient } = await import('../../core/stripe/client');
          const stripe = await getStripeClient();
          const subscription = await stripe.subscriptions.retrieve(dbUser[0].stripeSubscriptionId);
          
          const stripeActiveStatuses = ['active', 'trialing', 'past_due'];
          if (stripeActiveStatuses.includes(subscription.status)) {
            await db.update(users).set({ membershipStatus: subscription.status, updatedAt: new Date() }).where(eq(users.id, dbUser[0].id));
            logger.info('[Auth] Auto-fixed membership_status for : ->', { extra: { normalizedEmail, dbMemberStatus, subscriptionStatus: subscription.status } });
            
            try {
              const { syncMemberToHubSpot } = await import('../../core/hubspot/stages');
              await syncMemberToHubSpot({ email: normalizedEmail, status: subscription.status, billingProvider: 'stripe' });
              logger.info('[Auth] Synced auto-fixed status to HubSpot for', { extra: { normalizedEmail } });
            } catch (hubspotError: unknown) {
              logger.error('[Auth] HubSpot sync failed for auto-fix', { extra: { error: getErrorMessage(hubspotError) } });
            }
          } else {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        } catch (stripeError: unknown) {
          logger.error('[Auth] Failed to verify Stripe subscription status', { error: getErrorMessage(stripeError), extra: { email: normalizedEmail } });
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      } else if (!activeStatuses.includes(dbMemberStatus)) {
        return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
      }
      
      if (dbUser[0].firstName) {
        firstName = dbUser[0].firstName;
      }
    } else if (!isStaffOrAdmin) {
      const hubspot = await getHubSpotClient();
      
      const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'email',
            operator: FilterOperatorEnum.Eq,
            value: normalizedEmail
          }]
        }],
        properties: ['firstname', 'lastname', 'membership_status', 'email'],
        limit: 1
      }));
      
      const contact = searchResponse.results[0];
      
      if (!contact && !isStripeBilled) {
        return res.status(404).json({ error: 'No member found with this email address' });
      }
      
      if (!isStripeBilled && contact) {
        const status = (contact.properties.membership_status || '').toLowerCase();
        const activeStatuses = ['active', 'trialing', 'past_due'];
        if (!activeStatuses.includes(status) && status !== '') {
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
      }
      
      if (contact?.properties?.firstname) {
        firstName = contact.properties.firstname;
      } else if (hasDbUser && dbUser[0].firstName) {
        firstName = dbUser[0].firstName;
      }
    } else if (isStaffOrAdmin) {
      const staffUser = await getStaffUserByEmail(normalizedEmail);
      if (staffUser?.firstName) {
        firstName = staffUser.firstName;
      }
    }
    
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    
    await db.insert(magicLinks).values({
      email: normalizedEmail,
      token: otpCode,
      expiresAt,
      used: false
    });
    
    const { client: resendClient, fromEmail: resendFrom } = await getResendClient();
    
    const emailHtml = getOtpEmailHtml({ code: otpCode, firstName, logoUrl: 'https://everclub.app/images/everclub-logo-dark.png' });
    
    await withResendRetry(() => resendClient.emails.send({
      from: resendFrom,
      to: normalizedEmail,
      subject: `${otpCode} - Your Ever Club Login Code`,
      html: emailHtml
    }));
    
    logger.info('[Auth] OTP sent to', { extra: { normalizedEmail } });
    
    res.json({ success: true, message: 'Login code sent' });
  } catch (error: unknown) {
    const errorMsg = getErrorMessage(error);
    logger.error('OTP request error', { extra: { error: errorMsg } });
    
    if (errorMsg.includes('HubSpot') || errorMsg.includes('hubspot')) {
      return res.status(500).json({ error: 'Unable to verify membership. Please try again later.' });
    }
    if (errorMsg.includes('Resend') || errorMsg.includes('email')) {
      return res.status(500).json({ error: 'Unable to send email. Please try again later.' });
    }
    
    res.status(500).json({ error: 'Failed to send login code. Please try again.' });
  }
});

// PUBLIC ROUTE - verify OTP and create session (no auth required)
otpRouter.post('/api/auth/verify-otp', ...authRateLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }
    
    let normalizedEmail = normalizeEmail(email);
    const normalizedCode = code.toString().trim();
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    
    const attemptCheck = await checkOtpVerifyAttempts(normalizedEmail, clientIp);
    if (!attemptCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many failed attempts. Please try again in ${Math.ceil((attemptCheck.retryAfter || 0) / 60)} minutes.` 
      });
    }
    
    const atomicResult = await db.execute(sql`WITH latest_token AS (
        SELECT id FROM magic_links
        WHERE email = ${normalizedEmail}
        AND token = ${normalizedCode}
        AND used = false
        AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      )
      UPDATE magic_links
      SET used = true
      WHERE id = (SELECT id FROM latest_token)
      RETURNING *`);
    
    if (atomicResult.rows.length === 0) {
      await recordOtpVerifyFailure(normalizedEmail, clientIp);
      return res.status(400).json({ 
        error: 'Invalid or expired code. Please try again or request a new code.'
      });
    }
    
    await clearOtpVerifyAttempts(normalizedEmail, clientIp);
    
    const _otpRecord = atomicResult.rows[0];
    
    const role = await getUserRole(normalizedEmail);
    const sessionTtl = 30 * 24 * 60 * 60 * 1000;
    
    let member: SessionUser | undefined;
    let shouldSetupPassword = false;
    
    if (role === 'admin' || role === 'staff') {
      const staffUserData = await getStaffUserByEmail(normalizedEmail);
      
      if (!staffUserData) {
        return res.status(404).json({ error: 'Staff user not found' });
      }
      
      const alternateStaffEmail = getAlternateDomainEmail(normalizedEmail);
      const staffEmailsToCheck = alternateStaffEmail ? [normalizedEmail, alternateStaffEmail] : [normalizedEmail];
      const pwCheck = await db.select({ passwordHash: staffUsers.passwordHash })
        .from(staffUsers)
        .where(and(
          sql`LOWER(${staffUsers.email}) IN (${sql.join(staffEmailsToCheck.map(e => sql`LOWER(${e})`), sql`, `)})`,
          eq(staffUsers.isActive, true)
        ))
        .limit(1);
      
      shouldSetupPassword = pwCheck.length > 0 && !pwCheck[0].passwordHash;
      
      member = {
        id: `staff-${staffUserData.id}`,
        firstName: staffUserData.firstName,
        lastName: staffUserData.lastName,
        email: staffUserData.email,
        phone: staffUserData.phone,
        tier: 'VIP',
        tags: [],
        mindbodyClientId: '',
        status: 'Active',
        role,
        expires_at: Date.now() + sessionTtl
      };
    } else {
      const { resolveUserByEmail } = await import('../../core/stripe/customers');
      const resolvedLogin = await resolveUserByEmail(normalizedEmail);
      if (resolvedLogin && resolvedLogin.matchType !== 'direct') {
        logger.info('[Auth] Login email resolved to existing user via', { extra: { normalizedEmail, resolvedLoginPrimaryEmail: resolvedLogin.primaryEmail, resolvedLoginMatchType: resolvedLogin.matchType } });
        normalizedEmail = resolvedLogin.primaryEmail.toLowerCase();
      }

      const dbUser = await db.select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        tier: users.tier,
        tags: users.tags,
        membershipStatus: users.membershipStatus,
        stripeSubscriptionId: users.stripeSubscriptionId,
        stripeCustomerId: users.stripeCustomerId,
        mindbodyClientId: users.mindbodyClientId,
        joinDate: users.joinDate,
        dateOfBirth: users.dateOfBirth,
      })
        .from(users)
        .where(sql`LOWER(${users.email}) = LOWER(${normalizedEmail})`)
        .limit(1);
      
      const hasDbUser = dbUser.length > 0;
      const isStripeBilled = hasDbUser && (dbUser[0].stripeSubscriptionId || dbUser[0].stripeCustomerId);
      
      if (hasDbUser && isStripeBilled) {
        const dbMemberStatus = (dbUser[0].membershipStatus || '').toLowerCase();
        const activeStatuses = ['active', 'trialing', 'past_due'];
        
        if (!activeStatuses.includes(dbMemberStatus)) {
          return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
        }
        
        const statusMap: { [key: string]: string } = {
          'active': 'Active',
          'trialing': 'Trialing',
          'past_due': 'Past Due',
          'suspended': 'Suspended',
          'terminated': 'Terminated',
          'expired': 'Expired',
          'cancelled': 'Cancelled',
          'frozen': 'Frozen',
          'paused': 'Paused',
          'pending': 'Pending'
        };
        member = {
          id: dbUser[0].id,
          firstName: dbUser[0].firstName || '',
          lastName: dbUser[0].lastName || '',
          email: dbUser[0].email || normalizedEmail,
          phone: dbUser[0].phone || '',
          tier: role === 'visitor' ? undefined : (normalizeTierName(dbUser[0].tier) || null),
          tags: (dbUser[0].tags || []) as string[],
          mindbodyClientId: dbUser[0].mindbodyClientId || '',
          status: statusMap[dbMemberStatus] || (dbMemberStatus ? dbMemberStatus.charAt(0).toUpperCase() + dbMemberStatus.slice(1) : 'Active'),
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: dbUser[0].dateOfBirth || null
        };
      } else {
        const hubspot = await getHubSpotClient();
        
        const searchResponse = await retryableHubSpotRequest(() => hubspot.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.Eq,
              value: normalizedEmail
            }]
          }],
          properties: ['firstname', 'lastname', 'email', 'phone', 'membership_tier', 'membership_status', 'membership_discount_reason', 'mindbody_client_id', 'membership_start_date', 'date_of_birth'],
          limit: 1
        }));
        
        const contact = searchResponse.results[0];
        
        if (!contact) {
          if (!isStripeBilled) {
            return res.status(404).json({ error: 'Member not found' });
          }
        }
        
        if (!isStripeBilled && contact) {
          const hubspotStatus = (contact.properties.membership_status || '').toLowerCase();
          const activeStatuses = ['active', 'trialing', 'past_due'];
          if (!activeStatuses.includes(hubspotStatus) && hubspotStatus !== '') {
            return res.status(403).json({ error: 'Your membership is not active. Please contact us for assistance.' });
          }
        }
        
        const tags = hasDbUser ? (dbUser[0].tags || []) : [];
        
        const statusMap: { [key: string]: string } = {
          'active': 'Active',
          'trialing': 'Trialing',
          'past_due': 'Past Due',
          'suspended': 'Suspended',
          'terminated': 'Terminated',
          'expired': 'Expired',
          'cancelled': 'Cancelled',
          'frozen': 'Frozen',
          'paused': 'Paused',
          'pending': 'Pending'
        };
        const memberStatusStr = (hasDbUser ? dbUser[0].membershipStatus : contact?.properties?.membership_status || '' as string | null)?.toLowerCase() || '';
        
        member = {
          id: hasDbUser ? dbUser[0].id : (contact?.id || crypto.randomUUID()),
          firstName: (hasDbUser ? dbUser[0].firstName : contact?.properties?.firstname) || '',
          lastName: (hasDbUser ? dbUser[0].lastName : contact?.properties?.lastname) || '',
          email: (hasDbUser ? dbUser[0].email : contact?.properties?.email) || normalizedEmail,
          phone: (hasDbUser ? dbUser[0].phone : contact?.properties?.phone) || '',
          tier: role === 'visitor' ? undefined : (normalizeTierName(hasDbUser ? dbUser[0].tier : contact?.properties?.membership_tier) || null),
          tags: tags as string[],
          mindbodyClientId: (hasDbUser ? dbUser[0].mindbodyClientId : contact?.properties?.mindbody_client_id) || '',
          status: statusMap[memberStatusStr] || (memberStatusStr ? memberStatusStr.charAt(0).toUpperCase() + memberStatusStr.slice(1) : 'Active'),
          role,
          expires_at: Date.now() + sessionTtl,
          dateOfBirth: (hasDbUser ? dbUser[0].dateOfBirth : contact?.properties?.date_of_birth) || null,
          membershipStartDate: (hasDbUser ? dbUser[0].joinDate : contact?.properties?.membership_start_date) || ''
        };
      }
    }
    
    if (!member) {
      return res.status(500).json({ error: 'Failed to resolve member identity' });
    }

    req.session.user = member;

    const supabaseToken = await createSupabaseToken(member as unknown as { id: string; email: string; role: string; firstName?: string; lastName?: string });
    
    const dbUserId = await upsertUserWithTier({
      email: member.email,
      tierName: member.tier ?? '',
      firstName: member.firstName,
      lastName: member.lastName,
      phone: member.phone,
      mindbodyClientId: member.mindbodyClientId,
      tags: member.tags || [],
      membershipStartDate: member.membershipStartDate || '',
      role
    });
    
    if (dbUserId && dbUserId !== member.id) {
      member.id = dbUserId;
      req.session.user = member;
    }
    
    db.execute(sql`UPDATE users SET first_login_at = NOW(), updated_at = NOW() WHERE LOWER(email) = LOWER(${member.email}) AND first_login_at IS NULL`).catch((err) => logger.warn('[Auth] Non-critical first_login_at update failed:', { extra: { error: getErrorMessage(err) } }));

    (async () => {
      try {
        if (member.role === 'member') {
          const claimed = await db.execute(sql`
            UPDATE users
            SET welcome_email_sent = true, welcome_email_sent_at = NOW(), updated_at = NOW()
            WHERE LOWER(email) = LOWER(${member.email})
              AND (welcome_email_sent IS NULL OR welcome_email_sent = false)
            RETURNING id
          `);
          if (claimed.rows.length > 0) {
            const result = await sendWelcomeEmail(member.email, member.firstName);
            if (!result.success) {
              await db.execute(sql`
                UPDATE users SET welcome_email_sent = false, welcome_email_sent_at = NULL, updated_at = NOW()
                WHERE LOWER(email) = LOWER(${member.email})
              `);
              logger.warn('[Welcome Email] Send failed, reset flag for retry', { email: member.email });
            }
          }
        }
      } catch (error: unknown) {
        logger.error('[Welcome Email] Error checking/sending', { error: getErrorMessage(error) });
      }
    })().catch(err => logger.error('[Welcome Email] Unhandled async error', { error: getErrorMessage(err) }));
    
    req.session.save((err) => {
      if (err) {
        logger.error('Session save error', { extra: { error: getErrorMessage(err) } });
        return res.status(500).json({ error: 'Failed to create session' });
      }
      res.json({ success: true, member, shouldSetupPassword, supabaseToken });
    });
  } catch (error: unknown) {
    logger.error('OTP verification error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to verify code' });
  }
});
