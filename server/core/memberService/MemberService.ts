import { pool } from '../db';
import { memberCache } from './memberCache';
import {
  MemberRecord,
  StaffRecord,
  MemberRole,
  BillingMemberMatch,
  MemberLookupOptions,
  detectIdentifierType,
  normalizeEmail,
  isUUID,
  isEmail,
  isHubSpotId,
  isMindbodyClientId
} from './memberTypes';
import type { MembershipTier } from '../../../shared/schema';

export const USAGE_LEDGER_MEMBER_JOIN = `
  LEFT JOIN users member_lookup ON member_lookup.id = bp.user_id
  LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
    AND (
      ul.member_id = bp.user_id 
      OR LOWER(ul.member_id) = LOWER(member_lookup.email)
    )
`;

export const USAGE_LEDGER_MEMBER_JOIN_WITH_BOOKING = `
  LEFT JOIN users member_lookup ON member_lookup.id = bp.user_id
  LEFT JOIN booking_requests br_lookup ON br_lookup.session_id = bp.session_id AND br_lookup.status != 'cancelled'
  LEFT JOIN usage_ledger ul ON ul.session_id = bp.session_id 
    AND (
      ul.member_id = bp.user_id 
      OR LOWER(ul.member_id) = LOWER(member_lookup.email)
      OR LOWER(ul.member_id) = LOWER(br_lookup.user_email)
    )
`;

class MemberServiceClass {
  
