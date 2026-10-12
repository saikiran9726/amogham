import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, asc, desc, gte, inArray } from 'drizzle-orm';
import { Permissions, serializeKitchenState } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { kots, kotItems } from '../../db/schema/kots.js';
import { tables } from '../../db/schema/tables.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';

export async function registerKotListRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/kots',
    isPublic: false,
    permission: Permissions.KOT_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/kitchen/state',
    isPublic: false,
    permission: Permissions.KOT_READ,
  });

  /**
   * GET /kots - List KOTs with status and since filter
   */
  app.get(
    '/kots',
    { preHandler: [requirePermission(Permissions.KOT_READ)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { status, orderId, since } = request.query as {
        status?: string;
        orderId?: string;
        since?: string;
      };

      const conditions = [eq(kots.restaurantId, authUser.restaurantId)];
      if (status) conditions.push(eq(kots.status, status));
      if (orderId) conditions.push(eq(kots.orderId, orderId));
      if (since) conditions.push(gte(kots.createdAt, new Date(since)));

      const kotRows = await tenant.db
        .select()
        .from(kots)
        .where(and(...conditions))
        .orderBy(desc(kots.createdAt));

      if (kotRows.length === 0) {
        return reply.status(200).send({ kots: [] });
      }

      const kotIds = kotRows.map((k) => k.id);
      const items = await tenant.db
        .select({
          id: kotItems.id,
          kotId: kotItems.kotId,
          orderItemId: kotItems.orderItemId,
          name: orderItems.nameSnapshot,
          qty: kotItems.qty,
          action: kotItems.action,
          status: kotItems.status,
          noteSnapshot: kotItems.noteSnapshot,
          doneAt: kotItems.doneAt,
          cancelledReason: kotItems.cancelledReason,
          createdAt: kotItems.createdAt,
        })
        .from(kotItems)
        .leftJoin(orderItems, eq(kotItems.orderItemId, orderItems.id))
        .where(inArray(kotItems.kotId, kotIds));

      type KotItemRow = (typeof items)[number];
      const itemsByKotId = new Map<string, KotItemRow[]>();
      for (const item of items) {
        if (!itemsByKotId.has(item.kotId)) itemsByKotId.set(item.kotId, []);
        itemsByKotId.get(item.kotId)!.push(item);
      }

      const formatted = kotRows.map((k) => ({
        ...k,
        items: itemsByKotId.get(k.id) || [],
      }));

      return reply.status(200).send({ kots: formatted });
    },
  );

  /**
   * GET /kitchen/state - Dedicated kitchen feed (sanitized, zero prices, zero customer data)
   */
  app.get(
    '/kitchen/state',
    { preHandler: [requirePermission(Permissions.KOT_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const activeKots = await tenant.db
        .select({
          id: kots.id,
          orderId: kots.orderId,
          tableLabel: tables.label,
          kotNumber: kots.kotNumber,
          type: kots.type,
          status: kots.status,
          createdAt: kots.createdAt,
          seenAt: kots.seenAt,
          readyAt: kots.readyAt,
        })
        .from(kots)
        .leftJoin(orders, eq(kots.orderId, orders.id))
        .leftJoin(tables, eq(orders.tableId, tables.id))
        .where(
          and(
            eq(kots.restaurantId, authUser.restaurantId),
            inArray(kots.status, ['new', 'preparing', 'ready']),
          ),
        )
        .orderBy(asc(kots.createdAt));

      if (activeKots.length === 0) {
        return reply.status(200).send({ activeKots: [] });
      }

      const kotIds = activeKots.map((k) => k.id);
      const items = await tenant.db
        .select({
          id: kotItems.id,
          kotId: kotItems.kotId,
          orderItemId: kotItems.orderItemId,
          nameSnapshot: orderItems.nameSnapshot,
          qty: kotItems.qty,
          action: kotItems.action,
          status: kotItems.status,
          noteSnapshot: kotItems.noteSnapshot,
          modifiers: orderItems.modifiers,
          doneAt: kotItems.doneAt,
        })
        .from(kotItems)
        .innerJoin(orderItems, eq(kotItems.orderItemId, orderItems.id))
        .where(inArray(kotItems.kotId, kotIds));

      type ActiveKotItemRow = (typeof items)[number];
      const itemsMap = new Map<string, ActiveKotItemRow[]>();
      for (const i of items) {
        if (!itemsMap.has(i.kotId)) itemsMap.set(i.kotId, []);
        itemsMap.get(i.kotId)!.push(i);
      }

      const combined = activeKots.map((k) => ({
        ...k,
        items: itemsMap.get(k.id) || [],
      }));

      // Authoritative serializer stripping all pricing and customer information
      const sanitized = serializeKitchenState(combined);
      return reply.status(200).send(sanitized);
    },
  );
}
