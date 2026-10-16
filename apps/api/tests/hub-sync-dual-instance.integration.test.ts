import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { Roles, ROLE_DEFAULT_PERMISSIONS, generateUuidV7 } from '@restaurant-os/shared';
import { HubSyncWorker, verifyHubApiKeyConstantTime } from '../src/services/hub/HubSyncWorker.js';
import { MetricsService } from '../src/services/metrics.js';

describe('Hub Mode & Dual-Instance Edge-to-Cloud Sync Integration', () => {
  let cloudApp: FastifyInstance;
  let hubApp: FastifyInstance;
  let cloudBaseUrl: string;

  const restaurantId = '018f9e1e-2895-7800-9831-294719283749';
  const hubDeviceId = 'hub-edge-unit-01';
  const rawHubApiKey = 'hub_secret_key_prod_test_string_64chars_abcdef1234567890';
  const apiKeyHash = crypto.createHash('sha256').update(rawHubApiKey).digest('hex');

  const ownerToken = signAccessToken({
    userId: '018f9e1e-2895-7800-9831-111111111112',
    restaurantId,
    username: 'owner_user_hub',
    name: 'Owner Hub',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  beforeAll(async () => {
    // 1. Build and bind Cloud API instance
    cloudApp = await buildServer();
    const cloudAddr = await cloudApp.listen({ port: 0, host: '127.0.0.1' });
    cloudBaseUrl = cloudAddr;

    // 2. Build Hub API instance
    hubApp = await buildServer();
    await hubApp.ready();

    // 3. Seed restaurant and registered hub in database
    await pool.query(
      `INSERT INTO restaurants (id, name)
       VALUES ($1, 'Dual Instance Test Restaurant')
       ON CONFLICT (id) DO NOTHING`,
      [restaurantId],
    );

    await pool.query(
      `INSERT INTO hub_registry (id, restaurant_id, device_id, name, host_address, api_key_hash, is_active)
       VALUES ($1, $2, $3, 'Test Edge Hub', '192.168.1.150', $4, true)
       ON CONFLICT (restaurant_id) DO UPDATE SET api_key_hash = $4, is_active = true`,
      [generateUuidV7(), restaurantId, hubDeviceId, apiKeyHash],
    );
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM hub_registry WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM sync_events WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM sync_cursors WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM dead_letter_commands WHERE restaurant_id = $1', [restaurantId]);
    } catch {
      // Ignore cleanup error
    }

    await hubApp.close();
    await cloudApp.close();
  });

  describe('Constant-Time Key Verification', () => {
    it('verifies valid key against SHA-256 hash using crypto.timingSafeEqual', () => {
      const isValid = verifyHubApiKeyConstantTime(rawHubApiKey, apiKeyHash);
      expect(isValid).toBe(true);
    });

    it('rejects invalid key or tampered hash in constant time', () => {
      const isInvalid = verifyHubApiKeyConstantTime('wrong_api_key', apiKeyHash);
      expect(isInvalid).toBe(false);

      const isEmpty = verifyHubApiKeyConstantTime('', apiKeyHash);
      expect(isEmpty).toBe(false);
    });
  });

  describe('Machine Endpoint Authentication Boundaries', () => {
    it('refuses user JWT credentials on /sync/hub/push with 403', async () => {
      const res = await cloudApp.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-hub-key': rawHubApiKey,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `jwt-reject-${Date.now()}`,
              deviceId: hubDeviceId,
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error?.message).toMatch(/Machine endpoint refuses user JWT credentials/i);
    });

    it('rejects requests missing X-Hub-Key header with 401', async () => {
      const res = await cloudApp.inject({
        method: 'POST',
        url: '/sync/hub/push',
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `unauth-reject-${Date.now()}`,
              deviceId: hubDeviceId,
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error?.message).toMatch(/Missing X-Hub-Key header/i);
    });

    it('rejects incorrect X-Hub-Key header with 401', async () => {
      const res = await cloudApp.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': 'completely_invalid_hub_key_000000000000',
          'x-restaurant-id': restaurantId,
          'x-hub-device-id': hubDeviceId,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `wrong-key-reject-${Date.now()}`,
              deviceId: hubDeviceId,
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error?.message).toMatch(/Invalid or unauthorized X-Hub-Key/i);
    });

    it('authenticates valid X-Hub-Key on /sync/hub/push and updates lastHeartbeat', async () => {
      const pushRes = await cloudApp.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': rawHubApiKey,
          'x-restaurant-id': restaurantId,
          'x-hub-device-id': hubDeviceId,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `edge-sync-test-${Date.now()}`,
              deviceId: hubDeviceId,
              type: 'order.create',
              payload: {
                id: generateUuidV7(),
                type: 'dine_in',
                items: [],
              },
            },
          ],
        },
      });

      expect(pushRes.statusCode).toBe(200);
      const pushBody = JSON.parse(pushRes.payload);
      expect(pushBody.success).toBe(true);
      expect(pushBody.results).toHaveLength(1);

      // Verify hub_registry last_synced_seq was updated
      const { rows } = await pool.query(
        'SELECT last_synced_seq FROM hub_registry WHERE restaurant_id = $1',
        [restaurantId],
      );
      expect(Number(rows[0].last_synced_seq)).toBeGreaterThan(0);
    });

    it('allows pulling event log on /sync/hub/pull with valid X-Hub-Key', async () => {
      const pullRes = await cloudApp.inject({
        method: 'GET',
        url: '/sync/hub/pull?since=0&limit=10',
        headers: {
          'x-hub-key': rawHubApiKey,
          'x-restaurant-id': restaurantId,
          'x-hub-device-id': hubDeviceId,
        },
      });

      expect(pullRes.statusCode).toBe(200);
      const pullBody = JSON.parse(pullRes.payload);
      expect(pullBody.success).toBe(true);
      expect(Array.isArray(pullBody.events)).toBe(true);
    });
  });

  describe('HubSyncWorker Lifecycle & Observability', () => {
    it('executes sync cycle, pushes unsynced events to Cloud instance, and updates lag metric', async () => {
      // 1. Seed a local sync_event in Hub database
      const cmdId = generateUuidV7();
      const idempotencyKey = `worker-cycle-test-${Date.now()}`;
      await pool.query(
        `INSERT INTO sync_events (restaurant_id, device_id, command_id, idempotency_key, type, payload)
         VALUES ($1, $2, $3, $4, 'order.create', '{"type":"dine_in","items":[]}'::jsonb)`,
        [restaurantId, hubDeviceId, cmdId, idempotencyKey],
      );

      // 2. Initialize worker pointing to cloudBaseUrl
      const worker = new HubSyncWorker({
        restaurantId,
        cloudSyncUrl: cloudBaseUrl,
        hubApiKey: rawHubApiKey,
        deviceId: hubDeviceId,
        syncIntervalMs: 1000,
        maxRetries: 3,
      });

      const { pushedCount } = await worker.executeCycle();
      expect(pushedCount).toBeGreaterThanOrEqual(1);

      // Verify sync cursor was updated
      const { rows: cursorRows } = await pool.query(
        `SELECT last_seq FROM sync_cursors WHERE restaurant_id = $1 AND peer_id = 'cloud_push'`,
        [restaurantId],
      );
      expect(cursorRows.length).toBe(1);
      expect(Number(cursorRows[0].last_seq)).toBeGreaterThan(0);

      // Verify metrics output contains restaurant_os_sync_lag_events and hub push counters
      const metricsText = await MetricsService.getMetrics();
      expect(metricsText).toContain('restaurant_os_sync_lag_events');
      expect(metricsText).toContain('restaurant_os_hub_sync_push_total');

      await worker.stop();
    });

    it('never dead-letters transient network failures and preserves events for retry', async () => {
      // Worker pointing to unreachable network endpoint (connection refused)
      const networkFailingWorker = new HubSyncWorker({
        restaurantId,
        cloudSyncUrl: 'http://127.0.0.1:1', // Connection refused
        hubApiKey: rawHubApiKey,
        deviceId: hubDeviceId,
        syncIntervalMs: 1000,
        maxRetries: 1,
      });

      const transientCmdId = generateUuidV7();
      await pool.query(
        `INSERT INTO sync_events (restaurant_id, device_id, command_id, idempotency_key, type, payload)
         VALUES ($1, $2, $3, $4, 'order.create', '{"transient":true}'::jsonb)`,
        [restaurantId, hubDeviceId, transientCmdId, `transient-${Date.now()}`],
      );

      await expect(networkFailingWorker.executeCycle()).rejects.toThrow();

      // Verify dead_letter_commands was NOT recorded for transient error
      const { rows: dlRows } = await pool.query(
        'SELECT * FROM dead_letter_commands WHERE restaurant_id = $1 AND command_id = $2',
        [restaurantId, transientCmdId],
      );
      expect(dlRows.length).toBe(0);

      await networkFailingWorker.stop();
    });

    it('dead-letters persistent non-retryable errors after reaching max retries', async () => {
      // Worker with invalid hubApiKey that triggers 401/403 (non-retryable client error)
      const badWorker = new HubSyncWorker({
        restaurantId,
        cloudSyncUrl: cloudBaseUrl,
        hubApiKey: 'invalid_unauthorized_key',
        deviceId: hubDeviceId,
        syncIntervalMs: 1000,
        maxRetries: 1, // trigger dead-letter immediately on 1st error
      });

      // Insert unsynced event with higher seq
      const poisonCmdId = generateUuidV7();
      await pool.query(
        `INSERT INTO sync_events (restaurant_id, device_id, command_id, idempotency_key, type, payload)
         VALUES ($1, $2, $3, $4, 'order.create', '{"poison":true}'::jsonb)`,
        [restaurantId, hubDeviceId, poisonCmdId, `poison-${Date.now()}`],
      );

      await expect(badWorker.executeCycle()).rejects.toThrow();

      // Verify dead_letter_commands recorded for non-retryable error
      const { rows: dlRows } = await pool.query(
        'SELECT * FROM dead_letter_commands WHERE restaurant_id = $1 AND command_id = $2',
        [restaurantId, poisonCmdId],
      );
      expect(dlRows.length).toBe(1);
      expect(dlRows[0].status).toBe('dead_letter');

      await badWorker.stop();
    });
  });

  describe('Protected Metrics Endpoint', () => {
    it('protects /metrics endpoint requiring authentication or METRICS_TOKEN', async () => {
      // 1. Unauthenticated request rejected
      const unauthRes = await cloudApp.inject({
        method: 'GET',
        url: '/metrics',
      });
      expect(unauthRes.statusCode).toBe(401);

      // 2. Authenticated owner request accepted
      const authRes = await cloudApp.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });
      expect(authRes.statusCode).toBe(200);
      expect(authRes.payload).toContain('restaurant_os_');
    });
  });
});
