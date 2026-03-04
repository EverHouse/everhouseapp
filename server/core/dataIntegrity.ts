export {
  severityMap,
  generateIssueKey,
  safeCheck,
  runAllIntegrityChecks,
  getIntegritySummary,
  getIntegrityHistory,
  getCachedIntegrityResults,
} from './integrity/core';

export type {
  SyncComparisonData,
  IssueContext,
  IntegrityIssue,
  IntegrityCheckResult,
  IntegritySummary,
  CachedIntegrityResults,
} from './integrity/core';

export type {
  ResolveIssueParams,
  SyncPushParams,
  SyncPullParams,
  CreateIgnoreParams,
  CreateBulkIgnoreParams,
  IgnoredIssue,
} from './integrity/resolution';

export {
  resolveIssue,
  getAuditLog,
  syncPush,
  syncPull,
  bulkPushToHubSpot,
  createIgnoreRule,
  removeIgnoreRule,
  createBulkIgnoreRules,
  getIgnoredIssues,
  getActiveIgnoreKeys,
} from './integrity/resolution';

export {
  runDataCleanup,
  autoFixMissingTiers,
} from './integrity/cleanup';
