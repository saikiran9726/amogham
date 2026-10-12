import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import {
  Permissions,
  AppError,
  updateKotStatusSchema,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { orders } from '../../db/schema/orders.js';
import { kots, kotItems } from '../../db/schema/kots.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { syncOrderAndTableStatus } from './helpers.js';

export async function registerKotStatusRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/kots/:id/seen',
    isPublic: false,
    permission: Permissions.KOT_UPDATE_STATUS,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/kot-items/:id/done',
    isPublic: false,
    permission: Permissions.ITEM_COMPLETE,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/kots/:id/status',
    isPublic: false,
    permission: Permissions.KOT_UPDATE_STATUS,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/orders/:id/served',
    isPublic: false,
    permission: Permissions.KOT_UPDATE_STATUS,
  });

  /**
   * POST /kots/:id/seen - Mark KOT seen by kitchen
   */
  app.post(
    '/kots/:id/seen',
    { preHandler: [requirePermission(Permissions.KOT_UPDATE_STATUS)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params as { id: string };

      const [updated] = await tenant.db
        .update(kots)
        .set({
          seenAt: new Date(),
          status: sql`CASE WHEN status = 'new' THEN 'preparing' ELSE status END`,
        })
        .where(and(eq(kots.id, id), eq(kots.restaurantId, authUser.restaurantId)))
        .returning();

      if (!updated) {
        throw new AppError('KOT not found', 'KOT_NOT_FOUND', 404);
      }

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.updated',
        { kotId: id, status: updated.status, seenAt: updated.seenAt },
        'all',
      );

      return reply.status(200).send({ success: true, kot: updated });
    },
  );

  /**
   * PATCH /kot-items/:id/done - Mark item done in kitchen
   */
  app.patch(
    '/kot-items/:id/done',
    { preHandler: [requirePermission(Permissions.ITEM_COMPLETE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params as { id: string };

      const [item] = await tenant.db
        .select()
        .from(kotItems)
        .innerJoin(kots, eq(kotItems.kotId, kots.id))
        .where(and(eq(kotItems.id, id), eq(kots.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!item) {
        throw new AppError('KOT item not found', 'ITEM_NOT_FOUND', 404);
      }

      const [updatedItem] = await tenant.db
        .update(kotItems)
        .set({ status: 'done', doneAt: new Date() })
        .where(eq(kotItems.id, id))
        .returning();

      // Check if all items in this KOT are done
      const siblingItems = await tenant.db
        .select()
        .from(kotItems)
        .where(eq(kotItems.kotId, item.kots.id));

      const allKotDone = siblingItems.every(
        (i) => i.id === id || i.status === 'done' || i.status === 'cancelled',
      );
      if (allKotDone) {
        await tenant.db
          .update(kots)
          .set({ status: 'ready', readyAt: new Date() })
          .where(eq(kots.id, item.kots.id));
      }

      // Check if whole order is now ready
      await syncOrderAndTableStatus(item.kots.orderId, authUser.restaurantId, tenant.db);

      if (allKotDone) {
        emitRealtimeEvent(
          authUser.restaurantId,
          'kot.statusChanged',
          {
            kotId: item.kots.id,
            orderId: item.kots.orderId,
            kotNumber: item.kots.kotNumber,
            status: 'ready',
          },
          'all',
        );
      }

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.itemDone',
        { kotItemId: id, kotId: item.kots.id, orderId: item.kots.orderId },
        'all',
      );

      return reply.status(200).send({ success: true, item: updatedItem });
    },
  );

  /**
   * PATCH /kots/:id/status - Update KOT status (e.g. preparing -> ready -> served)
   */
  app.patch(
    '/kots/:id/status',
    { preHandler: [requirePermission(Permissions.KOT_UPDATE_STATUS)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params as { id: string };
      const body = updateKotStatusSchema.parse(request.body);

      const updates: Record<string, unknown> = { status: body.status };
      if (body.status === 'ready') updates.readyAt = new Date();
      if (body.status === 'served') updates.servedAt = new Date();

      const [updated] = await tenant.db
        .update(kots)
        .set(updates)
        .where(and(eq(kots.id, id), eq(kots.restaurantId, authUser.restaurantId)))
        .returning();

      if (!updated) {
        throw new AppError('KOT not found', 'KOT_NOT_FOUND', 404);
      }

      await syncOrderAndTableStatus(updated.orderId, authUser.restaurantId, tenant.db);

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.statusChanged',
        { kotId: id, orderId: updated.orderId, kotNumber: updated.kotNumber, status: body.status },
        'all',
      );

      return reply.status(200).send({ success: true, kot: updated });
    },
  );

  /**
   * POST /orders/:id/served - Mark entire order served by waiter
   */
  app.post(
    '/orders/:id/served',
    { preHandler: [requirePermission(Permissions.KOT_UPDATE_STATUS)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id: orderId } = request.params as { id: string };

      const [order] = await tenant.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!order) {
        throw new AppError('Order not found', 'ORDER_NOT_FOUND', 404);
      }

      // Mark all KOTs as served
      await tenant.db
        .update(kots)
        .set({ status: 'served', servedAt: new Date() })
        .where(eq(kots.orderId, orderId));

      await syncOrderAndTableStatus(orderId, authUser.restaurantId, tenant.db);

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.statusChanged',
        { orderId, status: 'served' },
        'all',
      );

      return reply.status(200).send({ success: true, orderId });
    },
  );
}
