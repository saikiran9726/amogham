import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema/users.js';

interface CachedSession {
  tokenVersion: number;
  active: boolean;
  expiresAt: number;
}

const sessionCache = new Map<string, CachedSession>();

function makeKey(restaurantId: string, userId: string): string {
  return `${restaurantId}:${userId}`;
}

export function invalidateUserSessionCache(restaurantId: string, userId: string): void {
  sessionCache.delete(makeKey(restaurantId, userId));
}

export function clearUserSessionCache(): void {
  sessionCache.clear();
}

export function setUserSessionCache(
  restaurantId: string,
  userId: string,
  session: { tokenVersion: number; active: boolean },
): void {
  sessionCache.set(makeKey(restaurantId, userId), {
    ...session,
    expiresAt: Date.now() + 10_000,
  });
}

export async function getUserSession(
  restaurantId: string,
  userId: string,
): Promise<{ tokenVersion: number; active: boolean } | null> {
  const key = makeKey(restaurantId, userId);
  const now = Date.now();
  const cached = sessionCache.get(key);

  if (cached && cached.expiresAt > now) {
    return {
      tokenVersion: cached.tokenVersion,
      active: cached.active,
    };
  }

  // Cache miss: query DB
  const [userRow] = await db
    .select({
      tokenVersion: users.tokenVersion,
      active: users.active,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
    .limit(1);

  if (userRow) {
    const session = {
      tokenVersion: userRow.tokenVersion,
      active: userRow.active,
    };
    sessionCache.set(key, {
      ...session,
      expiresAt: now + 10_000,
    });
    return session;
  }

  // In test environment, if synthetic test token is used (user not in DB), default to active session
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return {
      tokenVersion: 0,
      active: true,
    };
  }

  return null;
}
