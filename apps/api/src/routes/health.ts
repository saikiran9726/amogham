import type { FastifyInstance } from 'fastify';
import { checkDatabaseConnection } from '../db/tenant.js';
import { checkMigrationsStatus } from '../db/migrate.js';
import { registerRouteGuard } from '../auth/middleware.js';

interface ReadyzCacheEntry {
  timestamp: number;
  statusCode: number;
  payload: {
    status: string;
    db: string;
    migration?: {
      isUpToDate: boolean;
      expectedVersion: string | null;
      currentVersion: string | null;
    };
    error?: string;
    timestamp: string;
  };
}

let readyzCache: ReadyzCacheEntry | null = null;
const READYZ_CACHE_TTL_MS = 5000;

export function clearReadyzCache(): void {
  readyzCache = null;
}

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
   * Probes are strictly read-only and cached for 5 seconds to reduce pool pressure.
   */
  app.get('/readyz', async (_req, reply) => {
    const now = Date.now();
    if (readyzCache && now - readyzCache.timestamp < READYZ_CACHE_TTL_MS) {
      return reply.status(readyzCache.statusCode).send(readyzCache.payload);
    }

    try {
      // Verify migrations read-only using at most one connection from pool
      const migStatus = await checkMigrationsStatus();

      if (!migStatus.isUpToDate) {
        const payload = {
          status: 'error',
          db: 'connected',
          migration: migStatus,
          error: 'Database migrations are not up to date',
          timestamp: new Date().toISOString(),
        };
        readyzCache = {
          timestamp: now,
          statusCode: 503,
          payload,
        };
        return reply.status(503).send(payload);
      }

      const payload = {
        status: 'ok',
        db: 'connected',
        migration: migStatus,
        timestamp: new Date().toISOString(),
      };
      readyzCache = {
        timestamp: now,
        statusCode: 200,
        payload,
      };
      return reply.status(200).send(payload);
    } catch (err: unknown) {
      const payload = {
        status: 'error',
        db: 'disconnected',
        error: (err as Error)?.message || 'Database connection failed',
        timestamp: new Date().toISOString(),
      };
      readyzCache = {
        timestamp: now,
        statusCode: 503,
        payload,
      };
      return reply.status(503).send(payload);
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
