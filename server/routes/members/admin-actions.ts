import { Router } from 'express';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '../../db';
import { users, membershipTiers, wellnessEnrollments, eventRsvps, staffUsers } from '../../../shared/schema';
import { isProduction, pool } from '../../core/db';
import { isStaffOrAdmin, isAdmin } from '../../core/middleware';
import { getSessionUser } from '../../types/session';
import { TIER_NAMES } from '../../../shared/constants/tiers';
import { getTierRank } from './helpers';
import { createMemberLocally, queueMemberCreation, getAllDiscountRules, handleTierChange } from '../../core/hubspot';
import { changeSubscriptionTier, pauseSubscription } from '../../core/stripe';
import { notifyMember } from '../../core/notificationService';
import { cascadeEmailChange, previewEmailChangeImpact } from '../../core/memberService/emailChangeService';
import { getAvailableTiersForChange, previewTierChange, commitTierChange } from '../../core/stripe/tierChanges';
import { logFromRequest } from '../../core/auditLog';

const router = Router();

router.patch('/api/members/:email/tier', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { tier, immediate = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!tier || typeof tier !== 'string') {
      return res.status(400).json({ error: 'Tier is required' });
    }
    
    if (!TIER_NAMES.includes(tier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')}` });
    }
    
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      tier: users.tier,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    const actualTier = member.tier;
    const oldTierDisplay = actualTier || 'Social';
    
    if (actualTier === tier) {
      return res.json({ 
        success: true, 
        message: 'Member is already on this tier',
        member: { id: member.id, email: member.email, tier }
      });
    }
    
    await db.update(users)
      .set({ tier, updatedAt: new Date() })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';
    
    const hubspotResult = await handleTierChange(
      normalizedEmail,
      oldTierDisplay,
      tier,
      performedBy,
      performedByName
    );
    
    if (!hubspotResult.success && hubspotResult.error) {
      console.warn(`[Members] HubSpot tier change failed for ${normalizedEmail}: ${hubspotResult.error}`);
    }
    
    let stripeSync = { success: true, warning: null as string | null };
    
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      const tierRecord = await db.select()
        .from(membershipTiers)
        .where(eq(membershipTiers.name, tier))
        .limit(1);
      
      if (tierRecord.length > 0 && tierRecord[0].stripePriceId) {
        const isUpgrade = getTierRank(tier) > getTierRank(oldTierDisplay);
        const stripeResult = await changeSubscriptionTier(
          member.stripeSubscriptionId,
          tierRecord[0].stripePriceId,
          immediate || isUpgrade
        );
        
        if (!stripeResult.success) {
          stripeSync = { success: false, warning: `Stripe update failed: ${stripeResult.error}. Manual billing adjustment may be needed.` };
        }
      } else {
        stripeSync = { success: true, warning: 'Tier updated but Stripe price not configured. Billing unchanged.' };
      }
    } else if (member.billingProvider === 'mindbody') {
      stripeSync = { success: true, warning: 'Tier updated in App & HubSpot. PLEASE UPDATE MINDBODY BILLING MANUALLY.' };
    }
    
    const isUpgrade = getTierRank(tier) > getTierRank(oldTierDisplay);
    const changeType = isUpgrade ? 'upgraded' : 'changed';
    await notifyMember({
      userEmail: normalizedEmail,
      title: isUpgrade ? 'Membership Upgraded' : 'Membership Updated',
      message: `Your membership has been ${changeType} from ${oldTierDisplay} to ${tier}`,
      type: 'system',
      url: '/#/profile'
    });
    
    res.json({
      success: true,
      message: `Member tier updated from ${oldTierDisplay} to ${tier}`,
      member: {
        id: member.id,
        email: member.email,
        tier,
        previousTier: oldTierDisplay
      },
      hubspotSync: {
        success: hubspotResult.success,
        oldLineItemRemoved: hubspotResult.oldLineItemRemoved,
        newLineItemAdded: hubspotResult.newLineItemAdded
      },
      stripeSync,
      warning: stripeSync.warning
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member tier update error:', error);
    res.status(500).json({ error: 'Failed to update member tier' });
  }
});

