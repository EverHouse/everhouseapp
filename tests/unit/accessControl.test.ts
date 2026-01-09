import { describe, it, expect } from 'vitest';

type UserRole = 'member' | 'staff' | 'admin';

interface SessionUser {
  email: string;
  role: UserRole;
  tier?: string;
}

interface Session {
  user?: SessionUser;
  createdAt?: number;
  expiresAt?: number;
}

function isAuthenticated(session: Session | null): boolean {
  return session !== null && session.user !== undefined;
}

function isStaffOrAdmin(user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'staff' || user.role === 'admin';
}

function isAdmin(user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin';
}

function canAccessRoute(user: SessionUser | null, allowedRoles: UserRole[]): boolean {
  if (!user) return false;
  return allowedRoles.includes(user.role);
}

describe('Access Control - Role-Based Route Protection', () => {
  it('should allow member to access member-allowed routes', () => {
    const member: SessionUser = { email: 'member@example.com', role: 'member' };
    expect(canAccessRoute(member, ['member', 'staff', 'admin'])).toBe(true);
  });
  
  it('should block member from staff-only routes', () => {
    const member: SessionUser = { email: 'member@example.com', role: 'member' };
    expect(canAccessRoute(member, ['staff', 'admin'])).toBe(false);
  });
  
  it('should block member from admin-only routes', () => {
    const member: SessionUser = { email: 'member@example.com', role: 'member' };
    expect(isAdmin(member)).toBe(false);
    expect(canAccessRoute(member, ['admin'])).toBe(false);
  });
  
  it('should allow staff to access staff routes', () => {
    const staff: SessionUser = { email: 'staff@example.com', role: 'staff' };
    expect(isStaffOrAdmin(staff)).toBe(true);
    expect(canAccessRoute(staff, ['staff', 'admin'])).toBe(true);
  });
  
  it('should block staff from admin-only routes', () => {
    const staff: SessionUser = { email: 'staff@example.com', role: 'staff' };
    expect(isAdmin(staff)).toBe(false);
    expect(canAccessRoute(staff, ['admin'])).toBe(false);
  });
  
  it('should allow admin to access all role-based routes', () => {
    const admin: SessionUser = { email: 'admin@example.com', role: 'admin' };
    expect(isStaffOrAdmin(admin)).toBe(true);
    expect(isAdmin(admin)).toBe(true);
    expect(canAccessRoute(admin, ['admin'])).toBe(true);
    expect(canAccessRoute(admin, ['staff', 'admin'])).toBe(true);
  });
  
  it('should block unauthenticated users from all protected routes', () => {
    expect(canAccessRoute(null, ['member', 'staff', 'admin'])).toBe(false);
    expect(isStaffOrAdmin(null)).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe('Access Control - Session Validation', () => {
  function isSessionValid(session: Session | null): boolean {
    if (!session || !session.user) return false;
    if (session.expiresAt && Date.now() > session.expiresAt) return false;
    return true;
  }
  
  function isSessionExpired(session: Session): boolean {
    if (!session.expiresAt) return false;
    return Date.now() > session.expiresAt;
  }
  
  it('should validate session with user data and future expiry', () => {
    const session: Session = {
      user: { email: 'test@example.com', role: 'member' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000
    };
    
    expect(isSessionValid(session)).toBe(true);
    expect(isAuthenticated(session)).toBe(true);
  });
  
  it('should reject session without user', () => {
    const session: Session = {
      createdAt: Date.now()
    };
    
    expect(isSessionValid(session)).toBe(false);
    expect(isAuthenticated(session)).toBe(false);
  });
  
  it('should reject null session', () => {
    expect(isSessionValid(null)).toBe(false);
    expect(isAuthenticated(null)).toBe(false);
  });
  
  it('should detect expired session', () => {
    const expiredSession: Session = {
      user: { email: 'test@example.com', role: 'member' },
      expiresAt: Date.now() - 1000
    };
    
    expect(isSessionExpired(expiredSession)).toBe(true);
    expect(isSessionValid(expiredSession)).toBe(false);
  });
  
  it('should treat session without explicit expiry as non-expired', () => {
    const session: Session = {
      user: { email: 'test@example.com', role: 'member' }
    };
    
    expect(isSessionExpired(session)).toBe(false);
    expect(isSessionValid(session)).toBe(true);
  });
});

describe('Access Control - Resource Ownership Validation', () => {
  interface Booking {
    id: number;
    userEmail: string;
    status: string;
  }
  
  function canModifyBooking(
    booking: Booking,
    userEmail: string,
    userRole: UserRole
  ): { allowed: boolean; reason?: string } {
    if (userRole === 'admin' || userRole === 'staff') {
      return { allowed: true };
    }
    
    if (booking.userEmail.toLowerCase() !== userEmail.toLowerCase()) {
      return { allowed: false, reason: 'You can only modify your own bookings' };
    }
    
    if (booking.status === 'cancelled' || booking.status === 'declined') {
      return { allowed: false, reason: 'Cannot modify cancelled or declined booking' };
    }
    
    return { allowed: true };
  }
  
  it('should allow member to modify their own booking', () => {
    const booking: Booking = { id: 1, userEmail: 'member@example.com', status: 'approved' };
    const result = canModifyBooking(booking, 'member@example.com', 'member');
    
    expect(result.allowed).toBe(true);
  });
  
  it('should block member from modifying others bookings', () => {
    const booking: Booking = { id: 1, userEmail: 'other@example.com', status: 'approved' };
    const result = canModifyBooking(booking, 'member@example.com', 'member');
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('your own bookings');
  });
  
  it('should allow staff to modify any booking', () => {
    const booking: Booking = { id: 1, userEmail: 'member@example.com', status: 'approved' };
    const result = canModifyBooking(booking, 'staff@example.com', 'staff');
    
    expect(result.allowed).toBe(true);
  });
  
  it('should allow admin to modify any booking', () => {
    const booking: Booking = { id: 1, userEmail: 'member@example.com', status: 'approved' };
    const result = canModifyBooking(booking, 'admin@example.com', 'admin');
    
    expect(result.allowed).toBe(true);
  });
  
  it('should handle case-insensitive email comparison', () => {
    const booking: Booking = { id: 1, userEmail: 'Member@Example.com', status: 'approved' };
    const result = canModifyBooking(booking, 'member@example.com', 'member');
    
    expect(result.allowed).toBe(true);
  });
  
  it('should block member modification of cancelled booking', () => {
    const booking: Booking = { id: 1, userEmail: 'member@example.com', status: 'cancelled' };
    const result = canModifyBooking(booking, 'member@example.com', 'member');
    
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cancelled');
  });
});

describe('Access Control - API Route Classification', () => {
  const routeConfig = {
    public: ['/api/health', '/api/auth/login', '/api/cafe-menu', '/api/faq'],
    member: ['/api/bookings', '/api/notifications', '/api/booking-requests', '/api/events'],
    staff: ['/api/admin/pending', '/api/staff/calendar', '/api/admin/members'],
    admin: ['/api/admin/users', '/api/admin/settings', '/api/admin/tiers']
  };
  
  function getRequiredRole(path: string): UserRole | null {
    if (routeConfig.public.some(r => path.startsWith(r))) return null;
    if (routeConfig.admin.some(r => path.startsWith(r))) return 'admin';
    if (routeConfig.staff.some(r => path.startsWith(r))) return 'staff';
    if (routeConfig.member.some(r => path.startsWith(r))) return 'member';
    return 'member';
  }
  
  it('should identify public routes as requiring no authentication', () => {
    expect(getRequiredRole('/api/health')).toBeNull();
    expect(getRequiredRole('/api/cafe-menu')).toBeNull();
    expect(getRequiredRole('/api/faq')).toBeNull();
  });
  
  it('should identify member routes', () => {
    expect(getRequiredRole('/api/bookings')).toBe('member');
    expect(getRequiredRole('/api/notifications')).toBe('member');
    expect(getRequiredRole('/api/booking-requests/123')).toBe('member');
  });
  
  it('should identify staff routes', () => {
    expect(getRequiredRole('/api/admin/pending')).toBe('staff');
    expect(getRequiredRole('/api/staff/calendar')).toBe('staff');
  });
  
  it('should identify admin routes', () => {
    expect(getRequiredRole('/api/admin/users')).toBe('admin');
    expect(getRequiredRole('/api/admin/settings')).toBe('admin');
  });
  
  it('should default unknown routes to member-level protection', () => {
    expect(getRequiredRole('/api/unknown-route')).toBe('member');
  });
});
