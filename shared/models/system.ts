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

export type SystemSetting = typeof systemSettings.$inferSelect;
export type TrainingSection = typeof trainingSections.$inferSelect;
export type InsertTrainingSection = typeof trainingSections.$inferInsert;
