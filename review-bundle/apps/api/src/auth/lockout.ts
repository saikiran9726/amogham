import { sql, eq, and } from 'drizzle-orm';
import { env } from '../config/env.js';
import { users } from '../db/schema/users.js';
import { loginThrottle } from '../db/schema/login-throttle.js';
import type { DbOrTx } from '../services/audit.js';

export interface LockoutState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface ThrottleState {
  throttled: boolean;
  blockedUntil: Date | null;
  attempts: number;
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
 * Checks whether a (user, ip) combination is currently throttled due to repeated failures.
 */
export async function checkLoginThrottle(
  dbOrTx: DbOrTx,
  userId: string,
  ip: string,
  now = new Date(),
): Promise<ThrottleState> {
  const [row] = await dbOrTx
    .select({
      attempts: loginThrottle.attempts,
      blockedUntil: loginThrottle.blockedUntil,
    })
    .from(loginThrottle)
    .where(and(eq(loginThrottle.userId, userId), eq(loginThrottle.ip, ip)))
    .limit(1);

  if (!row) {
    return { throttled: false, blockedUntil: null, attempts: 0 };
  }

  const isBlocked = Boolean(row.blockedUntil && row.blockedUntil.getTime() > now.getTime());
  return {
    throttled: isBlocked,
    blockedUntil: isBlocked ? row.blockedUntil : null,
    attempts: row.attempts,
  };
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
  isOwner = false,
): Promise<LockoutState> {
  // If isOwner is true, we never lock the account in users.lockedUntil
  const lockedUntilClause = isOwner
    ? sql`NULL`
    : sql`CASE WHEN ${users.failedAttempts} + 1 >= ${maxAttempts} THEN NOW() + (${lockoutMinutes} || ' minutes')::interval ELSE NULL END`;

  const [updated] = await dbOrTx
    .update(users)
    .set({
      failedAttempts: sql`${users.failedAttempts} + 1`,
      lockedUntil: lockedUntilClause,
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
 * Atomically records a failed login attempt with per-(user, ip) exponential backoff
 * in the dedicated login_throttle table, while protecting owner accounts from hard-locks.
 */
export async function recordFailedAttemptWithThrottleAtomic(
  dbOrTx: DbOrTx,
  userId: string,
  ip: string,
  isOwner = false,
  now = new Date(),
  maxAttempts = env.MAX_FAILED_LOGIN_ATTEMPTS,
  lockoutMinutes = env.LOCKOUT_DURATION_MINUTES,
): Promise<LockoutState & ThrottleState> {
  // 1. Record per-(user, ip) failure and calculate exponential backoff
  // Backoff activates at attempt >= 3: 5s, 10s, 20s, 40s... capped at 900s (15 min)
  const [throttleRow] = await dbOrTx
    .insert(loginThrottle)
    .values({
      userId,
      ip,
      attempts: 1,
      blockedUntil: null,
      lastAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [loginThrottle.userId, loginThrottle.ip],
      set: {
        attempts: sql`${loginThrottle.attempts} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
        blockedUntil: sql`CASE
          WHEN ${loginThrottle.attempts} + 1 >= 3
          THEN NOW() + (LEAST(900, ROUND(POWER(2, LEAST(10, ${loginThrottle.attempts} + 1 - 3)) * 5)) || ' seconds')::interval
          ELSE NULL
        END`,
      },
    })
    .returning({
      attempts: loginThrottle.attempts,
      blockedUntil: loginThrottle.blockedUntil,
    });

  // 2. Increment user failedAttempts (with owner hard-lock protection)
  const lockoutState = await recordFailedAttemptAtomic(
    dbOrTx,
    userId,
    now,
    maxAttempts,
    lockoutMinutes,
    isOwner,
  );

  const isBlocked = Boolean(
    throttleRow?.blockedUntil && throttleRow.blockedUntil.getTime() > now.getTime(),
  );

  return {
    failedAttempts: lockoutState.failedAttempts,
    lockedUntil: lockoutState.lockedUntil,
    throttled: isBlocked,
    blockedUntil: isBlocked && throttleRow ? throttleRow.blockedUntil : null,
    attempts: throttleRow?.attempts ?? 1,
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
 * Atomically resets the per-(user, ip) login throttle state after successful authentication.
 */
export async function resetLoginThrottleAtomic(
  dbOrTx: DbOrTx,
  userId: string,
  ip: string,
  now = new Date(),
): Promise<void> {
  await dbOrTx
    .update(loginThrottle)
    .set({
      attempts: 0,
      blockedUntil: null,
      updatedAt: now,
    })
    .where(and(eq(loginThrottle.userId, userId), eq(loginThrottle.ip, ip)));
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