router.post('/api/members/:id/suspend', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, durationDays, reason } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!startDate || !durationDays) {
      return res.status(400).json({ error: 'startDate and durationDays are required' });
    }
    
    const start = new Date(startDate);
    const now = new Date();
    const daysUntilStart = (start.getTime() - now.getTime()) / (1000 * 3600 * 24);
    
    if (daysUntilStart < 30) {
      return res.status(400).json({ 
        error: 'Suspension requests must be made at least 30 days in advance.' 
      });
    }
    
    const userResult = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      billingProvider: users.billingProvider,
      stripeSubscriptionId: users.stripeSubscriptionId,
      membershipStatus: users.membershipStatus
    })
      .from(users)
      .where(eq(users.id, id));
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const member = userResult[0];
    
    if (member.billingProvider === 'mindbody') {
      await db.update(users)
        .set({ membershipStatus: 'suspended', updatedAt: new Date() })
        .where(eq(users.id, id));
      
      return res.json({ 
        success: true, 
        warning: 'Member marked suspended in App/HubSpot. PLEASE PAUSE BILLING IN MINDBODY MANUALLY.',
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    if (member.billingProvider === 'stripe' && member.stripeSubscriptionId) {
      const result = await pauseSubscription(member.stripeSubscriptionId, parseInt(durationDays), start);
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || 'Failed to pause subscription' });
      }
      
      await db.update(users)
        .set({ membershipStatus: 'suspended', updatedAt: new Date() })
        .where(eq(users.id, id));
      
      await notifyMember({
        userEmail: member.email || '',
        title: 'Membership Paused',
        message: `Your membership has been paused for ${durationDays} days starting ${start.toLocaleDateString()}.`,
        type: 'system',
        url: '/#/profile'
      });
      
      return res.json({ 
        success: true, 
        message: `Billing suspended for ${durationDays} days starting ${startDate}`,
        resumeDate: result.resumeDate,
        member: { id: member.id, email: member.email, status: 'suspended' }
      });
    }
    
    return res.status(400).json({ error: 'No active billing found for this member.' });
  } catch (error: any) {
    if (!isProduction) console.error('Member suspend error:', error);
    res.status(500).json({ error: 'Failed to suspend member' });
  }
});

