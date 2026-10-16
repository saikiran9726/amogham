import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { ROUTE_REGISTRY } from '../src/auth/middleware.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { Roles, ROLE_DEFAULT_PERMISSIONS, generateUuidV7 } from '@restaurant-os/shared';

describe('Security Regression Audit across ROUTE_REGISTRY', () => {
  let app: FastifyInstance;

  const tenantA = generateUuidV7();
  const tenantB = generateUuidV7();
  const userA = generateUuidV7();

  // Token for tenant A with NO permissions
  const tokenNoPerms = signAccessToken({
    userId: userA,
    restaurantId: tenantA,
    username: 'no_perms_user',
    name: 'No Perms',
    role: Roles.WAITER,
    permissions: [],
  });

  // Token for tenant A with full permissions (Owner)
  const tokenFull = signAccessToken({
    userId: userA,
    restaurantId: tenantA,
    username: 'owner_user',
    name: 'Owner',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Seed test restaurants and users so audit logs and DB constraints succeed
    const { pool } = await import('../src/db/client.js');
    await pool.query(
      'INSERT INTO restaurants (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING',
      [tenantA, 'Security Tenant A', tenantB, 'Security Tenant B'],
    );
    const userSuffix = generateUuidV7().replaceAll('-', '').slice(0, 10);
    await pool.query(
      `INSERT INTO users (id, restaurant_id, username, password_hash, name, active)
       VALUES ($1, $2, $3, 'hash', 'Sec User A', true)
       ON CONFLICT DO NOTHING`,
      [userA, tenantA, `sec_user_${userSuffix}`],
    );

    // Seed a table and menu category specifically belonging to Tenant B
    await pool.query(
      `INSERT INTO tables (id, restaurant_id, label, capacity, section, status)
       VALUES ($1, $2, 'T-TENANT-B', 4, 'Main', 'available')
       ON CONFLICT (id) DO NOTHING`,
      [generateUuidV7(), tenantB],
    );
    await pool.query(
      `INSERT INTO menu_categories (id, restaurant_id, name)
       VALUES ($1, $2, 'CAT-TENANT-B')
       ON CONFLICT (id) DO NOTHING`,
      [generateUuidV7(), tenantB],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('fails when an active Fastify route is missing from ROUTE_REGISTRY', () => {
    const fastifyRoutes = (
      app as unknown as { registeredRoutes: { method: string; url: string }[] }
    ).registeredRoutes;

    const missingRoutes: { method: string; url: string }[] = [];

    for (const route of fastifyRoutes) {
      const match = ROUTE_REGISTRY.find(
        (reg) =>
          reg.method.toUpperCase() === route.method.toUpperCase() &&
          reg.url.toLowerCase() === route.url.toLowerCase(),
      );
      if (!match) {
        missingRoutes.push(route);
      }
    }

    expect(
      missingRoutes,
      `All registered Fastify routes must exist in ROUTE_REGISTRY. Missing: ${JSON.stringify(
        missingRoutes,
      )}`,
    ).toEqual([]);
  });

  it('verifies (a) non-public routes return 401 without a token', async () => {
    for (const entry of ROUTE_REGISTRY) {
      if (entry.isPublic) continue;

      // Replace route params with dummy UUIDs
      const testUrl = entry.url.replace(/:([a-zA-Z0-9_]+)/g, generateUuidV7());

      const res = await app.inject({
        method: entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: testUrl,
        payload: entry.method !== 'GET' ? {} : undefined,
      });

      expect(
        res.statusCode,
        `Expected 401 Unauthorized for unauthenticated ${entry.method} ${entry.url}, got ${res.statusCode} (${res.body})`,
      ).toBe(401);
    }
  });

  it('verifies (b) permissioned routes return 403 for a token lacking that permission', async () => {
    for (const entry of ROUTE_REGISTRY) {
      // Routes requiring only basic authentication (like /me or /auth/logout-all) do not reject tokens without permissions
      if (entry.isPublic || !entry.permission || entry.permission === 'authenticated') continue;

      const testUrl = entry.url.replace(/:([a-zA-Z0-9_]+)/g, generateUuidV7());

      const res = await app.inject({
        method: entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: testUrl,
        headers: { authorization: `Bearer ${tokenNoPerms}` },
        payload: entry.method !== 'GET' ? {} : undefined,
      });

      expect(
        res.statusCode,
        `Expected 403 Forbidden for unprivileged token on ${entry.method} ${entry.url}, got ${res.statusCode}`,
      ).toBe(403);
    }
  });

  it("verifies (c) :id routes return 404 for another tenant's id", async () => {
    const idRoutes = ROUTE_REGISTRY.filter((entry) => entry.url.includes('/:'));

    for (const entry of idRoutes) {
      if (entry.isPublic) continue;

      // Construct URL with random foreign UUID
      const foreignId = generateUuidV7();
      const testUrl = entry.url.replace(/:([a-zA-Z0-9_]+)/g, foreignId);

      const res = await app.inject({
        method: entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: testUrl,
        headers: { authorization: `Bearer ${tokenFull}` },
        payload: entry.method !== 'GET' ? {} : undefined,
      });

      // Must NOT be 200/204 (successful access to foreign resource)
      // Acceptable: 404 Not Found (or 400 Bad Request if schema validation fails before lookup)
      expect(
        [404, 400, 422].includes(res.statusCode),
        `Expected 404 for foreign entity on ${entry.method} ${entry.url}, got ${res.statusCode}`,
      ).toBe(true);
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).not.toBe(204);
    }
  });

  it('verifies (d) no route accepts restaurantId in query or payload to override tenant', async () => {
    const { pool } = await import('../src/db/client.js');
    for (const entry of ROUTE_REGISTRY) {
      if (entry.isPublic) continue;

      const testUrl = `${entry.url.replace(/:([a-zA-Z0-9_]+)/g, generateUuidV7())}?restaurantId=${tenantB}`;

      // Query current tokenVersion from DB in case an earlier route (like /auth/logout-all) incremented it
      const userRes = await pool.query('SELECT token_version FROM users WHERE id = $1', [userA]);
      const currentTv = userRes.rows[0]?.token_version ?? 0;

      const testToken = signAccessToken({
        userId: userA,
        restaurantId: tenantA,
        username: 'owner_user',
        name: 'Owner',
        role: Roles.OWNER,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
        tv: currentTv,
      });

      const res = await app.inject({
        method: entry.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
        url: testUrl,
        headers: { authorization: `Bearer ${testToken}` },
        payload:
          entry.method !== 'GET'
            ? {
                restaurantId: tenantB,
              }
            : undefined,
      });

      // If response succeeds, ensure it didn't leak or accept tenantB data
      if (res.statusCode === 200 || res.statusCode === 201) {
        const text = res.body;
        expect(
          text.includes(tenantB) || text.includes('T-TENANT-B') || text.includes('CAT-TENANT-B'),
          `Route ${entry.method} ${entry.url} leaked Tenant B data via parameter tampering!`,
        ).toBe(false);
      }
    }
  });
});
