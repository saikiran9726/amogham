import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { io as ClientIO, Socket as ClientSocket } from 'socket.io-client';
import { Roles, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { env } from '../src/config/env.js';
import { emitRealtimeEvent, getRealtimeBus } from '../src/realtime/socket.js';
import { InMemoryRealtimeBus } from '../src/realtime/bus.js';

describe('Realtime Socket.IO Security & Cross-Tenant Hardening', () => {
  let app: FastifyInstance;
  let serverAddress: string;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userAWaiter = randomUUID();
  const userAOwner = randomUUID();
  const userBWaiter = randomUUID();

  const tokenAWaiter = signAccessToken({
    userId: userAWaiter,
    restaurantId: tenantA,
    username: 'waiter_a',
    name: 'Waiter A',
    role: Roles.WAITER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
  });

  const tokenAOwner = signAccessToken({
    userId: userAOwner,
    restaurantId: tenantA,
    username: 'owner_a',
    name: 'Owner A',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  const tokenBWaiter = signAccessToken({
    userId: userBWaiter,
    restaurantId: tenantB,
    username: 'waiter_b',
    name: 'Waiter B',
    role: Roles.WAITER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
  });

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    serverAddress = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GATE: no join_room listener exists on the server', async () => {
    const socket = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    // Emitting join_room produces no acknowledgment or room join because the handler was removed
    let ackReceived = false;
    socket.emit('join_room', `restaurant:${tenantB}`, () => {
      ackReceived = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ackReceived).toBe(false);

    socket.disconnect();
  });

  it('cross-tenant isolation: Tenant A client emitting join_room for Tenant B receives nothing from Tenant B', async () => {
    const socketA = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socketA.on('connect', () => resolve());
      socketA.on('connect_error', reject);
    });

    // Attacker on tenant A attempts to join tenant B rooms
    socketA.emit('join_room', `restaurant:${tenantB}`);
    socketA.emit('join_room', `restaurant:${tenantB}:kitchen`);
    socketA.emit('join_room', `restaurant:${tenantB}:floor`);

    const receivedEventsA: string[] = [];
    socketA.on('kot.created', (payload: { data: { tag?: string } }) => {
      receivedEventsA.push(payload.data?.tag || 'kot.created');
    });
    socketA.on('kot.statusChanged', (payload: { data: { tag?: string } }) => {
      receivedEventsA.push(payload.data?.tag || 'kot.statusChanged');
    });

    // Emit events for Tenant B
    emitRealtimeEvent(tenantB, 'kot.created', { tag: 'from_tenant_b_kitchen' }, 'kitchen');
    emitRealtimeEvent(tenantB, 'kot.statusChanged', { tag: 'from_tenant_b_all' }, 'all');

    // Emit event for Tenant A
    emitRealtimeEvent(tenantA, 'kot.statusChanged', { tag: 'from_tenant_a' }, 'floor');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(receivedEventsA).toEqual(['from_tenant_a']);

    socketA.disconnect();
  });

  it('role isolation: waiter receives floor broadcasts but is excluded from owner-only and kitchen-only events', async () => {
    const waiterSocket = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
    });

    const ownerSocket = ClientIO(serverAddress, {
      auth: { token: tokenAOwner },
      transports: ['websocket'],
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        waiterSocket.on('connect', () => resolve());
        waiterSocket.on('connect_error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        ownerSocket.on('connect', () => resolve());
        ownerSocket.on('connect_error', reject);
      }),
    ]);

    const waiterReceived: string[] = [];
    const ownerReceived: string[] = [];

    waiterSocket.on('test.event', (payload: { data: { name: string } }) => {
      waiterReceived.push(payload.data.name);
    });
    ownerSocket.on('test.event', (payload: { data: { name: string } }) => {
      ownerReceived.push(payload.data.name);
    });

    // 1. Owner-only broadcast
    emitRealtimeEvent(tenantA, 'test.event', { name: 'owner-secret' }, 'owner');
    // 2. Kitchen-only broadcast
    emitRealtimeEvent(tenantA, 'test.event', { name: 'kitchen-ticket' }, 'kitchen');
    // 3. Floor broadcast
    emitRealtimeEvent(tenantA, 'test.event', { name: 'floor-alert' }, 'floor');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(waiterReceived).toEqual(['floor-alert']);
    expect(ownerReceived).toEqual(['owner-secret', 'kitchen-ticket', 'floor-alert']);

    waiterSocket.disconnect();
    ownerSocket.disconnect();
  });

  it('CORS enforcement: disallowed Origin header is refused during handshake', async () => {
    const maliciousSocket = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
      extraHeaders: {
        origin: 'http://malicious.attacker.com',
      },
    });

    const err = await new Promise<Error>((resolve) => {
      maliciousSocket.on('connect_error', (error) => resolve(error));
    });

    expect(err.message).toMatch(/websocket error|CORS|origin/i);
    maliciousSocket.disconnect();
  });

  it('session expiry: socket is automatically disconnected at token exp', async () => {
    // Generate a token that expires in 1 second
    const shortLivedToken = jwt.sign(
      {
        userId: userAWaiter,
        restaurantId: tenantA,
        username: 'expiring_user',
        name: 'Expiring User',
        role: Roles.WAITER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      },
      env.JWT_SECRET,
      { expiresIn: '2s', algorithm: 'HS256' },
    );

    const socket = ClientIO(serverAddress, {
      auth: { token: shortLivedToken },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    let receivedAuthExpired = false;
    socket.on('auth:expired', (payload: { reason?: string }) => {
      if (payload.reason === 'Token expired') {
        receivedAuthExpired = true;
      }
    });

    const disconnectedPromise = new Promise<string>((resolve) => {
      socket.on('disconnect', (reason) => resolve(reason));
    });

    // Wait for the token to expire and trigger server disconnect
    const disconnectReason = await disconnectedPromise;

    expect(receivedAuthExpired).toBe(true);
    expect(disconnectReason).toBeTruthy();
    expect(socket.connected).toBe(false);

    socket.disconnect();
  });

  it('auth:refresh handshake: extends connection with fresh token and rejects tenant mismatch', async () => {
    const socket = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    // 1. Attempt refresh with Token from another tenant -> rejected
    const mismatchRes = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket.emit('auth:refresh', { token: tokenBWaiter }, resolve);
    });
    expect(mismatchRes.ok).toBe(false);
    expect(mismatchRes.error).toBe('Identity mismatch');

    // 2. Refresh with valid fresh token for same tenant and user -> accepted
    const freshTokenA = signAccessToken({
      userId: userAWaiter,
      restaurantId: tenantA,
      username: 'waiter_a',
      name: 'Waiter A',
      role: Roles.WAITER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
    });

    const validRes = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket.emit('auth:refresh', { token: freshTokenA }, resolve);
    });
    expect(validRes.ok).toBe(true);

    socket.disconnect();
  });

  it('catch_up returns only the authenticated caller tenant events', async () => {
    const socketA = ClientIO(serverAddress, {
      auth: { token: tokenAWaiter },
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socketA.on('connect', () => resolve());
      socketA.on('connect_error', reject);
    });

    // Emit events for tenant A and tenant B
    const evtA1 = emitRealtimeEvent(tenantA, 'test.catchup', { note: 'A1' });
    const evtB1 = emitRealtimeEvent(tenantB, 'test.catchup', { note: 'B1' });
    const evtA2 = emitRealtimeEvent(tenantA, 'test.catchup', { note: 'A2' });

    expect(evtA1?.id).toBeTruthy();
    expect(evtB1?.id).toBeTruthy();
    expect(evtA2?.id).toBeTruthy();

    const missedEvents = await new Promise<Array<{ data: { note: string } }>>((resolve) => {
      socketA.emit('catch_up', { since: 0 }, resolve);
    });

    const notes = missedEvents.map((e) => e.data.note);
    expect(notes).toContain('A1');
    expect(notes).toContain('A2');
    expect(notes).not.toContain('B1');

    socketA.disconnect();
  });

  it('RealtimeBus bounds per-tenant log to 500 events and prunes events older than 10 minutes', () => {
    const bus = new InMemoryRealtimeBus();
    const testTenant = randomUUID();

    // 1. Publish 505 events
    for (let i = 0; i < 505; i++) {
      const ev = bus.publish({
        restaurantId: testTenant,
        event: 'test.cap',
        data: { seq: i },
      });
      // Event id must be valid UUID
      expect(ev.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }

    const history = bus.getHistory(testTenant, 0);
    // Bounded to 500
    expect(history.length).toBe(500);
    // Oldest 5 (0..4) evicted, starts at seq 5
    expect((history[0]?.data as { seq: number }).seq).toBe(5);

    // 2. Sweep prunes events older than 10 minutes
    const oldTimestamp = Date.now() - 11 * 60 * 1000;
    history[0]!.timestamp = oldTimestamp;
    history[1]!.timestamp = oldTimestamp;

    bus.sweep();

    const sweptHistory = bus.getHistory(testTenant, 0);
    expect(sweptHistory.length).toBe(498);

    bus.destroy();
  });
});
