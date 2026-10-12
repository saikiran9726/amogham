import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  Permissions,
  AppError,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { menuItems } from '../../db/schema/menu-items.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';

export async function registerMenuItemOosRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/menu/:itemId/oos',
    isPublic: false,
    permission: Permissions.MENU_MARK_OOS,
  });
  registerRouteGuard({
    method: 'DELETE',
    url: '/menu/:itemId/oos',
    isPublic: false,
    permission: Permissions.MENU_MARK_OOS,
  });

  /**
   * POST /menu/:itemId/oos - Mark menu item out-of-stock
   */
  app.post(
    '/menu/:itemId/oos',
    { preHandler: [requirePermission(Permissions.MENU_MARK_OOS)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { itemId } = request.params as { itemId: string };
      const body = (request.body as { reason?: string }) || {};
      const reason = body.reason || 'Out of stock';

      const existing = await tenant.db
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (existing.length === 0) {
        throw new AppError('Menu item not found', 'ITEM_NOT_FOUND', 404);
      }

      const [updated] = await tenant.db
        .update(menuItems)
        .set({
          available: false,
          oosReason: reason,
          oosSetBy: authUser.userId,
          oosSetAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(menuItems.id, itemId))
        .returning();

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu.mark_oos',
        entity: 'menu_item',
        entityId: itemId,
        before: { available: true },
        after: { available: false, oosReason: reason },
        request,
      });

      emitRealtimeEvent(
        authUser.restaurantId,
        'menu.availabilityChanged',
        {
          itemId,
          available: false,
          oosReason: reason,
        },
        'all',
      );

      return reply.status(200).send({ success: true, item: updated });
    },
  );

  /**
   * DELETE /menu/:itemId/oos - Mark menu item back in stock
   */
  app.delete(
    '/menu/:itemId/oos',
    { preHandler: [requirePermission(Permissions.MENU_MARK_OOS)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { itemId } = request.params as { itemId: string };

      const existing = await tenant.db
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.id, itemId), eq(menuItems.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (existing.length === 0) {
        throw new AppError('Menu item not found', 'ITEM_NOT_FOUND', 404);
      }

      const [updated] = await tenant.db
        .update(menuItems)
        .set({
          available: true,
          oosReason: null,
          oosSetBy: null,
          oosSetAt: null,
          updatedAt: new Date(),
        })
        .where(eq(menuItems.id, itemId))
        .returning();

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu.unmark_oos',
        entity: 'menu_item',
        entityId: itemId,
        before: { available: false, oosReason: existing[0]?.oosReason },
        after: { available: true },
        request,
      });

      emitRealtimeEvent(
        authUser.restaurantId,
        'menu.availabilityChanged',
        {
          itemId,
          available: true,
        },
        'all',
      );

      return reply.status(200).send({ success: true, item: updated });
    },
  );
}
