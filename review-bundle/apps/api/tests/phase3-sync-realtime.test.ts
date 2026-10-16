import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  Roles,
  ROLE_DEFAULT_PERMISSIONS,
  Permissions,
  generateUuidV7,
} from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { pool } from '../src/db/client.js';
import { InMemoryRealtimeBus } from '../src/realtime/bus.js';
import {
  emitRealtimeEvent,
  getRealtimeBus,
  setRealtimeBus,
  disconnectUserSockets,
  SocketTokenBucket,
} from '../src/realtime/socket.js';
import { SyncEngineService } from '../src/services/sync-engine.js';
import { setUserSessionCache } from '../src/auth/token-cache.js';

describe('Phase 3 Hardening: Sync Route Security, Hub Machine Isolation, Realtime Filtering & Sockets', () => {
  let app: FastifyInstance;
  let serverAddress: string;

  const restaurantId = generateUuidV7();
  const ownerUserId = generateUuidV7();
  const waiterUserId = generateUuidV7();
  const kitchenUserId = generateUuidV7();

  let ownerToken: string;
  let waiterToken: string;
  let kitchenToken: string;

  const hubDeviceId = 'hub-device-phase3-001';
  let registeredHubApiKey: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    serverAddress = typeof address === 'string' ? address : `http://127.0.0.1:${address?.port}`;

    // 1. Seed tenant and users
    await pool.query(
      `INSERT INTO restaurants (id, name) VALUES ($1, 'Phase 3 Test Restaurant') ON CONFLICT (id) DO NOTHING`,
      [restaurantId],
    );

    await pool.query(
      `INSERT INTO users (id, restaurant_id, name, username, active, token_version)
       VALUES
         ($1, $2, 'P3 Owner', 'p3_owner', true, 0),
         ($3, $2, 'P3 Waiter', 'p3_waiter', true, 0),
         ($4, $2, 'P3 Kitchen', 'p3_kitchen', true, 0)
       ON CONFLICT (id) DO UPDATE SET active = true, token_version = 0`,
      [ownerUserId, restaurantId, waiterUserId, kitchenUserId],
    );

    setUserSessionCache(restaurantId, ownerUserId, { tokenVersion: 0, active: true });
    setUserSessionCache(restaurantId, waiterUserId, { tokenVersion: 0, active: true });
    setUserSessionCache(restaurantId, kitchenUserId, { tokenVersion: 0, active: true });

    ownerToken = signAccessToken({
      userId: ownerUserId,
      restaurantId,
      username: 'p3_owner',
      name: 'P3 Owner',
      role: Roles.OWNER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
    });

    waiterToken = signAccessToken({
      userId: waiterUserId,
      restaurantId,
      username: 'p3_waiter',
      name: 'P3 Waiter',
      role: Roles.WAITER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
    });

    kitchenToken = signAccessToken({
      userId: kitchenUserId,
      restaurantId,
      username: 'p3_kitchen',
      name: 'P3 Kitchen',
      role: Roles.KITCHEN,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.KITCHEN],
    });

    // 2. Register a Local Hub with high-entropy server key generation
    const hub = await SyncEngineService.registerHub(restaurantId, {
      deviceId: hubDeviceId,
      name: 'Phase 3 Local Hub',
      hostAddress: '192.168.1.50:3000',
    });
    registeredHubApiKey = hub.apiKey!;
    expect(registeredHubApiKey).toBeTruthy();
    expect(registeredHubApiKey.startsWith('hub_')).toBe(true);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM hub_registry WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM sync_events WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM users WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
    } catch {
      // Ignore cleanup error
    }
    await app.close();
  });

  describe('1. Sync Route Security & Permission Enforcement (sync.use)', () => {
    it('blocks kitchen role without sync.use permission from POST /sync/push with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${kitchenToken}` },
        payload: {
          deviceId: 'kitchen-dev',
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `p3-push-${Date.now()}`,
              deviceId: 'kitchen-dev',
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('blocks kitchen role without sync.use permission from GET /sync/pull with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0&limit=10',
        headers: { authorization: `Bearer ${kitchenToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('allows waiter role (granted sync.use) to access GET /sync/pull', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0&limit=10',
        headers: { authorization: `Bearer ${waiterToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(Array.isArray(res.json().events)).toBe(true);
    });

    it('allows owner role (granted sync.use) to access POST /sync/push', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: 'owner-dev',
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `owner-push-${Date.now()}`,
              deviceId: 'owner-dev',
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });

  describe('2. Hub Machine Endpoint Isolation & Header Enforcement', () => {
    it('rejects hub-machine requests missing X-Restaurant-Id header with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': registeredHubApiKey,
          'x-hub-device-id': hubDeviceId,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/Missing required X-Restaurant-Id/i);
    });

    it('rejects hub-machine requests missing X-Hub-Device-Id header with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': registeredHubApiKey,
          'x-restaurant-id': restaurantId,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/Missing required X-Hub-Device-Id/i);
    });

    it('rejects hub-machine requests when device or restaurant ID does not match active registered hub', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': registeredHubApiKey,
          'x-restaurant-id': restaurantId,
          'x-hub-device-id': 'unregistered-rogue-device',
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toMatch(/Invalid or unauthorized X-Hub-Key/i);
    });

    it('processes hub push batch with valid machine headers and attributes machine actor', async () => {
      const cmdId = generateUuidV7();
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/push',
        headers: {
          'x-hub-key': registeredHubApiKey,
          'x-restaurant-id': restaurantId,
          'x-hub-device-id': hubDeviceId,
        },
        payload: {
          deviceId: hubDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: cmdId,
              idempotencyKey: `hub-mach-actor-${Date.now()}`,
              deviceId: hubDeviceId,
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().results[0].commandId).toBe(cmdId);
    });
  });

  describe('3. Schema Identifier Bounds (.max(128)) & Server-Side Entropy', () => {
    it('rejects sync push batch with deviceId exceeding 128 characters', async () => {
      const oversizedDeviceId = 'd'.repeat(129);
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: oversizedDeviceId,
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `oversized-${Date.now()}`,
              deviceId: 'valid-dev',
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects command with idempotencyKey exceeding 128 characters', async () => {
      const oversizedKey = 'k'.repeat(129);
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: 'valid-dev',
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: oversizedKey,
              deviceId: 'valid-dev',
              type: 'order.create',
              payload: { type: 'dine_in', items: [] },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('generates high entropy 32-byte hex API key when apiKey is omitted in registration', async () => {
      const customDeviceId = `hub-entropy-${Date.now()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/sync/hub/register',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: customDeviceId,
          name: 'Entropy Test Hub',
          hostAddress: '192.168.1.99:3000',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.apiKey).toBeTruthy();
      expect(data.apiKey.length).toBeGreaterThanOrEqual(64);
    });
  });

  describe('4. Realtime Bus Role Filtering & Room Authorization', () => {
    it('InMemoryRealtimeBus filters history strictly based on caller role', () => {
      const bus = new InMemoryRealtimeBus();
      const testTenant = generateUuidV7();

      // Publish events targeted to different roles
      bus.publish({
        restaurantId: testTenant,
        event: 'evt.all',
        data: { name: 'all' },
        target: 'all',
      });
      bus.publish({
        restaurantId: testTenant,
        event: 'evt.floor',
        data: { name: 'floor' },
        target: 'floor',
      });
      bus.publish({
        restaurantId: testTenant,
        event: 'evt.kitchen',
        data: { name: 'kitchen' },
        target: 'kitchen',
      });
      bus.publish({
        restaurantId: testTenant,
        event: 'evt.owner',
        data: { name: 'owner' },
        target: 'owner',
      });

      // 1. WAITER caller: sees only 'all' and 'floor'
      const waiterEvents = bus.getHistory(testTenant, 0, Roles.WAITER);
      const waiterNames = waiterEvents.map((e) => (e.data as { name: string }).name);
      expect(waiterNames).toEqual(['all', 'floor']);

      // 2. KITCHEN caller: sees only 'all' and 'kitchen'
      const kitchenEvents = bus.getHistory(testTenant, 0, Roles.KITCHEN);
      const kitchenNames = kitchenEvents.map((e) => (e.data as { name: string }).name);
      expect(kitchenNames).toEqual(['all', 'kitchen']);

      // 3. OWNER caller: sees all events
      const ownerEvents = bus.getHistory(testTenant, 0, Roles.OWNER);
      const ownerNames = ownerEvents.map((e) => (e.data as { name: string }).name);
      expect(ownerNames).toEqual(['all', 'floor', 'kitchen', 'owner']);

      bus.destroy();
    });

    it('recomputes socket rooms dynamically on auth:refresh', async () => {
      const socket: ClientSocket = ioClient(serverAddress, {
        auth: { token: waiterToken },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });

      const receivedOwnerEvents: string[] = [];
      socket.on('owner.secret.announcement', (payload: { data: { tag: string } }) => {
        receivedOwnerEvents.push(payload.data.tag);
      });

      // 1. While WAITER, emitting owner event is NOT received
      emitRealtimeEvent(restaurantId, 'owner.secret.announcement', { tag: 'msg1' }, 'owner');
      await new Promise((r) => setTimeout(r, 100));
      expect(receivedOwnerEvents).toEqual([]);

      // 2. User gets promoted to OWNER: refresh token on same socket connection
      const promotedToken = signAccessToken({
        userId: waiterUserId,
        restaurantId,
        username: 'p3_waiter',
        name: 'P3 Waiter Promoted',
        role: Roles.OWNER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
      });

      const refreshAck = await new Promise<{ ok: boolean }>((resolve) => {
        socket.emit('auth:refresh', { token: promotedToken }, resolve);
      });
      expect(refreshAck.ok).toBe(true);

      // 3. After refreshing into OWNER, socket dynamically joins owner room and receives event!
      emitRealtimeEvent(restaurantId, 'owner.secret.announcement', { tag: 'msg2' }, 'owner');
      await new Promise((r) => setTimeout(r, 150));
      expect(receivedOwnerEvents).toEqual(['msg2']);

      socket.disconnect();
    });

    it('maintains per-user room and instantly disconnects stale socket on disconnectUserSockets', async () => {
      const socket: ClientSocket = ioClient(serverAddress, {
        auth: { token: waiterToken },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });

      let revokedReason = '';
      socket.on('auth:revoked', (data: { reason: string }) => {
        revokedReason = data.reason;
      });

      const disconnectPromise = new Promise<string>((resolve) => {
        socket.on('disconnect', (reason) => resolve(reason));
      });

      // Trigger user deactivation/logout socket disconnect
      disconnectUserSockets(waiterUserId, 'User account deactivated');

      const reason = await disconnectPromise;
      expect(revokedReason).toBe('User account deactivated');
      expect(reason).toBeTruthy();
      expect(socket.connected).toBe(false);

      socket.disconnect();
    });

    it('enforces token-bucket rate limiter on rapid socket commands', async () => {
      // Test SocketTokenBucket unit behavior
      const bucket = new SocketTokenBucket(5, 1);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      // 6th token exceeds capacity of 5
      expect(bucket.tryConsume(1)).toBe(false);

      // Test rate limiter over active socket connection
      const socket: ClientSocket = ioClient(serverAddress, {
        auth: { token: ownerToken },
        transports: ['websocket'],
      });

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });

      let rateLimitExceeded = false;
      socket.on('rate_limit_exceeded', () => {
        rateLimitExceeded = true;
      });

      // Fire 30 rapid commands (exceeds default capacity of 20)
      for (let i = 0; i < 30; i++) {
        socket.emit('catch_up', { since: 0 });
      }

      await new Promise((r) => setTimeout(r, 150));
      expect(rateLimitExceeded).toBe(true);

      socket.disconnect();
    });
  });

  describe('5. Event Dispatch & Payload Minimization', () => {
    it('targets EOD day.closed and day.reopened strictly to owner room', async () => {
      const waiterSocket: ClientSocket = ioClient(serverAddress, {
        auth: { token: waiterToken },
        transports: ['websocket'],
      });

      const ownerSocket: ClientSocket = ioClient(serverAddress, {
        auth: { token: ownerToken },
        transports: ['websocket'],
      });

      try {
        await Promise.all([
          new Promise<void>((res) => waiterSocket.on('connect', () => res())),
          new Promise<void>((res) => ownerSocket.on('connect', () => res())),
        ]);

        const waiterReceivedEod: string[] = [];
        const ownerReceivedEod: string[] = [];

        waiterSocket.on('day.closed', () => waiterReceivedEod.push('closed'));
        waiterSocket.on('day.reopened', () => waiterReceivedEod.push('reopened'));
        ownerSocket.on('day.closed', () => ownerReceivedEod.push('closed'));
        ownerSocket.on('day.reopened', () => ownerReceivedEod.push('reopened'));

        // Close day event broadcast targeted to 'owner' room (as emitted by eod service)
        const today = new Date().toISOString().slice(0, 10);
        emitRealtimeEvent(
          restaurantId,
          'day.closed',
          { businessDate: today, summaryId: generateUuidV7() },
          'owner',
        );

        await new Promise((r) => setTimeout(r, 150));

        // Reopen day event broadcast targeted to 'owner' room (as emitted by eod service)
        emitRealtimeEvent(
          restaurantId,
          'day.reopened',
          { businessDate: today, summaryId: generateUuidV7() },
          'owner',
        );

        await new Promise((r) => setTimeout(r, 150));

        expect(ownerReceivedEod).toEqual(['closed', 'reopened']);
        expect(waiterReceivedEod).toEqual([]);
      } finally {
        waiterSocket.disconnect();
        ownerSocket.disconnect();
      }
    });

    it('slims down sync:event broadcast payload to metadata and IDs without raw financial payloads', async () => {
      const ownerSocket: ClientSocket = ioClient(serverAddress, {
        auth: { token: ownerToken },
        transports: ['websocket'],
      });

      await new Promise<void>((res) => ownerSocket.on('connect', () => res()));

      const broadcastEvents: Array<Record<string, unknown>> = [];
      ownerSocket.on('sync:event', (payload: { data: Record<string, unknown> }) => {
        broadcastEvents.push(payload.data);
      });

      const orderId = generateUuidV7();
      await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          deviceId: 'pos-dev-01',
          batchId: generateUuidV7(),
          commands: [
            {
              id: generateUuidV7(),
              idempotencyKey: `slim-test-${Date.now()}`,
              deviceId: 'pos-dev-01',
              type: 'order.create',
              payload: {
                id: orderId,
                type: 'dine_in',
                guests: 4,
                specialInstructions: 'CONFIDENTIAL_CUSTOMER_INFO',
                items: [],
                subtotalPaise: 500000,
                totalPaise: 500000,
              },
            },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(broadcastEvents.length).toBeGreaterThanOrEqual(1);
      const lastEvent = broadcastEvents[broadcastEvents.length - 1];

      // Verifies slimmed-down sequence metadata and entity ID
      expect(lastEvent.seq).toBeDefined();
      expect(lastEvent.type).toBe('order.create');
      expect(lastEvent.id).toBe(orderId);
      expect(lastEvent.deviceId).toBe('pos-dev-01');
      expect(lastEvent.serverTimestamp).toBeDefined();

      // Verifies sensitive raw financial/customer details are NOT leaked in broadcast
      expect(lastEvent.payload).toBeUndefined();
      expect((lastEvent as Record<string, unknown>).specialInstructions).toBeUndefined();
      expect((lastEvent as Record<string, unknown>).subtotalPaise).toBeUndefined();

      ownerSocket.disconnect();
    });
  });
});
