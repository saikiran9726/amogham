import type { FastifyInstance } from 'fastify';
import { eq, and, asc, desc } from 'drizzle-orm';
import { Permissions, AppError } from '@restaurant-os/shared';
import { forTenant, forSystem } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerOrderQueryRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/orders/:id',
    isPublic: false,
    permission: Permissions.ORDER_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/orders',
    isPublic: false,
    permission: Permissions.ORDER_READ,
  });

  /**
   * GET /orders/:id - Get order details
   */
  app.get<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: [requirePermission(Permissions.ORDER_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const { id } = request.params;
      const tenant = forTenant(authUser.restaurantId);

      let order: typeof orders.$inferSelect | undefined = undefined;
      try {
        const rows = await tenant.db
          .select()
          .from(orders)
          .where(and(eq(orders.id, id), eq(orders.restaurantId, authUser.restaurantId)))
          .limit(1);
        order = rows[0];
      } catch (err: unknown) {
        request.log.debug({ err }, 'Database error looking up order, treating as not found');
      }

      if (!order) {
        // Anti-IDOR security telemetry: check if entity exists under another tenant
        try {
          const system = forSystem();
          const [foreignOrder] = await system.db
            .select({ id: orders.id, restaurantId: orders.restaurantId })
            .from(orders)
            .where(eq(orders.id, id))
            .limit(1);

          if (foreignOrder) {
            await recordAuditLog({
              restaurantId: authUser.restaurantId,
              userId: authUser.userId,
              action: 'security.cross_tenant_access_attempt',
              entity: 'order',
              entityId: id,
              before: { targetRestaurantId: foreignOrder.restaurantId },
              request,
            });
            request.log.warn(
              {
                orderId: id,
                targetRestaurantId: foreignOrder.restaurantId,
                callerRestaurantId: authUser.restaurantId,
              },
              'Cross-tenant access probe detected and neutralized',
            );
          }
        } catch (err: unknown) {
          request.log.debug({ err }, 'Could not probe foreign tenant existence');
        }

        throw AppError.notFound('Order not found');
      }

      const items = await tenant.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id))
        .orderBy(asc(orderItems.lineNo));

      return reply.status(200).send({
        ...order,
        items,
      });
    },
  );

  /**
   * GET /orders - List orders by status or table
   */
  app.get(
    '/orders',
    { preHandler: [requirePermission(Permissions.ORDER_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const query = request.query as { status?: string; tableId?: string };

      const conditions = [eq(orders.restaurantId, authUser.restaurantId)];
      if (query.status) conditions.push(eq(orders.status, query.status));
      if (query.tableId) conditions.push(eq(orders.tableId, query.tableId));

      const rows = await tenant.db
        .select()
        .from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(50);

      return reply.status(200).send(rows);
    },
  );
}
