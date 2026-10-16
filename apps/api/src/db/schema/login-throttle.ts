import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const loginThrottle = pgTable(
  'login_throttle',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: text('ip').notNull(),
    attempts: integer('attempts').notNull().default(0),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('login_throttle_user_id_ip_unique').on(table.userId, table.ip),
    index('login_throttle_user_id_ip_idx').on(table.userId, table.ip),
    index('login_throttle_blocked_until_idx').on(table.blockedUntil),
  ],
);

export type LoginThrottleSelect = typeof loginThrottle.$inferSelect;
export type LoginThrottleInsert = typeof loginThrottle.$inferInsert;
