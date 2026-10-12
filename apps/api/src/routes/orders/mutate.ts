import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  Permissions,
  createOrderSchema,
  updateOrderSchema,
  AppError,
  generateUuidV7,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { tables } from '../../db/schema/tables.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { computeOrderTotals } from '../../services/orders/pricing.js';
import { withIdempotency, extractIdempotencyKey } from '../../http/idempotency.js';

export async function registerOrderMutateRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/orders',
    isPublic: false,
    permission: Permissions.ORDER_CREATE,
  });
  registerRouteGuard({
    method: 'PUT',
    url: '/orders/:id',
    isPublic: false,
    permission: Permissions.ORDER_UPDATE,
  });

  /**
   * POST /orders - Create order with client UUIDv7 (Idempotent)
   */
  app.post(
    '/orders',
    { preHandler: [requirePermission(Permissions.ORDER_CREATE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = createOrderSchema.parse(request.body);
      const idempotencyKey = extractIdempotencyKey(request, body);

      const execution = await tenant.withTx(async (_tenantTx, tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: authUser.restaurantId,
            userId: authUser.userId,
            commandType: 'order.create',
            key: idempotencyKey,
            requestBody: request.body,
          },
          async (trx) => {
            // Compute prices from database authoritative records
            const { processedItems, subtotalPaise, taxPaise, totalPaise } =
              await computeOrderTotals(authUser.restaurantId, body.items);

            // Check if table occupied
            if (body.tableId) {
              const [table] = await trx
                .select()
                .from(tables)
                .where(
                  and(eq(tables.id, body.tableId), eq(tables.restaurantId, authUser.restaurantId)),
                )
                .limit(1);

              if (!table) throw AppError.badRequest('Table not found');
            }

            // Insert order
            const [createdOrder] = await trx
              .insert(orders)
              .values({
                id: body.id,
                restaurantId: authUser.restaurantId,
                tableId: body.tableId || null,
                customerId: body.customerId || null,
                type: body.type,
                guests: body.guests,
                status: 'saved',
                specialInstructions: body.specialInstructions || null,
                subtotalPaise,
                taxPaise,
                totalPaise,
                createdBy: authUser.userId,
                version: 1,
              })
              .returning();

            // Insert items in one batch
            const itemRows = processedItems.map((item) => ({
              id: generateUuidV7(),
              orderId: body.id,
              itemId: item.itemId,
              nameSnapshot: item.nameSnapshot,
              pricePaiseSnapshot: item.pricePaiseSnapshot,
              taxRateBpSnapshot: item.taxRateBpSnapshot,
              qty: item.qty,
              modifiers: item.modifiers,
              note: item.note,
              lineNo: item.lineNo,
              status: 'active' as const,
            }));

            const insertedItems =
              itemRows.length > 0 ? await trx.insert(orderItems).values(itemRows).returning() : [];

            // Update table status if dine-in
            if (body.tableId) {
              await trx
                .update(tables)
                .set({
                  status: 'occupied',
                  currentOrderId: body.id,
                  updatedAt: new Date(),
                })
                .where(eq(tables.id, body.tableId));
            }

            await recordAuditLog({
              restaurantId: authUser.restaurantId,
              userId: authUser.userId,
              action: 'order.create',
              entity: 'order',
              entityId: body.id,
              after: { totalPaise, itemsCount: processedItems.length },
              request,
            });

            return {
              ...createdOrder,
              items: insertedItems,
            };
          },
        );
      });

      return reply.status(execution.replayed ? 200 : 201).send(execution.result);
    },
  );

  /**
   * PUT /orders/:id - Replace order lines with optimistic concurrency check (Idempotent)
   */
  app.put<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: [requirePermission(Permissions.ORDER_UPDATE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;
      const body = updateOrderSchema.parse(request.body);
      const idempotencyKey = extractIdempotencyKey(request, body);

      const execution = await tenant.withTx(async (_tenantTx, tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: authUser.restaurantId,
            userId: authUser.userId,
            commandType: 'order.update',
            key: idempotencyKey,
            requestBody: request.body,
          },
          async (trx) => {
            const [target] = await trx
              .select()
              .from(orders)
              .where(and(eq(orders.id, id), eq(orders.restaurantId, authUser.restaurantId)))
              .limit(1);

            if (!target) throw AppError.notFound('Order not found');

            // Optimistic concurrency check
            if (target.version !== body.version) {
              throw AppError.conflict(
                'Order was modified elsewhere. Please reload the current order state.',
              );
            }

            // Compute authoritative totals
            const { processedItems, subtotalPaise, taxPaise, totalPaise } =
              await computeOrderTotals(authUser.restaurantId, body.items);

            // Delete previous items and insert new
            await trx.delete(orderItems).where(eq(orderItems.orderId, target.id));

            const itemRows = processedItems.map((item) => ({
              id: generateUuidV7(),
              orderId: target.id,
              itemId: item.itemId,
              nameSnapshot: item.nameSnapshot,
              pricePaiseSnapshot: item.pricePaiseSnapshot,
              taxRateBpSnapshot: item.taxRateBpSnapshot,
              qty: item.qty,
              modifiers: item.modifiers,
              note: item.note,
              lineNo: item.lineNo,
              status: 'active' as const,
            }));

            const insertedItems =
              itemRows.length > 0 ? await trx.insert(orderItems).values(itemRows).returning() : [];

            const updateData: Record<string, unknown> = {
              version: target.version + 1,
              subtotalPaise,
              taxPaise,
              totalPaise,
              updatedAt: new Date(),
            };

            if (body.guests !== undefined) updateData.guests = body.guests;
            if (body.type !== undefined) updateData.type = body.type;
            if (body.tableId !== undefined) updateData.tableId = body.tableId;
            if (body.customerId !== undefined) updateData.customerId = body.customerId;
            if (body.specialInstructions !== undefined)
              updateData.specialInstructions = body.specialInstructions;

            const [updatedOrder] = await trx
              .update(orders)
              .set(updateData)
              .where(eq(orders.id, target.id))
              .returning();

            return {
              ...updatedOrder,
              items: insertedItems,
            };
          },
        );
      });

      return reply.status(200).send(execution.result);
    },
  );
}
