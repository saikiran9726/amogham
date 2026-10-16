import Fastify, { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyUnderPressure from '@fastify/under-pressure';
import { generateUuidV7 } from '@restaurant-os/shared';
import { env } from './config/env.js';
import { registerCors } from './plugins/cors.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerVersionRoutes } from './routes/version.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerStaffRoutes } from './routes/staff.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTablesRoutes } from './routes/tables.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerModifiersRoutes } from './routes/modifiers.js';
import { registerMenuRoutes } from './routes/menu.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerKotRoutes } from './routes/kots.js';
import { billsRoutes } from './routes/bills.js';
import { registerPrinterRoutes } from './routes/printers.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerLoyaltyRoutes } from './routes/loyalty.js';
import { reportsRoutes } from './routes/reports.js';
import { eodRoutes } from './routes/eod.js';
import { inventoryRoutes } from './routes/inventory.js';
import { expensesRoutes } from './routes/expenses.js';
import { healthScoreRoutes } from './routes/health-score.js';
import { alertsInsightsRoutes } from './routes/alerts-insights.js';
import { syncRoutes } from './routes/sync.js';
import { metricsRoutes } from './routes/metrics.js';
import { MetricsService } from './services/metrics.js';
import { initRealtimeServer } from './realtime/socket.js';
import { registerCleanupJob } from './jobs/cleanup.js';

/**
 * Parses TRUST_PROXY configuration:
 * - Unset, empty, or 'false' -> false (default: direct remote address only)
 * - 'true' -> true
 * - Numeric string (e.g. '1', '2') -> number of trusted hops
 * - Comma-separated list -> array of trusted CIDR/IP strings
 * - Single IP/CIDR string -> string
 */
export function parseTrustProxy(
  val?: string,
): boolean | string | string[] | ((address: string, hop: number) => boolean) {
  if (!val || val === 'false') return false;
  if (val === 'true') return true;
  const num = Number(val);
  if (!Number.isNaN(num) && Number.isInteger(num) && num >= 0) {
    return (_address: string, hop: number) => hop < num;
  }
  if (val.includes(',')) {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return val.trim();
}

export async function buildServer(options?: {
  logger?: boolean | object;
}): Promise<FastifyInstance> {
  const isDev = env.NODE_ENV === 'development';
  const isTest = env.NODE_ENV === 'test';

  const app = Fastify({
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1000,
    requestTimeout: 30_000,
    bodyLimit: 1_048_576, // 1MB request body limit
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length <= 64 && /^[A-Za-z0-9_-]+$/.test(header)) {
        return header;
      }
      return generateUuidV7();
    },
    requestIdHeader: 'x-request-id',
    logger:
      options?.logger !== undefined
        ? options.logger
        : isTest
          ? false
          : {
              level: env.LOG_LEVEL,
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'headers.authorization',
                  'headers.cookie',
                  'authorization',
                  'cookie',
                  '*.password',
                  '*.pin',
                  '*.managerPin',
                  '*.overridePin',
                  '*.ownerPin',
                  '*.approverPin',
                ],
                censor: '[REDACTED]',
              },
              transport: isDev
                ? {
                    target: 'pino-pretty',
                    options: {
                      translateTime: 'HH:MM:ss Z',
                      ignore: 'pid,hostname',
                      colorize: true,
                    },
                  }
                : undefined,
            },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  });

  // Track all registered routes in app for security auditing
  const allRoutes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const m of methods) {
      if (m !== 'HEAD' && m !== 'OPTIONS') {
        allRoutes.push({ method: m, url: routeOptions.url });
      }
    }
  });

  app.decorate('registeredRoutes', allRoutes);

  // Ensure every response carries the Request ID header
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Security & Core Middleware
  await registerCors(app);
  await registerHelmet(app);
  await registerRateLimit(app);

  // Under-pressure backpressure protection (load shedding)
  await app.register(fastifyUnderPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 1024 * 1024 * 1024,
    maxRssBytes: 1.5 * 1024 * 1024 * 1024,
    maxEventLoopUtilization: 0.98,
    retryAfter: 10,
    pressureHandler: (_req, reply, _type, _value) => {
      reply.status(503).header('Retry-After', '10').send({
        status: 'error',
        error: 'Service Unavailable: Server under extreme pressure, please retry shortly',
      });
    },
  });

  // Cookie Support
  await app.register(fastifyCookie, {
    secret: env.COOKIE_SECRET,
  });

  // Central Error Handler
  registerErrorHandler(app);

  // Track HTTP duration in Prometheus metrics
  app.addHook('onResponse', async (request, reply) => {
    const durationSeconds = reply.elapsedTime / 1000;
    MetricsService.recordHttpDuration(
      request.method,
      request.routeOptions?.url ?? 'unmatched',
      reply.statusCode,
      durationSeconds,
    );
  });

  // Application Routes
  await registerHealthRoutes(app);
  await registerVersionRoutes(app);
  await registerAuthRoutes(app);
  await registerStaffRoutes(app);
  await registerAuditRoutes(app);
  await registerSettingsRoutes(app);
  await registerTablesRoutes(app);
  await registerCategoryRoutes(app);
  await registerModifiersRoutes(app);
  await registerMenuRoutes(app);
  await registerOrderRoutes(app);
  await registerKotRoutes(app);
  await billsRoutes(app);
  await registerPrinterRoutes(app);
  await registerCustomerRoutes(app);
  await registerLoyaltyRoutes(app);
  await reportsRoutes(app);
  await eodRoutes(app);
  await inventoryRoutes(app);
  await expensesRoutes(app);
  await healthScoreRoutes(app);
  await alertsInsightsRoutes(app);
  await syncRoutes(app);
  await metricsRoutes(app);

  // Initialize Realtime Socket.IO Layer
  initRealtimeServer(app);

  // Register scheduled idempotency cleanup job (graceful shutdown on onClose)
  registerCleanupJob(app);

  return app;
}
