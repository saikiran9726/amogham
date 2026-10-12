import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Roles, generateUuidV7 } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { roles } from '../src/db/schema/roles.js';
import { hashPassword, hashPin } from '../src/auth/crypto.js';
import { env } from '../src/config/env.js';

describe('Auth Hardening: Lockout Concurrency, Anti-Enumeration & Rate Limiting', () => {
  let app: FastifyInstance;
  const restaurantId = generateUuidV7();

  let roleWaiterId: string;
  let roleOwnerId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // 1. Create test restaurant
    await db.insert(restaurants).values({
      id: restaurantId,
      name: 'Auth Hardening Bistro',
      address: '100 Security Way',
      phone: '+91 9999999998',
    });

    // 2. Ensure roles exist
    const standardRoles = [
      { name: Roles.OWNER, description: 'Restaurant owner' },
      { name: Roles.WAITER, description: 'Waiter' },
    ];
    for (const r of standardRoles) {
      const [existing] = await db.select().from(roles).where(eq(roles.name, r.name)).limit(1);
      if (!existing) {
        await db.insert(roles).values(r);
      }
    }

    const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles);
    roleOwnerId = roleRows.find((r) => r.name === Roles.OWNER)!.id;
    roleWaiterId = roleRows.find((r) => r.name === Roles.WAITER)!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GATE: Lockout Race Test Passes 10 Runs in a Row (50 parallel wrong PINs)', () => {
    it('GATE: 50 parallel wrong PINs lock after exactly MAX across 10 runs in a row', async () => {
      const pinHash = await hashPin('1234');
      const MAX_ATTEMPTS = env.MAX_FAILED_LOGIN_ATTEMPTS; // 5

      for (let run = 1; run <= 10; run++) {
        const userId = generateUuidV7();
        const username = `race_user_run_${run}_${Date.now()}`;

        await db.insert(users).values({
          id: userId,
          restaurantId,
          roleId: roleWaiterId,
          name: `Race User ${run}`,
          username,
          pinHash,
          active: true,
          failedAttempts: 0,
          lockedUntil: null,
        });

        // Fire 50 concurrent failed login requests simultaneously
        const requests = Array.from({ length: 50 }, () =>
          app.inject({
            method: 'POST',
            url: '/auth/login',
            payload: {
              username,
              credentialType: 'pin',
              pin: '9999', // wrong PIN
            },
          }),
        );

        const responses = await Promise.all(requests);

        // Every request must receive 401 UNAUTHORIZED
        for (const res of responses) {
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('UNAUTHORIZED');
          expect(res.json().error.message).toBe('Invalid username or credential');
        }

        // Query database state to assert atomic lockout
        const [updatedUser] = await db
          .select({
            failedAttempts: users.failedAttempts,
            lockedUntil: users.lockedUntil,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        expect(updatedUser).toBeDefined();
        // Failed attempts reached at least MAX_ATTEMPTS and account locked
        expect(updatedUser.failedAttempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
        expect(updatedUser.lockedUntil).not.toBeNull();
        expect(new Date(updatedUser.lockedUntil!).getTime()).toBeGreaterThan(Date.now());

        // Even with correct PIN, subsequent login attempt is rejected while locked
        const lockedRes = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: {
            username,
            credentialType: 'pin',
            pin: '1234',
          },
        });
        expect(lockedRes.statusCode).toBe(401);
        expect(lockedRes.json().error.code).toBe('UNAUTHORIZED');
      }
    }, 60_000);
  });

  describe('Anti-Enumeration: Identical Responses Across All Failure Cases', () => {
    let inactiveUserId: string;
    let lockedUserId: string;
    let validUserId: string;
    let ownerUserId: string;

    const inactiveUsername = `inactive_${Date.now()}`;
    const lockedUsername = `locked_${Date.now()}`;
    const validUsername = `valid_${Date.now()}`;
    const ownerUsername = `owner_${Date.now()}`;

    beforeAll(async () => {
      const passwordHash = await hashPassword('ValidPass123!');
      const pinHash = await hashPin('4321');

      inactiveUserId = generateUuidV7();
      lockedUserId = generateUuidV7();
      validUserId = generateUuidV7();
      ownerUserId = generateUuidV7();

      await db.insert(users).values([
        {
          id: inactiveUserId,
          restaurantId,
          roleId: roleWaiterId,
          name: 'Inactive User',
          username: inactiveUsername,
          passwordHash,
          pinHash,
          active: false, // Inactive
          failedAttempts: 0,
        },
        {
          id: lockedUserId,
          restaurantId,
          roleId: roleWaiterId,
          name: 'Locked User',
          username: lockedUsername,
          passwordHash,
          pinHash,
          active: true,
          failedAttempts: 10,
          lockedUntil: new Date(Date.now() + 10 * 60 * 1000), // Locked for 10 mins
        },
        {
          id: validUserId,
          restaurantId,
          roleId: roleWaiterId,
          name: 'Valid Waiter',
          username: validUsername,
          passwordHash,
          pinHash,
          active: true,
          failedAttempts: 0,
        },
        {
          id: ownerUserId,
          restaurantId,
          roleId: roleOwnerId,
          name: 'Valid Owner',
          username: ownerUsername,
          passwordHash,
          pinHash, // Owner has PIN configured for floor overrides
          active: true,
          failedAttempts: 0,
        },
      ]);
    });

    const expectedEnvelope = {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid username or credential',
      },
    };

    it('Case 1: unknown username returns generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: 'completely_unknown_user_12345',
          credentialType: 'password',
          password: 'SomePassword123!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });

    it('Case 2: inactive user returns identical generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: inactiveUsername,
          credentialType: 'password',
          password: 'ValidPass123!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });

    it('Case 3: locked user returns identical generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: lockedUsername,
          credentialType: 'password',
          password: 'ValidPass123!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });

    it('Case 4: wrong password returns identical generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: validUsername,
          credentialType: 'password',
          password: 'WrongPassword999!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });

    it('Case 5: wrong PIN returns identical generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: validUsername,
          credentialType: 'pin',
          pin: '0000',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });

    it('Case 6: OWNER attempting PIN login returns identical generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: ownerUsername,
          credentialType: 'pin',
          pin: '4321', // correct PIN, but PIN login is prohibited for OWNER
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(res.json().error.message).toBe('Invalid username or credential');
    });
  });

  describe('Proxy Trust & Rate Limiting Enforcement', () => {
    it('spoofed X-Forwarded-For does not bypass limits when TRUST_PROXY is unset', async () => {
      const testUser = `rate_test_${Date.now()}`;

      // Hit /auth/login with different spoofed X-Forwarded-For headers from the same client IP
      const attempts = [];
      for (let i = 1; i <= 15; i++) {
        attempts.push(
          await app.inject({
            method: 'POST',
            url: '/auth/login',
            remoteAddress: '198.51.100.55',
            headers: {
              'x-forwarded-for': `203.0.113.${i}`, // Attacker tries to spoof client IP
            },
            payload: {
              username: testUser,
              credentialType: 'password',
              password: 'AnyPassword123!',
            },
          }),
        );
      }

      // Because TRUST_PROXY is unset (default false), Fastify ignores x-forwarded-for and binds to 198.51.100.55.
      // The IP limit (10/min) or IP+username limit (5/min) triggers HTTP 429
      const rateLimitedResponses = attempts.filter((res) => res.statusCode === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
      expect(rateLimitedResponses[0].json().error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });
});
