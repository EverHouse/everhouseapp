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
