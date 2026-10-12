import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MetricsService } from '../services/metrics.js';
import { env } from '../config/env.js';
import { authenticate, registerRouteGuard } from '../auth/middleware.js';
import { Permissions, Roles, AppError } from '@restaurant-os/shared';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/metrics',
    isPublic: false,
    permission: Permissions.REPORT_READ,
  });

  app.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Check machine token if configured
    const metricsHeader = request.headers['x-metrics-token'];
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (
      env.METRICS_TOKEN &&
      (metricsHeader === env.METRICS_TOKEN || bearerToken === env.METRICS_TOKEN)
    ) {
      const data = await MetricsService.getMetrics();
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

      const data = await MetricsService.getMetrics();
      return reply.type(MetricsService.getContentType()).send(data);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw AppError.unauthorized('Authentication required to access metrics');
    }
  });
}
