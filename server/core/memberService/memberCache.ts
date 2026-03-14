import type { MemberRecord, StaffRecord } from './memberTypes';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

class MemberCache {
  private membersByEmail = new Map<string, CacheEntry<MemberRecord>>();
  private membersById = new Map<string, CacheEntry<MemberRecord>>();
  private staffByEmail = new Map<string, CacheEntry<StaffRecord>>();
  private ttlMs: number;
  
  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() > entry.expiresAt;
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private evictIfNeeded(cache: Map<string, CacheEntry<any>>): void {
    if (cache.size > MAX_CACHE_SIZE) {
      const keysToDelete: string[] = [];
      const now = Date.now();
      
      for (const [key, entry] of cache.entries()) {
        if (now > entry.expiresAt) {
          keysToDelete.push(key);
        }
        if (keysToDelete.length >= MAX_CACHE_SIZE / 4) break;
      }
      
      for (const key of keysToDelete) {
        cache.delete(key);
      }
      
      if (cache.size > MAX_CACHE_SIZE) {
        const iterator = cache.keys();
        for (let i = 0; i < MAX_CACHE_SIZE / 4; i++) {
          const key = iterator.next().value;
          if (key) cache.delete(key);
        }
      }
    }
  }
  
  getMemberByEmail(email: string): MemberRecord | null {
    const normalizedEmail = email.toLowerCase();
    const entry = this.membersByEmail.get(normalizedEmail);
    if (!entry || this.isExpired(entry)) {
      this.membersByEmail.delete(normalizedEmail);
      return null;
    }
    return entry.data;
  }
  
  getMemberById(id: string): MemberRecord | null {
    const entry = this.membersById.get(id);
    if (!entry || this.isExpired(entry)) {
      this.membersById.delete(id);
      return null;
    }
    return entry.data;
  }
  
  getStaffByEmail(email: string): StaffRecord | null {
    const normalizedEmail = email.toLowerCase();
    const entry = this.staffByEmail.get(normalizedEmail);
    if (!entry || this.isExpired(entry)) {
      this.staffByEmail.delete(normalizedEmail);
      return null;
    }
    return entry.data;
  }
  
  setMember(member: MemberRecord): void {
    const expiresAt = Date.now() + this.ttlMs;
    const entry: CacheEntry<MemberRecord> = { data: member, expiresAt };
    
    this.evictIfNeeded(this.membersByEmail);
    this.evictIfNeeded(this.membersById);
    
    this.membersByEmail.set(member.normalizedEmail, entry);
    this.membersById.set(member.id, entry);
    
    for (const linkedEmail of member.linkedEmails) {
      this.membersByEmail.set(linkedEmail.toLowerCase(), entry);
    }
    if (member.trackmanEmail) {
      this.membersByEmail.set(member.trackmanEmail.toLowerCase(), entry);
    }
  }
  
  setStaff(staff: StaffRecord): void {
    const expiresAt = Date.now() + this.ttlMs;
    const entry: CacheEntry<StaffRecord> = { data: staff, expiresAt };
    
    this.evictIfNeeded(this.staffByEmail);
    this.staffByEmail.set(staff.normalizedEmail, entry);
  }
  
  invalidateMember(emailOrId: string): void {
    const normalized = emailOrId.toLowerCase();
    this.membersByEmail.delete(normalized);
    this.membersById.delete(emailOrId);
  }
  
  invalidateStaff(email: string): void {
    this.staffByEmail.delete(email.toLowerCase());
  }
  
  clear(): void {
    this.membersByEmail.clear();
    this.membersById.clear();
    this.staffByEmail.clear();
  }
  
  getStats(): { members: number; staff: number } {
    return {
      members: this.membersById.size,
      staff: this.staffByEmail.size
    };
  }
}

export const memberCache = new MemberCache();
