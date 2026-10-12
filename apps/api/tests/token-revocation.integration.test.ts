import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { io as ioClient, type Socket } from 'socket.io-client';
import { Roles, generateUuidV7, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { roles } from '../src/db/schema/roles.js';
import { refreshTokens } from '../src/db/schema/refresh-tokens.js';
import { auditLogs } from '../src/db/schema/audit-logs.js';
import { hashPassword, hashToken, hashPin } from '../src/auth/crypto.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { clearUserSessionCache } from '../src/auth/token-cache.js';
import { parseEnvConfig, strictBoolean } from '../src/config/env.js';
import { IdempotencyCleanupService } from '../src/jobs/cleanup.js';

describe('Auth Hardening: Token Version Revocation, Refresh Rotation & Environment Gates', () => {
  let app: FastifyInstance;
  let serverAddress: string;
  const restaurantId = generateUuidV7();

  let roleOwnerId: string;
  let roleManagerId: string;
  let roleWaiterId: string;
  const ownerUserId = generateUuidV7();
  const ownerUsername = `boss_owner_${Date.now()}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    serverAddress = typeof address === 'string' ? address : `http://127.0.0.1:${address?.port}`;

    // 1. Create test restaurant
    await db.insert(restaurants).values({
      id: restaurantId,
      name: 'Revocation Hardening Bistro',
      address: '200 Auth Security St',
      phone: '+91 9999988888',
    });

    // 2. Ensure standard roles
    const standardRoles = [
      { name: Roles.OWNER, description: 'Owner' },
      { name: Roles.MANAGER, description: 'Manager' },
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
    roleManagerId = roleRows.find((r) => r.name === Roles.MANAGER)!.id;
    roleWaiterId = roleRows.find((r) => r.name === Roles.WAITER)!.id;

    // 3. Create test owner user
    await db.insert(users).values({
      id: ownerUserId,
      restaurantId,
      roleId: roleOwnerId,
      name: 'Boss Owner',
      username: ownerUsername,
      active: true,
      tokenVersion: 0,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GATE 1: Environment Security & Production Boot Requirements', () => {
    it('GATE 1: App refuses to boot in production without secrets', () => {
      // 1. Missing all secrets in production
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
        }),
      ).toThrow(/Invalid environment configuration/);

      // 2. Missing JWT_SECRET
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/test',
          COOKIE_SECRET: 'a'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).toThrow(/JWT_SECRET/);

      // 3. Short secrets (< 32 chars)
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/test',
          JWT_SECRET: 'short-secret',
          COOKIE_SECRET: 'a'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).toThrow(/JWT_SECRET must be at least 32 characters/);

      // 4. Missing COOKIE_SECURE in production
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/test',
          JWT_SECRET: 'a'.repeat(32),
          COOKIE_SECRET: 'b'.repeat(32),
          COOKIE_SECURE: 'false',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).toThrow(/Secure cookies are required in production/);

      // 5. Wildcard or localhost CORS origin in production
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/test',
          JWT_SECRET: 'a'.repeat(32),
          COOKIE_SECRET: 'b'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: '*',
        }),
      ).toThrow(/Configure explicit production web origins/);
    });

    it('strictBoolean correctly evaluates boolean string values without coerce truthiness trap', () => {
      const schema = strictBoolean(false);
      expect(schema.parse('false')).toBe(false);
      expect(schema.parse('0')).toBe(false);
      expect(schema.parse(false)).toBe(false);
      expect(schema.parse('true')).toBe(true);
      expect(schema.parse('1')).toBe(true);
      expect(schema.parse(true)).toBe(true);
      expect(() => schema.parse('random_string')).toThrow();
    });

    it('validates COOKIE_SAMESITE none requires COOKIE_SECURE true', () => {
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'development',
          COOKIE_SAMESITE: 'none',
          COOKIE_SECURE: 'false',
        }),
      ).toThrow(/COOKIE_SAMESITE=none requires COOKIE_SECURE to be true/);
    });
  });

  describe('GATE 2: Refresh Token Rotation, Grace Period & Family Reuse Detection', () => {
    it('GATE 2: Immediate grace succeeds, replay outside grace revokes family', async () => {
      const userId = generateUuidV7();
      const username = `refresh_user_${Date.now()}`;
      const password = 'StrongPassword123!';
      const passwordHash = await hashPassword(password);

      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Refresh Tester',
        username,
        passwordHash,
        active: true,
        tokenVersion: 0,
      });

      // 1. Initial login -> issues Token A
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username,
          credentialType: 'password',
          password,
        },
      });
      expect(loginRes.statusCode).toBe(200);
      const cookieHeaderA = loginRes.cookies.find((c) => c.name === 'restaurant_os_refresh_token');
      expect(cookieHeaderA).toBeDefined();
      const rawTokenA = cookieHeaderA!.value;

      // 2. Normal refresh: Token A -> Token B
      const refreshRes1 = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {
          restaurant_os_refresh_token: rawTokenA,
        },
      });
      expect(refreshRes1.statusCode).toBe(200);
      const refreshData1 = refreshRes1.json();
      expect(refreshData1.accessToken).toBeDefined();

      const cookieHeaderB = refreshRes1.cookies.find(
        (c) => c.name === 'restaurant_os_refresh_token',
      );
      expect(cookieHeaderB).toBeDefined();
      const rawTokenB = cookieHeaderB!.value;
      expect(rawTokenB).not.toBe(rawTokenA);

      // Verify DB links: Token A is marked revoked, with replaced_by pointing to Token B
      const [rowA] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(rawTokenA)))
        .limit(1);
      const [rowB] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(rawTokenB)))
        .limit(1);

      expect(rowA.revokedAt).not.toBeNull();
      expect(rowA.replacedBy).toBe(rowB.id);
      expect(rowA.familyId).toBe(rowB.familyId);

      // 3. Immediate predecessor grace period:
      // Client replays Token A within 10 seconds (e.g. concurrent tab / network glitch)
      const graceRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {
          restaurant_os_refresh_token: rawTokenA,
        },
      });
      expect(graceRes.statusCode).toBe(200);
      const graceData = graceRes.json();
      expect(graceData.accessToken).toBeDefined();

      // Ensure family is NOT revoked after grace usage
      const [stillValidB] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, rowB.id))
        .limit(1);
      expect(stillValidB.revokedAt).toBeNull();

      // 4. Simulate passage of time (> 10s grace window expires)
      await db
        .update(refreshTokens)
        .set({
          revokedAt: new Date(Date.now() - 15_000), // 15 seconds ago
        })
        .where(eq(refreshTokens.id, rowA.id));

      // 5. Replay Token A OUTSIDE grace window -> Reuse attack detected!
      const reuseRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {
          restaurant_os_refresh_token: rawTokenA,
        },
      });
      expect(reuseRes.statusCode).toBe(401);
      expect(reuseRes.json().error.message).toMatch(/Refresh token reuse detected/);

      // Verify the ENTIRE family was revoked!
      const [revokedB] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, rowB.id))
        .limit(1);
      expect(revokedB.revokedAt).not.toBeNull();

      // Verify audit log recorded for reuse detection
      const [reuseAudit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.userId, userId), eq(auditLogs.action, 'auth.refresh_reuse_detected')),
        )
        .limit(1);
      expect(reuseAudit).toBeDefined();

      // 6. Any subsequent attempt to use Token B from that family fails with 401
      const blockedBRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: {
          restaurant_os_refresh_token: rawTokenB,
        },
      });
      expect(blockedBRes.statusCode).toBe(401);
    });

    it('blocks refresh and logout requests with unallowed CORS origins', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: {
          origin: 'https://malicious-site.com',
        },
        cookies: {
          restaurant_os_refresh_token: 'dummy',
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Token Version Revocation across Staff Actions & Logout-All', () => {
    it('revokes access immediately when role is changed (tokenVersion bumped)', async () => {
      clearUserSessionCache();
      const userId = generateUuidV7();
      const username = `tv_role_${Date.now()}`;

      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Waiter Promoted',
        username,
        active: true,
        tokenVersion: 0,
      });

      // Issue token with current tokenVersion (0)
      const initialToken = signAccessToken({
        userId,
        restaurantId,
        username,
        name: 'Waiter Promoted',
        role: Roles.WAITER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
        tv: 0,
      });

      // Access before role change works
      const resBefore = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${initialToken}` },
      });
      expect(resBefore.statusCode).toBe(200);

      // Create owner token to perform staff PATCH
      const ownerToken = signAccessToken({
        userId: ownerUserId,
        restaurantId,
        username: ownerUsername,
        name: 'Boss Owner',
        role: Roles.OWNER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
        tv: 0,
      });

      // Promote to MANAGER -> bumps tokenVersion
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/staff/${userId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          role: Roles.MANAGER,
        },
      });
      expect(patchRes.statusCode).toBe(200);

      // Verify DB token_version is incremented
      const [updatedUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      expect(updatedUser.tokenVersion).toBe(1);

      // Old token with tv=0 is now REJECTED (401)
      const resAfter = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${initialToken}` },
      });
      expect(resAfter.statusCode).toBe(401);
      expect(resAfter.json().error.message).toMatch(/Token version mismatch|revoked/);

      // Fresh token with tv=1 succeeds
      const freshToken = signAccessToken({
        userId,
        restaurantId,
        username,
        name: 'Waiter Promoted',
        role: Roles.MANAGER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.MANAGER],
        tv: 1,
      });
      const resFresh = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(resFresh.statusCode).toBe(200);
    });

    it('revokes access immediately on deactivation and password/PIN reset', async () => {
      clearUserSessionCache();
      const userId = generateUuidV7();
      const username = `tv_deact_${Date.now()}`;

      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Temp Waiter',
        username,
        active: true,
        tokenVersion: 0,
      });

      const userToken = signAccessToken({
        userId,
        restaurantId,
        username,
        name: 'Temp Waiter',
        role: Roles.WAITER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
        tv: 0,
      });

      const ownerToken = signAccessToken({
        userId: ownerUserId,
        restaurantId,
        username: ownerUsername,
        name: 'Boss Owner',
        role: Roles.OWNER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
        tv: 0,
      });

      // Reset PIN -> bumps tokenVersion
      const resetRes = await app.inject({
        method: 'POST',
        url: `/staff/${userId}/reset-credential`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          credentialType: 'pin',
          pin: '8888',
        },
      });
      expect(resetRes.statusCode).toBe(200);

      // Old token rejected
      const resOld = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(resOld.statusCode).toBe(401);
    });

    it('POST /auth/logout-all increments tokenVersion, revokes all refresh tokens and logs out user', async () => {
      clearUserSessionCache();
      const userId = generateUuidV7();
      const username = `logout_all_user_${Date.now()}`;

      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Multi Session Waiter',
        username,
        active: true,
        tokenVersion: 0,
      });

      const userToken = signAccessToken({
        userId,
        restaurantId,
        username,
        name: 'Multi Session Waiter',
        role: Roles.WAITER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
        tv: 0,
      });

      // Insert active refresh tokens for user
      await db.insert(refreshTokens).values([
        {
          userId,
          tokenHash: hashToken('token_1'),
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          userId,
          tokenHash: hashToken('token_2'),
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      const logoutAllRes = await app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(logoutAllRes.statusCode).toBe(200);

      // Verify token_version bumped
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      expect(u.tokenVersion).toBe(1);

      // Verify all refresh tokens revoked
      const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

      // Old access token now fails
      const checkRes = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(checkRes.statusCode).toBe(401);
    });

    it('rejects Socket.IO connection when tokenVersion does not match', async () => {
      clearUserSessionCache();
      const userId = generateUuidV7();
      const username = `socket_revoked_${Date.now()}`;

      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Socket User',
        username,
        active: true,
        tokenVersion: 5, // DB token version is 5
      });

      // Token with outdated tv=4
      const outdatedToken = signAccessToken({
        userId,
        restaurantId,
        username,
        name: 'Socket User',
        role: Roles.WAITER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
        tv: 4,
      });

      const socket: Socket = ioClient(serverAddress, {
        auth: { token: outdatedToken },
        transports: ['websocket'],
        reconnection: false,
      });

      const connectError = await new Promise<string>((resolve) => {
        socket.on('connect_error', (err) => {
          resolve(err.message);
        });
        socket.on('connect', () => {
          resolve('connected_unexpectedly');
        });
      });

      socket.disconnect();
      expect(connectError).toBe('Invalid authentication token');
    });
  });

  describe('Cleanup Service: Refresh Token Purging', () => {
    it('purges expired and revoked refresh tokens older than 30 days', async () => {
      const oldCutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

      const userId = generateUuidV7();
      await db.insert(users).values({
        id: userId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Purge User',
        username: `purge_user_${Date.now()}`,
        active: true,
      });

      // Insert:
      // 1. Old revoked token (> 30 days old) -> should be purged
      // 2. Old expired token (> 30 days old) -> should be purged
      // 3. Recent revoked token (5 days old) -> should be kept
      // 4. Active valid token -> should be kept
      await db.insert(refreshTokens).values([
        {
          id: generateUuidV7(),
          userId,
          tokenHash: hashToken('old_revoked'),
          expiresAt: recentDate,
          revokedAt: oldCutoff,
        },
        {
          id: generateUuidV7(),
          userId,
          tokenHash: hashToken('old_expired'),
          expiresAt: oldCutoff,
        },
        {
          id: generateUuidV7(),
          userId,
          tokenHash: hashToken('recent_revoked'),
          expiresAt: new Date(Date.now() + 86400000),
          revokedAt: recentDate,
        },
        {
          id: generateUuidV7(),
          userId,
          tokenHash: hashToken('active_token'),
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      const cleanupService = new IdempotencyCleanupService(db, 30);
      const purged = await cleanupService.purgeRefreshTokensOnce();
      expect(purged).toBeGreaterThanOrEqual(2);

      // Verify recent and active tokens still exist
      const remaining = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
      expect(remaining.length).toBe(2);
      expect(remaining.some((t) => t.tokenHash === hashToken('recent_revoked'))).toBe(true);
      expect(remaining.some((t) => t.tokenHash === hashToken('active_token'))).toBe(true);
    });
  });
});
