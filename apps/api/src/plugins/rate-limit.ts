import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '@restaurant-os/shared';
import { env } from '../config/env.js';

export interface IRateLimitStore {
  incr(key: string, ttlMs: number): Promise<{ current: number; ttlRemainingMs: number }>;
  reset(key: string): Promise<void>;
  destroy?(): void;
}

export class InMemoryRateLimitStore implements IRateLimitStore {
  private records = new Map<string, { current: number; expiresAt: number }>();
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(sweepIntervalMs = 30_000) {
    this.sweepInterval = setInterval(() => this.sweep(), sweepIntervalMs);
    if (this.sweepInterval && typeof this.sweepInterval.unref === 'function') {
      this.sweepInterval.unref();
    }
  }

  async incr(key: string, ttlMs: number): Promise<{ current: number; ttlRemainingMs: number }> {
    const now = Date.now();
    const existing = this.records.get(key);

    if (!existing || existing.expiresAt <= now) {
      const entry = { current: 1, expiresAt: now + ttlMs };
      this.records.set(key, entry);
      return { current: 1, ttlRemainingMs: ttlMs };
    }

    existing.current += 1;
    const ttlRemainingMs = Math.max(0, existing.expiresAt - now);
    return { current: existing.current, ttlRemainingMs };
  }

  async reset(key: string): Promise<void> {
    this.records.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.records.entries()) {
      if (entry.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    this.records.clear();
  }
}

let rateLimitStoreInstance: IRateLimitStore = new InMemoryRateLimitStore();

export function getRateLimitStore(): IRateLimitStore {
  return rateLimitStoreInstance;
}

export function setRateLimitStore(store: IRateLimitStore): void {
  rateLimitStoreInstance = store;
}

/**
 * Checks a specific rate limit bucket against the configured store.
 * Throws 429 RATE_LIMIT_EXCEEDED when exceeded.
 */
export async function checkRateLimit({
  key,
  max,
  ttlMs = 60_000,
  errorMessage,
}: {
  key: string;
  max: number;
  ttlMs?: number;
  errorMessage?: string;
}): Promise<void> {
  const store = getRateLimitStore();
  const { current, ttlRemainingMs } = await store.incr(key, ttlMs);
  if (current > max) {
    const seconds = Math.max(1, Math.ceil(ttlRemainingMs / 1000));
    throw AppError.rateLimitExceeded(
      errorMessage || `Rate limit exceeded. Try again in ${seconds} seconds.`,
    );
  }
}

/**
 * Route-specific check for /auth/login: 5 requests per minute per IP+username.
 */
export async function checkLoginIpUsernameRateLimit(ip: string, username: string): Promise<void> {
  if (env.NODE_ENV === 'test' && (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost')) {
    return;
  }

  const normalizedUsername = (username || '').trim().toLowerCase();
  await checkRateLimit({
    key: `rl:login:ip_user:${ip}:${normalizedUsername}`,
    max: 5,
    ttlMs: 60_000,
    errorMessage: 'Too many login attempts for this username from this network. Try again later.',
  });
}

/**
 * Route-specific check for approval endpoints: 10 requests per minute per user.
 */
export async function checkApprovalRateLimit(userId: string): Promise<void> {
  await checkRateLimit({
    key: `rl:approval:user:${userId}`,
    max: 10,
    ttlMs: 60_000,
    errorMessage: 'Too many approval authorization requests. Please try again later.',
  });
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  // Loopback allow-list is only enabled in test environment (NODE_ENV=test)
  const allowList = env.NODE_ENV === 'test' ? ['127.0.0.1', '::1'] : [];

  await app.register(rateLimit, {
    max: 100, // conservative: 100 requests per minute per IP
    timeWindow: '1 minute',
    allowList,
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      },
    }),
  });

  app.addHook('onClose', async () => {
    rateLimitStoreInstance.destroy?.();
  });
}
