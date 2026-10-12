import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Roles, ROLE_DEFAULT_PERMISSIONS, Permissions } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';

import { pool } from '../src/db/client.js';

describe('Offline Sync & Local Hub Integration Tests', () => {
  let app: FastifyInstance;

  const testRestaurantId = '018f9e1e-2895-7800-9831-294719283748';

  const ownerToken = signAccessToken({
    userId: '018f9e1e-2895-7800-9831-111111111111',
    restaurantId: testRestaurantId,
    username: 'owner_user',
    name: 'Owner',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  const waiterToken = signAccessToken({
    userId: '018f9e1e-2895-7800-9831-222222222222',
    restaurantId: testRestaurantId,
    username: 'waiter_user',
    name: 'Waiter',
    role: Roles.WAITER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
  });

  const kitchenToken = signAccessToken({
    userId: '018f9e1e-2895-7800-9831-333333333333',
    restaurantId: testRestaurantId,
    username: 'kitchen_user',
    name: 'Kitchen',
    role: Roles.KITCHEN,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.KITCHEN],
  });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    await pool.query(
      `INSERT INTO restaurants (id, name)
       VALUES ($1, 'Test Restaurant')
       ON CONFLICT (id) DO NOTHING`,
      [testRestaurantId],
    );
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM restaurants WHERE id = $1', [testRestaurantId]);
    } catch {
      // Ignore cleanup error
    }
    await app.close();
  });

  describe('RBAC & Role Isolation', () => {
    it('blocks unauthenticated requests to /sync/push', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        payload: {
          restaurantId: testRestaurantId,
          deviceId: 'dev-001',
          batchId: 'batch-001',
          commands: [],
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('blocks waiter from viewing sync status overview (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/status',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks kitchen from registering a local hub (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/register',
        headers: { authorization: `Bearer ${kitchenToken}` },
        payload: {
          deviceId: 'hub-001',
          name: 'Kitchen Hub',
          hostAddress: '192.168.1.100:3000',
          apiKey: 'super-secret-hub-key-1234',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks waiter from viewing dead letter commands (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/dead-letter',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks waiter from viewing conflict reviews (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/conflicts',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows owner to access /sync/status passing RBAC guard', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/status',
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    it('returns dead-letter records in the success/data response envelope', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/dead-letter',
        headers: { authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        data: expect.any(Array),
      });
    });

    it('allows the browser preflight header used by outbox order creation', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/orders',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,idempotency-key',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-headers']).toMatch(/\bidempotency-key\b/i);
    });
  });

  describe('Validation & Batch Guards', () => {
    it('rejects push batch with empty commands array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${waiterToken}` },
        payload: {
          restaurantId: testRestaurantId,
          deviceId: 'dev-001',
          batchId: 'batch-001',
          commands: [],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects hub registration with short apiKey', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/register',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: 'hub-001',
          name: 'Local Hub',
          hostAddress: '192.168.1.100:3000',
          apiKey: 'short', // Min 8 chars
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects discarding dead-letter without explanatory reason', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/dead-letter/018f9e1e-2895-7800-9831-000000000000/discard',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          reason: 'no', // Min 3 chars
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects conflict resolution without explanatory note', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/conflicts/018f9e1e-2895-7800-9831-000000000000/resolve',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          resolutionNote: '  ',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects cross-tenant push with 403 TENANT_MISMATCH when payload restaurantId differs from token', async () => {
      const foreignRestaurantId = '018f9e1e-2895-7800-9831-999999999999';
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${waiterToken}` },
        payload: {
          restaurantId: foreignRestaurantId,
          deviceId: 'dev-001',
          batchId: '018f9e1e-2895-7800-9831-000000000001',
          commands: [
            {
              id: '018f9e1e-2895-7800-9831-000000000002',
              idempotencyKey: 'cmd-cross-tenant-1',
              deviceId: 'dev-001',
              type: 'order.create',
              payload: {
                id: '018f9e1e-2895-7800-9831-000000000003',
                type: 'dine_in',
                items: [],
              },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('TENANT_MISMATCH');
    });

    it('rejects payment.record command pushed by KITCHEN token with FORBIDDEN error code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${kitchenToken}` },
        payload: {
          deviceId: 'kitchen-dev-1',
          batchId: '018f9e1e-2895-7800-9831-000000000010',
          commands: [
            {
              id: '018f9e1e-2895-7800-9831-000000000011',
              idempotencyKey: 'cmd-kitchen-pay-1',
              deviceId: 'kitchen-dev-1',
              type: 'payment.record',
              payload: {
                billId: '018f9e1e-2895-7800-9831-000000000012',
                amountPaise: 5000,
                method: 'cash',
              },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.results[0].status).toBe('rejected');
      expect(data.results[0].errorCode).toBe('FORBIDDEN');
    });

    it('rejects negative, zero, fractional, NaN, or capped amounts in payment.record payload', async () => {
      for (const invalidAmount of [-500, 0, 10.5, 'not-a-number', 1_500_000_000]) {
        const res = await app.inject({
          method: 'POST',
          url: '/sync/push',
          headers: { authorization: `Bearer ${waiterToken}` },
          payload: {
            deviceId: 'waiter-dev-1',
            batchId: '018f9e1e-2895-7800-9831-000000000020',
            commands: [
              {
                id: '018f9e1e-2895-7800-9831-000000000021',
                idempotencyKey: `cmd-invalid-amt-${invalidAmount}`,
                deviceId: 'waiter-dev-1',
                type: 'payment.record',
                payload: {
                  billId: '018f9e1e-2895-7800-9831-000000000022',
                  amountPaise: invalidAmount,
                  method: 'cash',
                },
              },
            ],
          },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.results[0].status).toBe('rejected');
        expect(data.results[0].errorCode).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects unknown command type with UNKNOWN_COMMAND_TYPE without dead-lettering', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: 'owner-dev-1',
          batchId: '018f9e1e-2895-7800-9831-000000000030',
          commands: [
            {
              id: '018f9e1e-2895-7800-9831-000000000031',
              idempotencyKey: 'cmd-unknown-type-1',
              deviceId: 'owner-dev-1',
              type: 'arbitrary.dangerous.command',
              payload: {},
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.results[0].status).toBe('rejected');
      expect(data.results[0].errorCode).toBe('UNKNOWN_COMMAND_TYPE');
    });

    it('validates /sync/pull query parameters (since >= 0, limit 1..500, default 100)', async () => {
      const negativeSince = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=-1',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(negativeSince.statusCode).toBe(400);

      const excessiveLimit = await app.inject({
        method: 'GET',
        url: '/sync/pull?limit=9999',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(excessiveLimit.statusCode).toBe(400);

      const validPull = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0&limit=50',
        headers: { authorization: `Bearer ${waiterToken}` },
      });
      expect(validPull.statusCode).toBe(200);
    });
  });
});
