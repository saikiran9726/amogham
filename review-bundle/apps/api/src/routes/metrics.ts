import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { MetricsService } from '../services/metrics.js';
import { env } from '../config/env.js';
import { authenticate, registerRouteGuard } from '../auth/middleware.js';
import { Permissions, Roles, AppError } from '@restaurant-os/shared';

function constantTimeTokenCompare(
  incoming: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!incoming || !expected) return false;
  const hashA = crypto.createHash('sha256').update(incoming).digest();
  const hashB = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/metrics',
    isPublic: false,
    permission: Permissions.REPORT_READ,
  });

  app.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Check machine token if configured via constant-time comparison
    const metricsHeader = request.headers['x-metrics-token'] as string | undefined;
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const isMachineTokenValid =
      Boolean(env.METRICS_TOKEN) &&
      (constantTimeTokenCompare(metricsHeader, env.METRICS_TOKEN) ||
        constantTimeTokenCompare(bearerToken, env.METRICS_TOKEN));

    if (isMachineTokenValid) {
      // Machine scraper has cluster-wide view (or optional query filter if specified)
      const requestedRestaurantId = (request.query as { restaurant_id?: string })?.restaurant_id;
      const data = await MetricsService.getMetrics(requestedRestaurantId);
      return reply.type(MetricsService.getContentType()).send(data);
    }

    // 2. Otherwise authenticate via standard user session
    try {
      await authenticate(request, reply);
      const user = request.user;
      if (!user) {
        throw AppError.unauthorized('Authentication required to access metrics');
      }

      const isAuthorized =
        user.role === Roles.OWNER ||
        user.role === Roles.MANAGER ||
        (user.permissions && user.permissions.includes(Permissions.REPORT_READ));

      if (!isAuthorized) {
        throw AppError.forbidden('Forbidden: Missing permissions to access metrics');
      }

      // Restrict multi-tenant data access: ensure caller only accesses metrics for their restaurant
      const requestedRestaurantId = (request.headers['x-restaurant-id'] ||
        (request.query as { restaurant_id?: string })?.restaurant_id) as string | undefined;

      if (
        requestedRestaurantId &&
        user.restaurantId &&
        requestedRestaurantId !== user.restaurantId
      ) {
        throw AppError.forbidden('Forbidden: Cross-tenant metrics access denied');
      }

      const tenantRestaurantId = user.restaurantId;
      const data = await MetricsService.getMetrics(tenantRestaurantId);
      return reply.type(MetricsService.getContentType()).send(data);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.unauthorized('Authentication required to access metrics');
    }
  });
}
