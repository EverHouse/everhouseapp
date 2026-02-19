import { pgTable, serial, varchar, timestamp, integer } from 'drizzle-orm/pg-core';

export const walkInVisits = pgTable('walk_in_visits', {
  id: serial('id').primaryKey(),
  memberEmail: varchar('member_email', { length: 255 }).notNull(),
  memberId: integer('member_id'),
  checkedInBy: varchar('checked_in_by', { length: 255 }),
  checkedInByName: varchar('checked_in_by_name', { length: 255 }),
  source: varchar('source', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