  async findByEmail(
    email: string,
    options: MemberLookupOptions = {}
  ): Promise<MemberRecord | null> {
    if (!email) return null;
    
    const normalized = normalizeEmail(email);
    
    if (!options.bypassCache) {
      const cached = memberCache.getMemberByEmail(normalized);
      if (cached) return cached;
    }
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.role,
        u.tier,
        u.tier_id,
        u.phone,
        u.tags,
        u.stripe_customer_id,
        u.hubspot_id,
        u.mindbody_client_id,
        u.membership_status,
        u.join_date,
        u.lifetime_visits,
        u.linked_emails,
        u.trackman_email,
        u.archived_at,
        mt.id as tier_config_id,
        mt.name as tier_name,
        mt.daily_sim_minutes,
        mt.guest_passes_per_month,
        mt.booking_window_days,
        mt.can_book_simulators,
        mt.can_book_conference,
        mt.can_book_wellness,
        mt.unlimited_access
      FROM users u
      LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
      WHERE (
        LOWER(u.email) = $1
        OR LOWER(u.trackman_email) = $1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(u.linked_emails) AS linked(email) 
          WHERE LOWER(linked.email) = $1
        )
      )
      ${options.includeArchived ? '' : 'AND u.archived_at IS NULL'}
      LIMIT 1
    `, [normalized]);
    
    if (result.rows.length === 0) return null;
    
    const member = this.rowToMemberRecord(result.rows[0], options.includeTierConfig);
    memberCache.setMember(member);
    return member;
  }
  
  async findById(
    id: string,
    options: MemberLookupOptions = {}
  ): Promise<MemberRecord | null> {
    if (!id) return null;
    
    if (!options.bypassCache) {
      const cached = memberCache.getMemberById(id);
      if (cached) return cached;
    }
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.role,
        u.tier,
        u.tier_id,
        u.phone,
        u.tags,
        u.stripe_customer_id,
        u.hubspot_id,
        u.mindbody_client_id,
        u.membership_status,
        u.join_date,
        u.lifetime_visits,
        u.linked_emails,
        u.trackman_email,
        u.archived_at,
        mt.id as tier_config_id,
        mt.name as tier_name,
        mt.daily_sim_minutes,
        mt.guest_passes_per_month,
        mt.booking_window_days,
        mt.can_book_simulators,
        mt.can_book_conference,
        mt.can_book_wellness,
        mt.unlimited_access
      FROM users u
      LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
      WHERE u.id = $1
        ${options.includeArchived ? '' : 'AND u.archived_at IS NULL'}
      LIMIT 1
    `, [id]);
    
    if (result.rows.length === 0) return null;
    
    const member = this.rowToMemberRecord(result.rows[0], options.includeTierConfig);
    memberCache.setMember(member);
    return member;
  }
  
  async findByHubSpotId(
    hubspotId: string,
    options: MemberLookupOptions = {}
  ): Promise<MemberRecord | null> {
    if (!hubspotId) return null;
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.role,
        u.tier,
        u.tier_id,
        u.phone,
        u.tags,
        u.stripe_customer_id,
        u.hubspot_id,
        u.mindbody_client_id,
        u.membership_status,
        u.join_date,
        u.lifetime_visits,
        u.linked_emails,
        u.trackman_email,
        u.archived_at,
        mt.id as tier_config_id,
        mt.name as tier_name,
        mt.daily_sim_minutes,
        mt.guest_passes_per_month,
        mt.booking_window_days,
        mt.can_book_simulators,
        mt.can_book_conference,
        mt.can_book_wellness,
        mt.unlimited_access
      FROM users u
      LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
      WHERE u.hubspot_id = $1
        ${options.includeArchived ? '' : 'AND u.archived_at IS NULL'}
      LIMIT 1
    `, [hubspotId]);
    
    if (result.rows.length === 0) return null;
    
    const member = this.rowToMemberRecord(result.rows[0], options.includeTierConfig);
    memberCache.setMember(member);
    return member;
  }
  
  async findByMindbodyClientId(
    mindbodyClientId: string,
    options: MemberLookupOptions = {}
  ): Promise<MemberRecord | null> {
    if (!mindbodyClientId) return null;
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.role,
        u.tier,
        u.tier_id,
        u.phone,
        u.tags,
        u.stripe_customer_id,
        u.hubspot_id,
        u.mindbody_client_id,
        u.membership_status,
        u.join_date,
        u.lifetime_visits,
        u.linked_emails,
        u.trackman_email,
        u.archived_at,
        mt.id as tier_config_id,
        mt.name as tier_name,
        mt.daily_sim_minutes,
        mt.guest_passes_per_month,
        mt.booking_window_days,
        mt.can_book_simulators,
        mt.can_book_conference,
        mt.can_book_wellness,
        mt.unlimited_access
      FROM users u
      LEFT JOIN membership_tiers mt ON u.tier_id = mt.id
      WHERE u.mindbody_client_id = $1
        ${options.includeArchived ? '' : 'AND u.archived_at IS NULL'}
      LIMIT 1
    `, [mindbodyClientId]);
    
    if (result.rows.length === 0) return null;
    
    const member = this.rowToMemberRecord(result.rows[0], options.includeTierConfig);
    memberCache.setMember(member);
    return member;
  }
  
  async findByAnyIdentifier(
    identifier: string,
    options: MemberLookupOptions = {}
  ): Promise<MemberRecord | null> {
    if (!identifier) return null;
    
    const identifierType = detectIdentifierType(identifier);
    
    // Try direct match based on identifier type
    if (identifierType === 'uuid') {
      return this.findById(identifier, options);
    }
    
    if (identifierType === 'email') {
      return this.findByEmail(identifier, options);
    }
    
    if (identifierType === 'hubspot_id') {
      const byHubSpot = await this.findByHubSpotId(identifier, options);
      if (byHubSpot) return byHubSpot;
    }
    
    // Fallback chain: try all methods in order of priority
    // 1. Email (primary identifier)
    const byEmail = await this.findByEmail(identifier, options);
    if (byEmail) return byEmail;
    
    // 2. UUID (internal app ID)
    const byId = await this.findById(identifier, options);
    if (byId) return byId;
    
    // 3. HubSpot ID (CRM identifier - future primary as Mindbody phases out)
    const byHubSpot = await this.findByHubSpotId(identifier, options);
    if (byHubSpot) return byHubSpot;
    
    // 4. Mindbody Client ID (legacy identifier - being phased out)
    const byMindbody = await this.findByMindbodyClientId(identifier, options);
    if (byMindbody) return byMindbody;
    
    return null;
  }
  
  async resolveMemberForBilling(
    sessionId: number,
    participantUserId: string | null,
    fallbackEmail: string | null
  ): Promise<BillingMemberMatch> {
    if (participantUserId && isUUID(participantUserId)) {
      const member = await this.findById(participantUserId, { includeTierConfig: true });
      if (member) {
        return {
          member,
          matchedBy: 'uuid',
          originalIdentifier: participantUserId
        };
      }
    }
    
    if (participantUserId && isEmail(participantUserId)) {
      const member = await this.findByEmail(participantUserId, { includeTierConfig: true });
      if (member) {
        return {
          member,
          matchedBy: 'email',
          originalIdentifier: participantUserId
        };
      }
    }
    
    if (fallbackEmail) {
      const member = await this.findByEmail(fallbackEmail, { includeTierConfig: true });
      if (member) {
        return {
          member,
          matchedBy: 'booking_email',
          originalIdentifier: fallbackEmail
        };
      }
    }
    
    if (sessionId) {
      const bookingResult = await pool.query(`
        SELECT user_email FROM booking_requests WHERE session_id = $1 LIMIT 1
      `, [sessionId]);
      
      if (bookingResult.rows.length > 0 && bookingResult.rows[0].user_email) {
        const bookingEmail = bookingResult.rows[0].user_email;
        const member = await this.findByEmail(bookingEmail, { includeTierConfig: true });
        if (member) {
          return {
            member,
            matchedBy: 'booking_email',
            originalIdentifier: bookingEmail
          };
        }
      }
    }
    
    return {
      member: null,
      matchedBy: null,
      originalIdentifier: participantUserId || fallbackEmail || ''
    };
  }
  
  async findStaffByEmail(email: string): Promise<StaffRecord | null> {
    if (!email) return null;
    
    const normalized = normalizeEmail(email);
    
    const cached = memberCache.getStaffByEmail(normalized);
    if (cached) return cached;
    
    const result = await pool.query(`
      SELECT 
        id,
        email,
        name,
        first_name,
        last_name,
        phone,
        job_title,
        role,
        is_active
      FROM staff_users
      WHERE LOWER(email) = $1 AND is_active = true
      LIMIT 1
    `, [normalized]);
    
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    const staff: StaffRecord = {
      id: row.id,
      email: row.email,
      normalizedEmail: normalized,
      name: row.name,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: row.name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email,
      role: row.role === 'admin' ? 'admin' : 'staff',
      jobTitle: row.job_title,
      phone: row.phone,
      isActive: row.is_active
    };
    
    memberCache.setStaff(staff);
    return staff;
  }
  
  async isStaffOrAdmin(email: string): Promise<boolean> {
    const staff = await this.findStaffByEmail(email);
    return staff !== null;
  }
  
  async getMemberRole(email: string): Promise<MemberRole> {
    const staff = await this.findStaffByEmail(email);
    if (staff) return staff.role;
    return 'member';
  }
  
  async getMemberTier(emailOrId: string): Promise<{ tier: string | null; tierConfig: MembershipTier | null }> {
    const member = await this.findByAnyIdentifier(emailOrId, { includeTierConfig: true });
    if (!member) return { tier: null, tierConfig: null };
    return { tier: member.tier, tierConfig: member.tierConfig };
  }
  
  async resolveLedgerMemberId(
    participantUserId: string | null,
    sessionId: number | null
  ): Promise<string | null> {
    if (participantUserId && isEmail(participantUserId)) {
      return normalizeEmail(participantUserId);
    }
    
    if (participantUserId && isUUID(participantUserId)) {
      const member = await this.findById(participantUserId);
      if (member) return member.normalizedEmail;
    }
    
    if (sessionId) {
      const result = await pool.query(`
        SELECT user_email FROM booking_requests WHERE session_id = $1 LIMIT 1
      `, [sessionId]);
      if (result.rows.length > 0 && result.rows[0].user_email) {
        return normalizeEmail(result.rows[0].user_email);
      }
    }
    
    return null;
  }
  
  invalidateCache(emailOrId: string): void {
    memberCache.invalidateMember(emailOrId);
  }
  
  clearCache(): void {
    memberCache.clear();
  }
  
  getCacheStats(): { members: number; staff: number } {
    return memberCache.getStats();
  }
  
  private rowToMemberRecord(row: any, includeTierConfig: boolean = false): MemberRecord {
    const linkedEmails = Array.isArray(row.linked_emails) 
      ? row.linked_emails 
      : (typeof row.linked_emails === 'string' ? JSON.parse(row.linked_emails) : []);
    
    const tags = Array.isArray(row.tags)
      ? row.tags
      : (typeof row.tags === 'string' ? JSON.parse(row.tags) : []);
    
    let tierConfig: any = null;
    if (includeTierConfig && row.tier_config_id) {
      tierConfig = {
        id: row.tier_config_id,
        name: row.tier_name,
        slug: row.tier_name?.toLowerCase().replace(/\s+/g, '-') || '',
        priceString: '',
        description: null,
        buttonText: null,
        sortOrder: 0,
        isActive: true,
        isPopular: false,
        showInComparison: true,
        highlightedFeatures: [],
        allFeatures: {},
        dailySimMinutes: row.daily_sim_minutes || 0,
        guestPassesPerMonth: row.guest_passes_per_month || 0,
        bookingWindowDays: row.booking_window_days || 7,
        dailyConfRoomMinutes: 0,
        canBookSimulators: row.can_book_simulators || false,
        canBookConference: row.can_book_conference || false,
        canBookWellness: row.can_book_wellness !== false,
        hasGroupLessons: false,
        hasExtendedSessions: false,
        hasPrivateLesson: false,
        hasSimulatorGuestPasses: false,
        hasDiscountedMerch: false,
        unlimitedAccess: row.unlimited_access || false,
        createdAt: null,
        updatedAt: null
      };
    }
    
    const role: MemberRole = row.role === 'admin' ? 'admin' : row.role === 'staff' ? 'staff' : 'member';
    
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: normalizeEmail(row.email || ''),
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email || '',
      role,
      isStaff: role === 'staff' || role === 'admin',
      isAdmin: role === 'admin',
      tier: row.tier,
      tierId: row.tier_id,
      tierConfig,
      phone: row.phone,
      tags,
      stripeCustomerId: row.stripe_customer_id,
      hubspotId: row.hubspot_id,
      mindbodyClientId: row.mindbody_client_id,
      membershipStatus: row.membership_status,
      joinDate: row.join_date ? new Date(row.join_date) : null,
      lifetimeVisits: row.lifetime_visits || 0,
      linkedEmails,
      trackmanEmail: row.trackman_email
    };
  }
}

export const MemberService = new MemberServiceClass();
