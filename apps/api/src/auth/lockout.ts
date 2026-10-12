import { sql, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { users } from '../db/schema/users.js';
import type { DbOrTx } from '../services/audit.js';

export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Checks whether an account is currently locked due to failed login attempts.
 */
export function isAccountLocked(
  user: { failedAttempts: number; lockedUntil: Date | null },
  now = new Date(),
): boolean {
  if (!user.lockedUntil) {
    return false;
  }
  return user.lockedUntil.getTime() > now.getTime();
}

/**
 * Calculates updated failed attempts and optional lockout timestamp in-memory.
 */
export function recordFailedAttempt(
  currentAttempts: number,
  now = new Date(),
  maxAttempts = env.MAX_FAILED_LOGIN_ATTEMPTS,
  lockoutMinutes = env.LOCKOUT_DURATION_MINUTES,
): LockoutState {
  const newAttempts = currentAttempts + 1;

  if (newAttempts >= maxAttempts) {
    const lockedUntil = new Date(now.getTime() + lockoutMinutes * 60 * 1000);
    return {
      failedAttempts: newAttempts,
      lockedUntil,
    };
  }

  return {
    failedAttempts: newAttempts,
    lockedUntil: null,
  };
}

/**
 * Atomically increments failed attempts in the database (single UPDATE ... RETURNING)
 * and calculates lockout from the resulting count.
 * Prevents concurrency race conditions when parallel requests fail simultaneously.
 */
export async function recordFailedAttemptAtomic(
  dbOrTx: DbOrTx,
  userId: string,
  now = new Date(),
  maxAttempts = env.MAX_FAILED_LOGIN_ATTEMPTS,
  lockoutMinutes = env.LOCKOUT_DURATION_MINUTES,
): Promise<LockoutState> {
  const [updated] = await dbOrTx
    .update(users)
    .set({
      failedAttempts: sql`${users.failedAttempts} + 1`,
      lockedUntil: sql`CASE WHEN ${users.failedAttempts} + 1 >= ${maxAttempts} THEN NOW() + (${lockoutMinutes} || ' minutes')::interval ELSE NULL END`,
      updatedAt: now,
    })
    .where(eq(users.id, userId))
    .returning({
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    });

  return {
    failedAttempts: updated?.failedAttempts ?? 1,
    lockedUntil: updated?.lockedUntil ?? null,
  };
}

/**
 * Atomically resets failed attempts and lockout timestamp in the database after successful login.
 */
export async function resetLockoutAtomic(
  dbOrTx: DbOrTx,
  userId: string,
  now = new Date(),
): Promise<LockoutState> {
  const [updated] = await dbOrTx
    .update(users)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, userId))
    .returning({
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    });

  return {
    failedAttempts: updated?.failedAttempts ?? 0,
    lockedUntil: updated?.lockedUntil ?? null,
  };
}

/**
 * Resets failed attempts after a successful login (pure helper).
 */
export function resetLockout(): LockoutState {
  return {
    failedAttempts: 0,
    lockedUntil: null,
  };
}
