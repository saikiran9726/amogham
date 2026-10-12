import type { FastifyInstance } from 'fastify';
import { checkDatabaseConnection } from '../db/tenant.js';
import { checkMigrationsStatus } from '../db/migrate.js';
import { registerRouteGuard } from '../auth/middleware.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({ method: 'GET', url: '/health', isPublic: true });
  registerRouteGuard({ method: 'GET', url: '/healthz', isPublic: true });
  registerRouteGuard({ method: 'GET', url: '/readyz', isPublic: true });

  /**
   * GET /healthz - Liveness probe
   * Returns HTTP 200 immediately if process is alive.
   */
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /readyz - Readiness probe
   * Checks database connectivity and expected migration version.
   */
  app.get('/readyz', async (_req, reply) => {
    const isDbConnected = await checkDatabaseConnection();
    if (!isDbConnected) {
      return reply.status(503).send({
        status: 'error',
        db: 'disconnected',
        error: 'Database connection failed',
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const migStatus = await checkMigrationsStatus();
      if (!migStatus.isUpToDate) {
        return reply.status(503).send({
          status: 'error',
          db: 'connected',
          migration: migStatus,
          error: 'Database migrations are not up to date',
          timestamp: new Date().toISOString(),
        });
      }

      return reply.status(200).send({
        status: 'ok',
        db: 'connected',
        migration: migStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      return reply.status(503).send({
        status: 'error',
        db: 'connected',
        error: (err as Error)?.message || 'Failed to verify migration status',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /health - General health check (backward compatible)
   */
  app.get('/health', async (_req, reply) => {
    const isDbConnected = await checkDatabaseConnection();

    const response = {
      status: isDbConnected ? ('ok' as const) : ('error' as const),
      db: isDbConnected ? ('connected' as const) : ('disconnected' as const),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      ...(isDbConnected ? {} : { error: 'Database connection failed' }),
    };

    if (!isDbConnected) {
      return reply.status(503).send(response);
    }

    return reply.status(200).send(response);
  });
}
