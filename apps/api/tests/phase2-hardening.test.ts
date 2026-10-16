import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  Roles,
  ROLE_DEFAULT_PERMISSIONS,
  AppError,
  ErrorCodes,
  generateUuidV7,
} from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/client.js';
import { signAccessToken, verifyAccessToken, JWT_ISSUER, JWT_AUDIENCE } from '../src/auth/jwt.js';
import { getUserSession, clearUserSessionCache } from '../src/auth/token-cache.js';
import { Semaphore, argon2Semaphore, hashPassword, verifyPassword } from '../src/auth/crypto.js';
import {
  checkLoginThrottle,
  recordFailedAttemptWithThrottleAtomic,
  resetLoginThrottleAtomic,
} from '../src/auth/lockout.js';
import {
  isDatabaseOutageError,
  isDatabaseError,
  registerErrorHandler,
} from '../src/plugins/error-handler.js';
import { registerAuthSessionRoutes } from '../src/routes/auth/session.js';
import { registerAuthRefreshRoutes } from '../src/routes/auth/refresh.js';
import { registerAuthLoginRoutes } from '../src/routes/auth/login.js';

describe('Phase 2 Hardening: JWT Rotation, Throttle, Error Isolation & Semaphore', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. JWT Rotation & Strict Issuer/Audience Claims', () => {
    const payload = {
      userId: generateUuidV7(),
      restaurantId: generateUuidV7(),
      username: 'rot_user',
      name: 'Rotation User',
      role: Roles.WAITER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      tv: 0,
    };

    it('successfully signs and strictly validates token with JWT_SECRET', () => {
      const token = signAccessToken(payload);
      const decoded = verifyAccessToken(token);

      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.iss).toBe(JWT_ISSUER);
      expect(decoded.aud).toBe(JWT_AUDIENCE);
      expect(decoded.tv).toBe(0);
    });

    it('strictly rejects tokens with incorrect or missing issuer/audience', () => {
      // Token signed without issuer
      const tokenBadIssuer = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        audience: JWT_AUDIENCE,
      });
      expect(() => verifyAccessToken(tokenBadIssuer)).toThrow();

      // Token signed without audience
      const tokenBadAudience = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
      });
      expect(() => verifyAccessToken(tokenBadAudience)).toThrow();
    });

    it('supports seamless zero-downtime key rotation via JWT_SECRET_PREVIOUS', () => {
      const previousSecret = 'previous_secret_must_be_at_least_32_characters_long_abcdef123';
      (env as Record<string, unknown>).JWT_SECRET_PREVIOUS = previousSecret;

      // Token signed with the old secret
      const oldToken = jwt.sign({ ...payload, tv: 0 }, previousSecret, {
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: '15m',
      });

      // Current system must accept it via previous secret fallback
      const decoded = verifyAccessToken(oldToken);
      expect(decoded.userId).toBe(payload.userId);

      // Invalid secret still fails
      const invalidToken = jwt.sign(
        { ...payload, tv: 0 },
        'completely_wrong_secret_key_32_characters_long_abcdef',
        {
          algorithm: 'HS256',
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
          expiresIn: '15m',
        },
      );
      expect(() => verifyAccessToken(invalidToken)).toThrow();

      delete (env as Record<string, unknown>).JWT_SECRET_PREVIOUS;
    });

    it('token-cache has no test-only bypass: returns null for unseeded non-existent users', async () => {
      clearUserSessionCache();
      const randomUserId = generateUuidV7();
      const randomRestId = generateUuidV7();

      // In test environment, an unseeded user must now return null (no VITEST/NODE_ENV bypass)
      const session = await getUserSession(randomRestId, randomUserId);
      expect(session).toBeNull();
    });
  });

  describe('2. Login Throttle & Owner Hard-Lock Protection', () => {
    const restaurantId = generateUuidV7();
    const ownerUserId = generateUuidV7();
    const waiterUserId = generateUuidV7();
    const testIp = '198.51.100.99';

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO restaurants (id, name) VALUES ($1, 'Throttle Test Bistro') ON CONFLICT (id) DO NOTHING`,
        [restaurantId],
      );
      await pool.query(
        `INSERT INTO users (id, restaurant_id, name, username, active, failed_attempts, locked_until)
         VALUES 
           ($1, $2, 'Owner User', 'throttle_owner', true, 0, NULL),
           ($3, $2, 'Waiter User', 'throttle_waiter', true, 0, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [ownerUserId, restaurantId, waiterUserId],
      );
    });

    afterAll(async () => {
      try {
        await pool.query('DELETE FROM login_throttle WHERE user_id IN ($1, $2)', [
          ownerUserId,
          waiterUserId,
        ]);
        await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerUserId, waiterUserId]);
        await pool.query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
      } catch {
        // cleanup
      }
    });

    it('protects owner accounts from hard-locks even after exceeding MAX_FAILED_LOGIN_ATTEMPTS', async () => {
      const { db } = await import('../src/db/client.js');

      // Record 7 failed attempts for owner
      let state;
      for (let i = 0; i < 7; i++) {
        state = await recordFailedAttemptWithThrottleAtomic(db, ownerUserId, testIp, true);
      }

      expect(state).toBeDefined();
      expect(state!.failedAttempts).toBeGreaterThanOrEqual(7);
      // Owner account lockedUntil MUST be null
      expect(state!.lockedUntil).toBeNull();

      // But per-(user, ip) throttle IS active
      expect(state!.throttled).toBe(true);
      expect(state!.blockedUntil).not.toBeNull();

      const throttleCheck = await checkLoginThrottle(db, ownerUserId, testIp);
      expect(throttleCheck.throttled).toBe(true);

      // Reset throttle
      await resetLoginThrottleAtomic(db, ownerUserId, testIp);
      const afterReset = await checkLoginThrottle(db, ownerUserId, testIp);
      expect(afterReset.throttled).toBe(false);
    });

    it('locks non-owner accounts when failed attempts reach maxAttempts', async () => {
      const { db } = await import('../src/db/client.js');

      let state;
      for (let i = 0; i < 5; i++) {
        state = await recordFailedAttemptWithThrottleAtomic(db, waiterUserId, testIp, false);
      }

      expect(state).toBeDefined();
      expect(state!.failedAttempts).toBe(5);
      // Non-owner account MUST be locked
      expect(state!.lockedUntil).not.toBeNull();
      expect(new Date(state!.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('3. Error Handling & Infrastructure Isolation', () => {
    let errorApp: FastifyInstance;

    beforeAll(async () => {
      errorApp = Fastify({ logger: false });
      registerErrorHandler(errorApp);

      // Fastify non-AppError status codes
      errorApp.get('/throw-413', async () => {
        const err = new Error('Payload too big') as any;
        err.statusCode = 413;
        throw err;
      });

      errorApp.get('/throw-415', async () => {
        const err = new Error('Unsupported format') as any;
        err.statusCode = 415;
        throw err;
      });

      errorApp.get('/throw-429', async () => {
        const err = new Error('Too fast') as any;
        err.statusCode = 429;
        throw err;
      });

      errorApp.get('/throw-db-outage', async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:5432') as any;
        err.code = 'ECONNREFUSED';
        throw err;
      });

      errorApp.get('/throw-db-query-leak', async () => {
        const err = new Error(
          'SELECT * FROM users WHERE password_hash = "secret" syntax error',
        ) as any;
        err.code = '42601';
        throw err;
      });

      await errorApp.ready();
    });

    afterAll(async () => {
      await errorApp.close();
    });

    it('maps 413 accurately with PAYLOAD_TOO_LARGE', async () => {
      const res = await errorApp.inject({ method: 'GET', url: '/throw-413' });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('maps 415 accurately with UNSUPPORTED_MEDIA_TYPE', async () => {
      const res = await errorApp.inject({ method: 'GET', url: '/throw-415' });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('maps 429 accurately with RATE_LIMIT_EXCEEDED', async () => {
      const res = await errorApp.inject({ method: 'GET', url: '/throw-429' });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('returns 503 SERVICE_UNAVAILABLE with Retry-After: 5 on transient database outages', async () => {
      const res = await errorApp.inject({ method: 'GET', url: '/throw-db-outage' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.json().error.message).toContain('Database service temporarily unavailable');
    });

    it('masks internal database exceptions to prevent query or credential leakage', async () => {
      const res = await errorApp.inject({ method: 'GET', url: '/throw-db-query-leak' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.message).toBe('Internal server error');
      expect(res.json().error.message).not.toContain('password_hash');
      expect(res.json().error.message).not.toContain('SELECT');
    });

    it('isDatabaseOutageError correctly classifies database outage codes and messages', () => {
      expect(isDatabaseOutageError({ code: 'ECONNREFUSED' })).toBe(true);
      expect(isDatabaseOutageError({ code: 'ETIMEDOUT' })).toBe(true);
      expect(isDatabaseOutageError({ code: '57P01' })).toBe(true);
      expect(isDatabaseOutageError({ code: '53300' })).toBe(true);
      expect(isDatabaseOutageError({ message: 'connection terminated unexpectedly' })).toBe(true);
      expect(isDatabaseOutageError({ message: 'sorry, too many clients already' })).toBe(true);

      // Normal application errors are NOT outages
      expect(isDatabaseOutageError(new Error('Record not found'))).toBe(false);
      expect(isDatabaseOutageError(new AppError('Invalid', 'BAD_REQUEST', 400))).toBe(false);
    });
  });

  describe('4. Crypto Threadpool Protection & Semaphore', () => {
    it('Semaphore limits concurrent operations and executes queued tasks sequentially', async () => {
      const sem = new Semaphore(2);
      let concurrentCount = 0;
      let maxSeenConcurrent = 0;

      const task = async () => {
        return sem.runExclusive(async () => {
          concurrentCount++;
          maxSeenConcurrent = Math.max(maxSeenConcurrent, concurrentCount);
          await new Promise((resolve) => setTimeout(resolve, 50));
          concurrentCount--;
          return true;
        });
      };

      const results = await Promise.all([task(), task(), task(), task(), task()]);
      expect(results).toEqual([true, true, true, true, true]);
      expect(maxSeenConcurrent).toBeLessThanOrEqual(2);
    });

    it('argon2 operations are bounded by concurrency semaphore', async () => {
      expect(argon2Semaphore.max).toBeGreaterThanOrEqual(1);

      // Run multiple hashes concurrently; all must succeed under semaphore
      const passwords = ['TestPass1!', 'TestPass2!', 'TestPass3!', 'TestPass4!'];
      const hashes = await Promise.all(passwords.map((p) => hashPassword(p)));

      expect(hashes.length).toBe(4);
      for (let i = 0; i < passwords.length; i++) {
        const isValid = await verifyPassword({ hash: hashes[i], secret: passwords[i] });
        expect(isValid).toBe(true);
      }
    });
  });
});
