import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

// System settings table - for storing app configuration like last reminder date
export const systemSettings = pgTable("system_settings", {
  key: varchar("key").primaryKey(),
  value: varchar("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Training sections table - for staff training guide content
export const trainingSections = pgTable("training_sections", {
  id: serial("id").primaryKey(),
  guideId: varchar("guide_id").unique(),
  icon: varchar("icon").notNull(),
  title: varchar("title").notNull(),
  description: text("description").notNull(),
  steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
  isAdminOnly: boolean("is_admin_only").default(false),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const integrityCheckHistory = pgTable("integrity_check_history", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  totalIssues: integer("total_issues").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  highCount: integer("high_count").notNull().default(0),
  mediumCount: integer("medium_count").notNull().default(0),
  lowCount: integer("low_count").notNull().default(0),
  resultsJson: jsonb("results_json"),
  triggeredBy: text("triggered_by").notNull().default('manual'),
});

export const integrityIssuesTracking = pgTable("integrity_issues_tracking", {
  id: serial("id").primaryKey(),
  issueKey: text("issue_key").notNull().unique(),
  firstDetectedAt: timestamp("first_detected_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  checkName: text("check_name").notNull(),
  severity: text("severity").notNull(),
  description: text("description").notNull(),
}, (table) => ({
  issueKeyIdx: uniqueIndex("integrity_issues_tracking_issue_key_idx").on(table.issueKey),
}));

export type SystemSetting = typeof systemSettings.$inferSelect;
export type TrainingSection = typeof trainingSections.$inferSelect;
export type InsertTrainingSection = typeof trainingSections.$inferInsert;
export type IntegrityCheckHistory = typeof integrityCheckHistory.$inferSelect;
export type InsertIntegrityCheckHistory = typeof integrityCheckHistory.$inferInsert;
export const integrityAuditLog = pgTable("integrity_audit_log", {
  id: serial("id").primaryKey(),
  issueKey: text("issue_key").notNull(),
  action: text("action").notNull(),
  actionBy: text("action_by").notNull(),
  actionAt: timestamp("action_at").defaultNow().notNull(),
  resolutionMethod: text("resolution_method"),
  notes: text("notes"),
});

export type IntegrityIssuesTracking = typeof integrityIssuesTracking.$inferSelect;
export type InsertIntegrityIssuesTracking = typeof integrityIssuesTracking.$inferInsert;
export type IntegrityAuditLog = typeof integrityAuditLog.$inferSelect;
export type InsertIntegrityAuditLog = typeof integrityAuditLog.$inferInsert;

export const integrityIgnores = pgTable("integrity_ignores", {
  id: serial("id").primaryKey(),
  issueKey: text("issue_key").notNull().unique(),
  ignoredBy: text("ignored_by").notNull(),
  ignoredAt: timestamp("ignored_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  reason: text("reason").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
}, (table) => ({
  issueKeyIdx: uniqueIndex("integrity_ignores_issue_key_idx").on(table.issueKey),
}));

export type IntegrityIgnore = typeof integrityIgnores.$inferSelect;
export type InsertIntegrityIgnore = typeof integrityIgnores.$inferInsert;

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: text("value"),
  category: varchar("category", { length: 100 }).notNull().default('general'),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by"),
}, (table) => ({
  keyIdx: uniqueIndex("app_settings_key_idx").on(table.key),
}));

export type AppSetting = typeof appSettings.$inferSelect;
export type InsertAppSetting = typeof appSettings.$inferInsert;

export const webhookProcessedEvents = pgTable("webhook_processed_events", {
  id: serial("id").primaryKey(),
  eventId: varchar("event_id", { length: 255 }).notNull().unique(),
  eventType: varchar("event_type", { length: 100 }),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
}, (table) => ({
  eventIdIdx: uniqueIndex("webhook_processed_events_event_id_idx").on(table.eventId),
  processedAtIdx: index("webhook_processed_events_processed_at_idx").on(table.processedAt),
}));

export type WebhookProcessedEvent = typeof webhookProcessedEvents.$inferSelect;

export const accountDeletionRequests = pgTable("account_deletion_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  status: varchar("status", { length: 50 }).notNull().default('pending'),
  processedBy: varchar("processed_by", { length: 255 }),
  notes: text("notes"),
}, (table) => ({
  userIdIdx: index("account_deletion_requests_user_id_idx").on(table.userId),
  statusIdx: index("account_deletion_requests_status_idx").on(table.status),
  pendingUserIdx: uniqueIndex("account_deletion_requests_pending_user_idx")
    .on(table.userId)
    .where(sql`status = 'pending'`),
}));

export type AccountDeletionRequest = typeof accountDeletionRequests.$inferSelect;

// Admin audit log - tracks staff actions for compliance
export const adminAuditLog = pgTable("admin_audit_log", {
  id: serial("id").primaryKey(),
  staffEmail: varchar("staff_email", { length: 255 }).notNull(),
  staffName: varchar("staff_name", { length: 255 }),
  action: varchar("action", { length: 100 }).notNull(), // 'view_member', 'export_data', 'update_member', 'delete_member', 'view_billing', etc.
  resourceType: varchar("resource_type", { length: 100 }).notNull(), // 'member', 'booking', 'payment', 'report', etc.
  resourceId: varchar("resource_id", { length: 255 }), // email or ID of the resource
  resourceName: varchar("resource_name", { length: 255 }), // display name for the resource
  details: jsonb("details"), // additional context about the action
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  staffEmailIdx: index("admin_audit_log_staff_email_idx").on(table.staffEmail),
  actionIdx: index("admin_audit_log_action_idx").on(table.action),
  resourceTypeIdx: index("admin_audit_log_resource_type_idx").on(table.resourceType),
  resourceIdIdx: index("admin_audit_log_resource_id_idx").on(table.resourceId),
  createdAtIdx: index("admin_audit_log_created_at_idx").on(table.createdAt),
}));

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type InsertAdminAuditLog = typeof adminAuditLog.$inferInsert;

// Data export requests - tracks member data export requests (CCPA)
export const dataExportRequests = pgTable("data_export_requests", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email", { length: 255 }).notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  status: varchar("status", { length: 50 }).notNull().default('pending'), // 'pending', 'processing', 'completed', 'failed'
  downloadUrl: text("download_url"),
  expiresAt: timestamp("expires_at"),
  errorMessage: text("error_message"),
}, (table) => ({
  userEmailIdx: index("data_export_requests_user_email_idx").on(table.userEmail),
  statusIdx: index("data_export_requests_status_idx").on(table.status),
}));

export type DataExportRequest = typeof dataExportRequests.$inferSelect;
export type InsertDataExportRequest = typeof dataExportRequests.$inferInsert;
