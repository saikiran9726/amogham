import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Roles, generateUuidV7, isDenylistedPin, staffCreateSchema } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { roles } from '../src/db/schema/roles.js';
import { hashPin } from '../src/auth/crypto.js';
import { env } from '../src/config/env.js';
import { authorizeApprover } from '../src/auth/approval.js';
import {
  HubSyncWorker,
  isRetryableSyncError,
  SyncHttpError,
} from '../src/services/hub/HubSyncWorker.js';

describe('Phase 1 Resilience: Hub Worker Crash Prevention & Approver PIN Lockout Persistence', () => {
  let app: FastifyInstance;
  const restaurantId = generateUuidV7();
  let roleOwnerId: string;
  let roleWaiterId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // 1. Create test restaurant
    await db.insert(restaurants).values({
      id: restaurantId,
      name: 'Resilience Test Bistro',
      address: '404 Resilience Way',
      phone: '+91 9888888888',
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
    try {
      await db.delete(users).where(eq(users.restaurantId, restaurantId));
      await db.delete(restaurants).where(eq(restaurants.id, restaurantId));
    } catch {
      // Ignore cleanup error
    }
    await app.close();
  });

  describe('PIN Denylist Schema & Validation', () => {
    it('blocks sequential ascending, descending, repeated digits, and common weak PINs', () => {
      // Repeated digits
      expect(isDenylistedPin('0000')).toBe(true);
      expect(isDenylistedPin('1111')).toBe(true);
      expect(isDenylistedPin('8888')).toBe(true);
      expect(isDenylistedPin('999999')).toBe(true);

      // Sequential ascending
      expect(isDenylistedPin('1234')).toBe(true);
      expect(isDenylistedPin('2345')).toBe(true);
      expect(isDenylistedPin('123456')).toBe(true);

      // Sequential descending
      expect(isDenylistedPin('4321')).toBe(true);
      expect(isDenylistedPin('9876')).toBe(true);
      expect(isDenylistedPin('654321')).toBe(true);

      // Repeated 2-digit patterns
      expect(isDenylistedPin('1212')).toBe(true);
      expect(isDenylistedPin('3434')).toBe(true);

      // Strong / non-sequential PINs
      expect(isDenylistedPin('9825')).toBe(false);
      expect(isDenylistedPin('8392')).toBe(false);
      expect(isDenylistedPin('7419')).toBe(false);
      expect(isDenylistedPin('395182')).toBe(false);
    });

    it('enforces pinSchema refinement and rejects weak PIN in staff creation schema', () => {
      const weakResult = staffCreateSchema.safeParse({
        name: 'Weak User',
        username: 'weak_user_1',
        role: Roles.WAITER,
        credentialType: 'pin',
        pin: '1234',
      });
      expect(weakResult.success).toBe(false);

      const strongResult = staffCreateSchema.safeParse({
        name: 'Strong User',
        username: 'strong_user_1',
        role: Roles.WAITER,
        credentialType: 'pin',
        pin: '9825',
      });
      expect(strongResult.success).toBe(true);
    });
  });

  describe('Approver PIN Lockout Persistence Across Transaction Rollbacks', () => {
    it('persists failed approver attempts even when the business transaction rolls back', async () => {
      const ownerUserId = generateUuidV7();
      const validPin = '9825';
      const wrongPin = '8392';
      const ownerPinHash = await hashPin(validPin);

      await db.insert(users).values({
        id: ownerUserId,
        restaurantId,
        roleId: roleOwnerId,
        name: 'Test Approver Owner',
        username: `approver_owner_${Date.now()}`,
        pinHash: ownerPinHash,
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      });

      // Simulate a business operation:
      // 1. Authorize approver outside transaction
      // 2. Open business transaction
      // 3. Fail business transaction and rollback
      try {
        await authorizeApprover(db, {
          restaurantId,
          approverUserId: ownerUserId,
          pin: wrongPin, // Wrong PIN
          allowedRoles: [Roles.OWNER, Roles.MANAGER],
          reason: 'test_rollback_isolation',
          entity: 'test_entity',
          entityId: 'test-1',
          actorUserId: ownerUserId,
        });
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
      }

      // Simulate a simulated transaction rollback
      try {
        await db.transaction(async (_tx) => {
          // Inner transaction does work then intentionally throws to rollback
          throw new Error('Business logic failed: rolling back parent transaction');
        });
      } catch {
        // Expected rollback
      }

      // Verify in DB that pin_failed_attempts is 1 despite the business failure
      const [userAfterFailure] = await db
        .select()
        .from(users)
        .where(eq(users.id, ownerUserId))
        .limit(1);

      expect(userAfterFailure.pinFailedAttempts).toBe(1);
      expect(userAfterFailure.pinLockedUntil).toBeNull();
      // Ensure password login columns were not touched
      expect(userAfterFailure.failedAttempts).toBe(0);
      expect(userAfterFailure.lockedUntil).toBeNull();
    });

    it('locks approver after MAX failed attempts with separate pin_locked_until', async () => {
      const ownerUserId = generateUuidV7();
      const validPin = '9825';
      const wrongPin = '8392';
      const ownerPinHash = await hashPin(validPin);

      await db.insert(users).values({
        id: ownerUserId,
        restaurantId,
        roleId: roleOwnerId,
        name: 'Lockout Test Owner',
        username: `lockout_owner_${Date.now()}`,
        pinHash: ownerPinHash,
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      });

      const maxAttempts = env.MAX_FAILED_LOGIN_ATTEMPTS; // 5

      // Fail 5 times
      for (let i = 1; i <= maxAttempts; i++) {
        try {
          await authorizeApprover(db, {
            restaurantId,
            approverUserId: ownerUserId,
            pin: wrongPin,
            allowedRoles: [Roles.OWNER, Roles.MANAGER],
            reason: 'lockout_test',
            entity: 'test_entity',
            entityId: 'test-2',
            actorUserId: ownerUserId,
          });
        } catch (err: any) {
          if (i === maxAttempts) {
            expect(err.statusCode).toBe(401);
            expect(err.message).toContain('temporarily locked');
          } else {
            expect(err.statusCode).toBe(403);
          }
        }
      }

      // Check DB
      const [lockedUser] = await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);

      expect(lockedUser.pinFailedAttempts).toBe(maxAttempts);
      expect(lockedUser.pinLockedUntil).not.toBeNull();
      expect(new Date(lockedUser.pinLockedUntil!).getTime()).toBeGreaterThan(Date.now());
      // Password login failure columns remain completely separated
      expect(lockedUser.failedAttempts).toBe(0);
      expect(lockedUser.lockedUntil).toBeNull();

      // Even with the CORRECT PIN, authorization is denied while locked
      await expect(
        authorizeApprover(db, {
          restaurantId,
          approverUserId: ownerUserId,
          pin: validPin, // Correct PIN
          allowedRoles: [Roles.OWNER, Roles.MANAGER],
          reason: 'lockout_test',
          entity: 'test_entity',
          entityId: 'test-2',
          actorUserId: ownerUserId,
        }),
      ).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('anti-enumeration: identical 403 response across missing user, inactive user, and wrong role', async () => {
      const callerUserId = generateUuidV7();
      await db.insert(users).values({
        id: callerUserId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Caller User',
        username: `caller_${Date.now()}`,
        active: true,
      });

      const nonExistentUserId = generateUuidV7();
      const pin = '9825';

      // 1. Missing approver
      await expect(
        authorizeApprover(db, {
          restaurantId,
          approverUserId: nonExistentUserId,
          pin,
          allowedRoles: [Roles.OWNER],
          entity: 'test',
          actorUserId: callerUserId,
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'Invalid approver credentials or authorization denied',
      });

      // 2. Inactive approver
      const inactiveUserId = generateUuidV7();
      await db.insert(users).values({
        id: inactiveUserId,
        restaurantId,
        roleId: roleOwnerId,
        name: 'Inactive Owner',
        username: `inactive_${Date.now()}`,
        pinHash: await hashPin(pin),
        active: false,
      });

      await expect(
        authorizeApprover(db, {
          restaurantId,
          approverUserId: inactiveUserId,
          pin,
          allowedRoles: [Roles.OWNER],
          entity: 'test',
          actorUserId: inactiveUserId,
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'Invalid approver credentials or authorization denied',
      });

      // 3. Disallowed role (WAITER cannot approve owner action)
      const waiterUserId = generateUuidV7();
      await db.insert(users).values({
        id: waiterUserId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Waiter User',
        username: `waiter_${Date.now()}`,
        pinHash: await hashPin(pin),
        active: true,
      });

      await expect(
        authorizeApprover(db, {
          restaurantId,
          approverUserId: waiterUserId,
          pin,
          allowedRoles: [Roles.OWNER],
          entity: 'test',
          actorUserId: waiterUserId,
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: 'Invalid approver credentials or authorization denied',
      });
    });

    it('resets pin_failed_attempts to 0 upon successful authorization', async () => {
      const ownerUserId = generateUuidV7();
      const validPin = '9825';
      const ownerPinHash = await hashPin(validPin);

      await db.insert(users).values({
        id: ownerUserId,
        restaurantId,
        roleId: roleOwnerId,
        name: 'Reset Test Owner',
        username: `reset_owner_${Date.now()}`,
        pinHash: ownerPinHash,
        active: true,
        pinFailedAttempts: 2,
        pinLockedUntil: null,
      });

      // Successful authorization
      const result = await authorizeApprover(db, {
        restaurantId,
        approverUserId: ownerUserId,
        pin: validPin,
        allowedRoles: [Roles.OWNER, Roles.MANAGER],
        reason: 'reset_test',
        entity: 'test',
        actorUserId: ownerUserId,
      });

      expect(result.approverId).toBe(ownerUserId);
      expect(result.role).toBe(Roles.OWNER);

      // Check DB: pinFailedAttempts reset to 0
      const [user] = await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);
      expect(user.pinFailedAttempts).toBe(0);
      expect(user.pinLockedUntil).toBeNull();
    });
  });

  describe('Hub Worker Resilience & Network Failure Handling', () => {
    it('classifies network errors, timeouts, 5xx, and 429 as retryable', () => {
      // 5xx and 429 HTTP errors
      expect(isRetryableSyncError(new SyncHttpError(429, 'Too many requests'))).toBe(true);
      expect(isRetryableSyncError(new SyncHttpError(500, 'Internal server error'))).toBe(true);
      expect(isRetryableSyncError(new SyncHttpError(502, 'Bad gateway'))).toBe(true);
      expect(isRetryableSyncError(new SyncHttpError(503, 'Service unavailable'))).toBe(true);
      expect(isRetryableSyncError(new SyncHttpError(504, 'Gateway timeout'))).toBe(true);

      // Non-retryable HTTP errors (4xx client errors)
      expect(isRetryableSyncError(new SyncHttpError(400, 'Bad request'))).toBe(false);
      expect(isRetryableSyncError(new SyncHttpError(401, 'Unauthorized'))).toBe(false);
      expect(isRetryableSyncError(new SyncHttpError(403, 'Forbidden'))).toBe(false);
      expect(isRetryableSyncError(new SyncHttpError(404, 'Not found'))).toBe(false);
      expect(isRetryableSyncError(new SyncHttpError(422, 'Unprocessable entity'))).toBe(false);

      // Native fetch & network errors
      expect(isRetryableSyncError(new Error('fetch failed'))).toBe(true);
      expect(isRetryableSyncError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(true);
      expect(isRetryableSyncError(new Error('read ECONNRESET'))).toBe(true);
      expect(isRetryableSyncError(new Error('getaddrinfo ENOTFOUND cloud.example.com'))).toBe(true);
      expect(isRetryableSyncError(new Error('The operation was aborted due to timeout'))).toBe(
        true,
      );

      const timeoutError = new Error('Request timed out');
      timeoutError.name = 'TimeoutError';
      expect(isRetryableSyncError(timeoutError)).toBe(true);

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      expect(isRetryableSyncError(abortError)).toBe(true);
    });

    it('background timer callback safely catches network failures without crashing the process', async () => {
      // Unhandled rejection tracker
      let unhandledCaught = false;
      const unhandledListener = () => {
        unhandledCaught = true;
      };
      process.on('unhandledRejection', unhandledListener);

      const failingWorker = new HubSyncWorker({
        restaurantId,
        cloudSyncUrl: 'http://127.0.0.1:1', // Unreachable network destination
        hubApiKey: 'dummy_key',
        deviceId: 'resilience-test-hub',
        syncIntervalMs: 50,
      });

      try {
        // Start worker timer loop
        failingWorker.start();

        // Let the timer fire at least twice against the failing network target
        await new Promise((resolve) => setTimeout(resolve, 350));

        // Ensure no unhandledRejection occurred
        expect(unhandledCaught).toBe(false);
      } finally {
        process.off('unhandledRejection', unhandledListener);
        await failingWorker.stop();
      }
    });

    it('gracefully awaits active cycle on stop() with timeout', async () => {
      const worker = new HubSyncWorker({
        restaurantId,
        cloudSyncUrl: 'http://127.0.0.1:1',
        hubApiKey: 'dummy_key',
        deviceId: 'stop-test-hub',
        syncIntervalMs: 1000,
      });

      worker.start();
      const stopStartTime = Date.now();
      await worker.stop();
      const elapsed = Date.now() - stopStartTime;

      // Stop completes quickly and safely
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
