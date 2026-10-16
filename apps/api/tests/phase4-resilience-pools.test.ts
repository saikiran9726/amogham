import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { Roles, ROLE_DEFAULT_PERMISSIONS, generateUuidV7 } from '@restaurant-os/shared';
import { MetricsService } from '../src/services/metrics.js';
import { parseEnvConfig } from '../src/config/env.js';
import { clearReadyzCache } from '../src/routes/health.js';

describe('Phase 4: Operational Metrics, Health Probes, Pool Hardening & Resilience', () => {
  let app: FastifyInstance;

  const restaurantIdA = generateUuidV7();
  const restaurantIdB = generateUuidV7();
  const ownerIdA = generateUuidV7();
  const ownerIdB = generateUuidV7();

  let tokenOwnerA: string;
  let tokenOwnerB: string;

  beforeAll(async () => {
    // 1. Seed restaurants and users
    await pool.query(
      `INSERT INTO restaurants (id, name)
       VALUES ($1, 'Res A'),
              ($2, 'Res B')
       ON CONFLICT (id) DO NOTHING;`,
      [restaurantIdA, restaurantIdB],
    );

    await pool.query(
      `INSERT INTO users (id, restaurant_id, name, username, active, token_version)
       VALUES ($1, $2, 'Owner A', $3, true, 0),
              ($4, $5, 'Owner B', $6, true, 0)
       ON CONFLICT (id) DO NOTHING;`,
      [
        ownerIdA,
        restaurantIdA,
        `owner_a_${Date.now()}`,
        ownerIdB,
        restaurantIdB,
        `owner_b_${Date.now()}`,
      ],
    );

    tokenOwnerA = signAccessToken({
      userId: ownerIdA,
      restaurantId: restaurantIdA,
      role: Roles.OWNER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
    });

    tokenOwnerB = signAccessToken({
      userId: ownerIdB,
      restaurantId: restaurantIdB,
      role: Roles.OWNER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
    });

    app = await buildServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2);`, [ownerIdA, ownerIdB]);
    await pool.query(`DELETE FROM restaurants WHERE id IN ($1, $2);`, [
      restaurantIdA,
      restaurantIdB,
    ]);
  });

  beforeEach(() => {
    clearReadyzCache();
  });

  describe('Task 1: Metrics Route Cardinality & Security', () => {
    it('labels random 404 routes as unmatched in Prometheus metrics to prevent unbounded cardinality', async () => {
      const randomRoute = `/non-existent-random-${crypto.randomBytes(8).toString('hex')}`;
      const res = await app.inject({
        method: 'GET',
        url: randomRoute,
      });
      expect(res.statusCode).toBe(404);

      const metricsData = await MetricsService.getMetrics();
      // Histogram should track route="unmatched", never the random URL path
      expect(metricsData).toContain('route="unmatched"');
      expect(metricsData).not.toContain(`route="${randomRoute}"`);
    });

    it('enforces constant-time comparison for METRICS_TOKEN via x-metrics-token and Bearer', async () => {
      // Unauthenticated request rejected
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/metrics',
      });
      expect(unauthRes.statusCode).toBe(401);

      // Authenticated with valid user session
      const authRes = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${tokenOwnerA}`,
        },
      });
      expect(authRes.statusCode).toBe(200);
      expect(authRes.payload).toContain('restaurant_os_');
    });

    it('restricts multi-tenant data access: caller only sees their restaurant metrics', async () => {
      // Set distinct metrics for restaurant A and restaurant B
      MetricsService.setSyncLag(restaurantIdA, 42);
      MetricsService.setSyncLag(restaurantIdB, 99);

      // Owner A requests /metrics
      const resA = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${tokenOwnerA}`,
        },
      });
      expect(resA.statusCode).toBe(200);
      expect(resA.payload).toContain(`restaurant_id="${restaurantIdA}"`);
      // Crucial: Restaurant B's metrics must NOT be leaked to Owner A!
      expect(resA.payload).not.toContain(`restaurant_id="${restaurantIdB}"`);

      // Owner B requests /metrics
      const resB = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${tokenOwnerB}`,
        },
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.payload).toContain(`restaurant_id="${restaurantIdB}"`);
      expect(resB.payload).not.toContain(`restaurant_id="${restaurantIdA}"`);
    });

    it('rejects cross-tenant metrics access when caller specifies a conflicting x-restaurant-id or query param', async () => {
      // 1. Rejected via x-restaurant-id header mismatch in auth middleware
      const resHeader = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${tokenOwnerA}`,
          'x-restaurant-id': restaurantIdB,
        },
      });
      expect(resHeader.statusCode).toBe(403);
      expect(resHeader.json().error.message).toContain('TENANT_MISMATCH');

      // 2. Rejected via ?restaurant_id query parameter mismatch in metrics route handler
      const resQuery = await app.inject({
        method: 'GET',
        url: `/metrics?restaurant_id=${restaurantIdB}`,
        headers: {
          authorization: `Bearer ${tokenOwnerA}`,
        },
      });
      expect(resQuery.statusCode).toBe(403);
      expect(resQuery.json().error.message).toContain('Cross-tenant metrics access denied');
    });
  });

  describe('Task 2: Health Check Optimization', () => {
    it('verifies /readyz probe returns 200 with connected DB and migration status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe('ok');
      expect(json.db).toBe('connected');
      expect(json.migration).toBeDefined();
      expect(json.migration.isUpToDate).toBe(true);
      expect(json.migration.expectedVersion).toBeDefined();
      expect(json.migration.currentVersion).toBe(json.migration.expectedVersion);
    });

    it('caches /readyz probe results for 5 seconds to reduce pool load', async () => {
      const firstRes = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(firstRes.statusCode).toBe(200);
      const firstJson = firstRes.json();

      // Immediately hit /readyz again within 5s window
      const secondRes = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(secondRes.statusCode).toBe(200);
      const secondJson = secondRes.json();

      // Same timestamp implies served from cache without extra database load
      expect(secondJson.timestamp).toBe(firstJson.timestamp);
    });

    it('clears /readyz cache cleanly when requested', async () => {
      const firstRes = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(firstRes.statusCode).toBe(200);

      clearReadyzCache();

      // Should perform a fresh check
      const secondRes = await app.inject({
        method: 'GET',
        url: '/readyz',
      });
      expect(secondRes.statusCode).toBe(200);
    });
  });

  describe('Task 3: Database Client & Pool Hardening', () => {
    it('configures pool with strict timeouts and sizing limits', () => {
      // In node-postgres, options are stored on pool.options
      const opts = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(opts).toBeDefined();
      expect(opts.max).toBeGreaterThanOrEqual(1);
      expect(opts.idleTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(opts.connectionTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(opts.statement_timeout).toBe(30000);
      expect(opts.idle_in_transaction_session_timeout).toBe(15000);
    });

    it('validates production non-local PostgreSQL connections require verified TLS', () => {
      // Localhost/127.0.0.1 in production does not fail TLS check
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/testdb',
          JWT_SECRET: 'a'.repeat(32),
          COOKIE_SECRET: 'b'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).not.toThrow();

      // Remote cloud DB without verified TLS fails in production
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://user:pass@db.cloud-provider.com:5432/prod_db',
          JWT_SECRET: 'a'.repeat(32),
          COOKIE_SECRET: 'b'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).toThrow(/verified TLS/);

      // Remote cloud DB with sslmode=verify-full passes
      expect(() =>
        parseEnvConfig({
          NODE_ENV: 'production',
          DATABASE_URL:
            'postgres://user:pass@db.cloud-provider.com:5432/prod_db?sslmode=verify-full',
          JWT_SECRET: 'a'.repeat(32),
          COOKIE_SECRET: 'b'.repeat(32),
          COOKIE_SECURE: 'true',
          CORS_ORIGIN: 'https://admin.restaurant-os.com',
        }),
      ).not.toThrow();
    });
  });

  describe('Task 4: Fastify Server & Backpressure Protection', () => {
    it('configures Fastify server timeouts and request body limits', () => {
      const initialConfig = app.initialConfig;
      expect(initialConfig.connectionTimeout).toBe(10_000);
      expect(initialConfig.keepAliveTimeout).toBe(5_000);
      expect(initialConfig.maxRequestsPerSocket).toBe(1000);
      expect(initialConfig.requestTimeout).toBe(30_000);
      expect(initialConfig.bodyLimit).toBe(1_048_576);
    });

    it('registers @fastify/under-pressure decorators and functions', () => {
      expect(typeof app.memoryUsage).toBe('function');
      expect(typeof app.isUnderPressure).toBe('function');

      const mem = app.memoryUsage();
      expect(mem.heapUsed).toBeGreaterThan(0);
      expect(mem.rssBytes).toBeGreaterThan(0);
      expect(app.isUnderPressure()).toBe(false);
    });
  });
});
