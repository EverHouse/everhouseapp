import { sql } from "drizzle-orm";
import { index, uniqueIndex, jsonb, pgTable, timestamp, varchar, serial, boolean, text, date, time, integer, numeric } from "drizzle-orm/pg-core";

// Notifications table - in-app notifications
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email").notNull(),
  title: varchar("title").notNull(),
  message: text("message").notNull(),
  type: varchar("type").default("info"),
  relatedId: integer("related_id"),
  relatedType: varchar("related_type"),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Push subscriptions table - web push notification subscriptions
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email").notNull(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Notice types table - preset and custom notice categories for display to members
export const noticeTypes = pgTable("notice_types", {
  id: serial("id").primaryKey(),
  name: varchar("name").notNull().unique(),
  isPreset: boolean("is_preset").default(false),
  sortOrder: integer("sort_order").default(100),
  createdAt: timestamp("created_at").defaultNow(),
});

// User dismissed notices - tracks which notices a user has dismissed
export const userDismissedNotices = pgTable("user_dismissed_notices", {
  id: serial("id").primaryKey(),
  userEmail: varchar("user_email").notNull(),
  noticeType: varchar("notice_type").notNull(), // 'announcement' or 'closure'
  noticeId: integer("notice_id").notNull(),
  dismissedAt: timestamp("dismissed_at").defaultNow(),
}, (table) => [
  uniqueIndex("unique_user_notice").on(table.userEmail, table.noticeType, table.noticeId),
]);

export type UserDismissedNotice = typeof userDismissedNotices.$inferSelect;
export type InsertUserDismissedNotice = typeof userDismissedNotices.$inferInsert;