router.delete('/api/members/:email', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    const archivedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id, 
      archivedAt: users.archivedAt 
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    if (userResult[0].archivedAt) {
      return res.status(400).json({ error: 'Member is already archived' });
    }
    
    await db.update(users)
      .set({
        archivedAt: new Date(),
        archivedBy: archivedBy,
        membershipStatus: 'archived',
        updatedAt: new Date()
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    res.json({ 
      success: true, 
      archived: true,
      archivedBy,
      message: 'Member archived successfully'
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member archive error:', error);
    res.status(500).json({ error: 'Failed to archive member' });
  }
});

router.delete('/api/members/:email/permanent', isAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { deleteFromHubSpot, deleteFromStripe } = req.query;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      stripeCustomerId: users.stripeCustomerId,
      hubspotId: users.hubspotId
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const memberName = `${userResult[0].firstName || ''} ${userResult[0].lastName || ''}`.trim();
    const stripeCustomerId = userResult[0].stripeCustomerId;
    const hubspotId = userResult[0].hubspotId;
    
    const deletionLog: string[] = [];
    
    await pool.query('DELETE FROM member_notes WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('member_notes');
    
    await pool.query('DELETE FROM communication_logs WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('communication_logs');
    
    await pool.query('DELETE FROM guest_passes WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('guest_passes');
    
    await pool.query('DELETE FROM guest_check_ins WHERE member_email = $1', [normalizedEmail]);
    deletionLog.push('guest_check_ins');
    
    await pool.query('DELETE FROM event_rsvps WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('event_rsvps');
    
    await pool.query('DELETE FROM wellness_enrollments WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('wellness_enrollments');
    
    await pool.query('DELETE FROM booking_requests WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('booking_requests');
    
    await pool.query('DELETE FROM booking_members WHERE user_email = $1', [normalizedEmail]);
    deletionLog.push('booking_members');
    
    let stripeDeleted = false;
    if (deleteFromStripe === 'true' && stripeCustomerId) {
      try {
        const { getStripe } = await import('../../core/stripe');
        const stripe = getStripe();
        await stripe.customers.del(stripeCustomerId);
        stripeDeleted = true;
        deletionLog.push('stripe_customer');
      } catch (stripeError: any) {
        console.error(`[Admin] Failed to delete Stripe customer ${stripeCustomerId}:`, stripeError.message);
      }
    }
    
    let hubspotArchived = false;
    if (deleteFromHubSpot === 'true' && hubspotId) {
      try {
        const { getHubSpotClient } = await import('../../core/integrations');
        const hubspot = await getHubSpotClient();
        await hubspot.crm.contacts.basicApi.archive(hubspotId);
        hubspotArchived = true;
        deletionLog.push('hubspot_contact (archived)');
      } catch (hubspotError: any) {
        console.error(`[Admin] Failed to archive HubSpot contact ${hubspotId}:`, hubspotError.message);
      }
    }
    
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    deletionLog.push('users');
    
    console.log(`[Admin] Member permanently deleted: ${normalizedEmail} (${memberName}) by ${sessionUser?.email}. Records: ${deletionLog.join(', ')}`);
    
    res.json({ 
      success: true, 
      deleted: true,
      deletedBy: sessionUser?.email,
      deletedRecords: deletionLog,
      stripeDeleted,
      hubspotArchived,
      message: `Member ${memberName || normalizedEmail} permanently deleted`
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member permanent delete error:', error);
    res.status(500).json({ error: 'Failed to permanently delete member' });
  }
});

router.post('/api/members/:email/anonymize', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = decodeURIComponent(email).toLowerCase();
    const sessionUser = getSessionUser(req);
    const anonymizedBy = sessionUser?.email || 'unknown';
    
    const userResult = await db.select({ 
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      archivedAt: users.archivedAt 
    })
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    const userId = userResult[0].id;
    const anonymizedId = userId.slice(0, 8);
    const anonymizedEmail = `deleted_${anonymizedId}@anonymized.local`;
    const now = new Date();
    
    await db.update(users)
      .set({
        firstName: 'Deleted',
        lastName: 'Member',
        email: anonymizedEmail,
        phone: null,
        trackmanEmail: null,
        linkedEmails: sql`'[]'::jsonb`,
        manuallyLinkedEmails: sql`'[]'::jsonb`,
        emailOptIn: false,
        smsOptIn: false,
        doNotSellMyInfo: true,
        archivedAt: now,
        archivedBy: anonymizedBy,
        membershipStatus: 'deleted',
        updatedAt: now
      })
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
    
    await db.execute(sql`
      UPDATE booking_requests 
      SET user_name = 'Deleted Member', 
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    await db.execute(sql`
      UPDATE booking_members 
      SET user_name = 'Deleted Member',
          user_email = ${anonymizedEmail}
      WHERE LOWER(user_email) = ${normalizedEmail}
    `);
    
    console.log(`[Privacy] Member ${normalizedEmail} anonymized by ${anonymizedBy} at ${now.toISOString()}`);
    
    logFromRequest(req, 'archive_member', 'member', normalizedEmail, 
      `${userResult[0].firstName} ${userResult[0].lastName}`.trim() || undefined,
      { action: 'anonymize', reason: 'CCPA compliance' });
    
    res.json({ 
      success: true, 
      anonymized: true,
      anonymizedBy,
      message: 'Member data anonymized successfully. Financial records preserved for compliance.'
    });
  } catch (error: any) {
    if (!isProduction) console.error('Member anonymize error:', error);
    res.status(500).json({ error: 'Failed to anonymize member data' });
  }
});

router.get('/api/members/add-options', isStaffOrAdmin, async (req, res) => {
  try {
    const discountRules = await getAllDiscountRules();
    
    const tiersResult = await pool.query(
      `SELECT id, name, slug, price_cents, billing_interval, stripe_price_id
       FROM membership_tiers 
       WHERE is_active = true 
         AND product_type = 'subscription'
         AND billing_interval IN ('month', 'year', 'week')
       ORDER BY sort_order ASC NULLS LAST, name ASC`
    );
    
    res.json({
      tiers: TIER_NAMES,
      tiersWithIds: tiersResult.rows.map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        priceCents: t.price_cents,
        billingInterval: t.billing_interval,
        hasStripePrice: !!t.stripe_price_id
      })),
      discountReasons: discountRules
        .filter(r => r.isActive)
        .map(r => ({
          tag: r.discountTag,
          percent: r.discountPercent,
          description: r.description
        }))
    });
  } catch (error: any) {
    if (!isProduction) console.error('Add options error:', error);
    res.status(500).json({ error: 'Failed to fetch add member options' });
  }
});

router.post('/api/members', isStaffOrAdmin, async (req, res) => {
  try {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { firstName, lastName, email, phone, tier, startDate, discountReason } = req.body;
    
    if (!firstName || typeof firstName !== 'string' || firstName.trim().length === 0) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (!lastName || typeof lastName !== 'string' || lastName.trim().length === 0) {
      return res.status(400).json({ error: 'Last name is required' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!tier || !TIER_NAMES.includes(tier as any)) {
      return res.status(400).json({ error: `Invalid tier. Must be one of: ${TIER_NAMES.join(', ')}` });
    }
    
    if (startDate) {
      if (typeof startDate !== 'string') {
        return res.status(400).json({ error: 'Start date must be a string in YYYY-MM-DD format' });
      }
      
      const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateFormatRegex.test(startDate)) {
        return res.status(400).json({ error: 'Start date must be in YYYY-MM-DD format' });
      }
      
      const dateObj = new Date(`${startDate}T00:00:00Z`);
      if (isNaN(dateObj.getTime())) {
        return res.status(400).json({ error: 'Start date is not a valid date' });
      }
    }
    
    const memberInput = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone?.trim() || undefined,
      tier,
      startDate: startDate || undefined,
      discountReason: discountReason || undefined,
      createdBy: sessionUser.email,
      createdByName: sessionUser.name || `${sessionUser.firstName || ''} ${sessionUser.lastName || ''}`.trim()
    };
    
    const result = await createMemberLocally(memberInput);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to create member' });
    }
    
    let hubspotSyncQueued = false;
    try {
      await queueMemberCreation(memberInput);
      hubspotSyncQueued = true;
    } catch (queueError) {
      console.error('[CreateMember] Failed to queue HubSpot sync (member created locally):', queueError);
    }
    
    res.status(201).json({
      success: true,
      message: `Successfully created member ${firstName} ${lastName}`,
      member: {
        id: result.userId,
        email: email.toLowerCase(),
        firstName,
        lastName,
        tier
      },
      hubspotSyncQueued,
      hubspotSyncNote: hubspotSyncQueued 
        ? 'HubSpot sync will complete in the background' 
        : 'HubSpot sync failed to queue - member created locally only'
    });
  } catch (error: any) {
    console.error('Create member error:', error);
    res.status(500).json({ error: 'Failed to create member' });
  }
});

router.post('/api/members/admin/bulk-tier-update', isStaffOrAdmin, async (req, res) => {
  try {
    const { members, syncToHubspot = true, dryRun = false } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'Members array is required' });
    }
    
    const performedBy = sessionUser?.email || 'system';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : 'Bulk Update';
    
    const results: {
      updated: { email: string; name: string; oldTier: string; newTier: string; hubspotSynced?: boolean }[];
      unchanged: { email: string; name: string; tier: string }[];
      notFound: { email: string; tier: string }[];
      errors: { email: string; error: string }[];
    } = { updated: [], unchanged: [], notFound: [], errors: [] };
    
    const { normalizeTierName: normalizeTierNameUtil } = await import('../../utils/tierUtils');
    function normalizeCsvTier(csvTier: string): string | null {
      if (!csvTier) return null;
      return normalizeTierNameUtil(csvTier);
    }
    
    const tierIdMap: Record<string, number> = {
      'Social': 1,
      'Core': 2,
      'Premium': 3,
      'Corporate': 4,
      'VIP': 5
    };
    
    for (const member of members) {
      const { email, tier: csvTier, name } = member;
      
      if (!email) {
        results.errors.push({ email: 'unknown', error: 'Email missing' });
        continue;
      }
      
      const normalizedEmail = email.toLowerCase().trim();
      const normalizedTier = normalizeCsvTier(csvTier);
      
      if (!normalizedTier) {
        results.errors.push({ email: normalizedEmail, error: `Invalid tier: ${csvTier}` });
        continue;
      }
      
      try {
        const userResult = await db.select({
          id: users.id,
          email: users.email,
          tier: users.tier,
          tierId: users.tierId,
          firstName: users.firstName,
          lastName: users.lastName
        })
          .from(users)
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        
        if (userResult.length === 0) {
          results.notFound.push({ email: normalizedEmail, tier: normalizedTier });
          continue;
        }
        
        const user = userResult[0];
        const actualTier = user.tier;
        const oldTierDisplay = actualTier || 'Social';
        const memberName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || normalizedEmail;
        
        if (actualTier === normalizedTier) {
          results.unchanged.push({ email: normalizedEmail, name: memberName, tier: normalizedTier });
          continue;
        }
        
        if (dryRun) {
          results.updated.push({ 
            email: normalizedEmail, 
            name: memberName, 
            oldTier: oldTierDisplay, 
            newTier: normalizedTier,
            hubspotSynced: false
          });
          continue;
        }
        
        const tierId = tierIdMap[normalizedTier];
        await db.update(users)
          .set({ 
            tier: normalizedTier, 
            tierId: tierId,
            membershipTier: csvTier,
            updatedAt: new Date() 
          })
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);
        
        let hubspotSynced = false;
        if (syncToHubspot) {
          const hubspotResult = await handleTierChange(
            normalizedEmail,
            oldTierDisplay,
            normalizedTier,
            performedBy,
            performedByName
          );
          hubspotSynced = hubspotResult.success;
          
          if (!hubspotResult.success && hubspotResult.error) {
            console.warn(`[BulkTierUpdate] HubSpot sync failed for ${normalizedEmail}: ${hubspotResult.error}`);
          }
        }
        
        results.updated.push({ 
          email: normalizedEmail, 
          name: memberName, 
          oldTier: oldTierDisplay, 
          newTier: normalizedTier,
          hubspotSynced
        });
        
        if (syncToHubspot) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error: any) {
        console.error(`[BulkTierUpdate] Error processing ${normalizedEmail}:`, error);
        results.errors.push({ email: normalizedEmail, error: error.message });
      }
    }
    
    res.json({
      success: true,
      dryRun,
      summary: {
        total: members.length,
        updated: results.updated.length,
        unchanged: results.unchanged.length,
        notFound: results.notFound.length,
        errors: results.errors.length
      },
      results
    });
  } catch (error: any) {
    console.error('Bulk tier update error:', error);
    res.status(500).json({ error: 'Failed to process bulk tier update' });
  }
});

router.post('/api/admin/member/change-email', isStaffOrAdmin, async (req, res) => {
  try {
    const { oldEmail, newEmail } = req.body;
    const sessionUser = getSessionUser(req);
    
    if (!oldEmail || !newEmail) {
      return res.status(400).json({ error: 'Both oldEmail and newEmail are required' });
    }
    
    const performedBy = sessionUser?.email || 'unknown';
    const performedByName = sessionUser?.firstName 
      ? `${sessionUser.firstName} ${sessionUser.lastName || ''}`.trim() 
      : sessionUser?.email?.split('@')[0] || 'Staff';
    
    const result = await cascadeEmailChange(oldEmail, newEmail, performedBy, performedByName);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      message: `Email changed from ${result.oldEmail} to ${result.newEmail}`,
      tablesUpdated: result.tablesUpdated
    });
  } catch (error: any) {
    console.error('[Email Change] Error:', error);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

router.get('/api/admin/member/change-email/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const impact = await previewEmailChangeImpact(email);
    res.json(impact);
  } catch (error: any) {
    console.error('[Email Change Preview] Error:', error);
    res.status(500).json({ error: 'Failed to preview email change impact' });
  }
});

router.get('/api/admin/tier-change/tiers', isStaffOrAdmin, async (req, res) => {
  try {
    const tiers = await getAvailableTiersForChange();
    res.json({ tiers });
  } catch (error: any) {
    console.error('[Tier Change] Error getting tiers:', error);
    res.status(500).json({ error: 'Failed to get tiers' });
  }
});

router.post('/api/admin/tier-change/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { subscriptionId, newPriceId, immediate = true } = req.body;
    
    if (!subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'subscriptionId and newPriceId required' });
    }
    
    const result = await previewTierChange(subscriptionId, newPriceId, immediate);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ preview: result.preview });
  } catch (error: any) {
    console.error('[Tier Change] Preview error:', error);
    res.status(500).json({ error: 'Failed to preview tier change' });
  }
});

router.post('/api/admin/tier-change/commit', isStaffOrAdmin, async (req, res) => {
  try {
    const { memberEmail, subscriptionId, newPriceId, immediate = true } = req.body;
    const staffEmail = (req as any).user?.email || 'unknown';
    
    if (!memberEmail || !subscriptionId || !newPriceId) {
      return res.status(400).json({ error: 'memberEmail, subscriptionId, and newPriceId required' });
    }
    
    const result = await commitTierChange(memberEmail, subscriptionId, newPriceId, immediate, staffEmail);
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Tier Change] Commit error:', error);
    res.status(500).json({ error: 'Failed to change tier' });
  }
});

export default router;
