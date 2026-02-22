export interface SyncComparisonData {
  field: string;
  appValue: string | number | null;
  externalValue: string | number | null;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  message?: string;
  lastChecked: string;
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    database: ServiceHealth;
    stripe: ServiceHealth;
    hubspot: ServiceHealth;
    resend: ServiceHealth;
    googleCalendar: ServiceHealth;
  };
  timestamp: string;
}

export interface IssueContext {
  memberName?: string;
  memberEmail?: string;
  memberTier?: string;
  bookingDate?: string;
  resourceName?: string;
  startTime?: string;
  endTime?: string;
  className?: string;
  classDate?: string;
  instructor?: string;
  eventTitle?: string;
  eventDate?: string;
  tourDate?: string;
  guestName?: string;
  trackmanBookingId?: string;
  importedName?: string;
  notes?: string;
  originalEmail?: string;
  bayNumber?: string;
  userName?: string;
  userEmail?: string;
  syncType?: 'hubspot' | 'calendar';
  syncComparison?: SyncComparisonData[];
  hubspotContactId?: string;
  userId?: number;
  duplicateUsers?: Array<{ userId: number; email: string; status: string; tier: string }>;
  errorType?: string;
  email?: string;
  memberEmails?: string;
  lastUpdate?: string;
  memberStatus?: string;
  stripeCustomerId?: string;
  status?: string;
  resourceId?: number;
  bookingId?: number;
  booking1Id?: number;
  booking1Status?: string;
  member1Email?: string;
  member1Name?: string;
  booking2Id?: number;
  booking2Status?: string;
  member2Email?: string;
  member2Name?: string;
}

export interface IgnoreInfo {
  ignoredBy: string;
  ignoredAt: string;
  expiresAt: string;
  reason: string;
}

export interface IntegrityIssue {
  category: 'orphan_record' | 'missing_relationship' | 'sync_mismatch' | 'data_quality' | 'billing_issue' | 'booking_issue' | 'system_error';
  severity: 'error' | 'warning' | 'info';
  table: string;
  recordId: number | string;
  description: string;
  suggestion?: string;
  context?: IssueContext;
  ignored?: boolean;
  ignoreInfo?: IgnoreInfo;
}

export interface IgnoredIssueEntry {
  id: number;
  issueKey: string;
  ignoredBy: string;
  ignoredAt: string;
  expiresAt: string;
  reason: string;
  isActive: boolean;
  isExpired: boolean;
}

export interface IntegrityCheckResult {
  checkName: string;
  status: 'pass' | 'warning' | 'fail' | 'info';
  issueCount: number;
  issues: IntegrityIssue[];
  lastRun: Date;
  durationMs?: number;
}

export interface IntegrityMeta {
  totalChecks: number;
  passed: number;
  warnings: number;
  failed: number;
  totalIssues: number;
  lastRun: Date;
}

export interface CalendarStatus {
  name: string;
  status: 'connected' | 'not_found';
}

export interface CalendarStatusResponse {
  timestamp: string;
  configured_calendars: CalendarStatus[];
}

export interface HistoryEntry {
  id: number;
  runAt: string;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  triggeredBy: string;
}

export interface ActiveIssue {
  issueKey: string;
  checkName: string;
  severity: string;
  description: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  daysUnresolved: number;
}

export interface HistoryData {
  history: HistoryEntry[];
  trend: 'increasing' | 'decreasing' | 'stable';
  activeIssues: ActiveIssue[];
}

export interface AuditLogEntry {
  id: number;
  issueKey: string;
  action: string;
  actionBy: string;
  actionAt: string;
  resolutionMethod: string | null;
  notes: string | null;
}

export interface IgnoreModalState {
  isOpen: boolean;
  issue: IntegrityIssue | null;
  checkName: string;
}

export interface BulkIgnoreModalState {
  isOpen: boolean;
  checkName: string;
  issues: IntegrityIssue[];
}

export interface CachedResultsResponse {
  hasCached: boolean;
  results: IntegrityCheckResult[];
  meta: IntegrityMeta;
}

export interface IntegrityRunResponse {
  results: IntegrityCheckResult[];
  meta: IntegrityMeta;
}
