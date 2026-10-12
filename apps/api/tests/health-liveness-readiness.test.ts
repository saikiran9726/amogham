import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

describe('Health, Liveness, Readiness & Version Route Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz: returns HTTP 200 liveness probe immediately', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /readyz: verifies database connection and current/expected migration version', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/readyz',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body.migration).toBeDefined();
    expect(body.migration.isUpToDate).toBe(true);
    expect(body.migration.expectedVersion).toBe('0019_menu_sample_and_perf_indexes');
    expect(body.migration.currentVersion).toBe('0019_menu_sample_and_perf_indexes');
  });

  it('GET /version: trimmed strictly to name and version without extra environment or uptime fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/version',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      name: '@restaurant-os/api',
      version: '0.1.0',
    });
    expect(body.environment).toBeUndefined();
    expect(body.uptime).toBeUndefined();
  });
});
