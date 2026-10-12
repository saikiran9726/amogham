import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import {
  Permissions,
  AppError,
  sendKotInputSchema,
  Roles,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { kots, kotItems } from '../../db/schema/kots.js';
import { withIdempotency, extractIdempotencyKey } from '../../http/idempotency.js';
import { menuItems } from '../../db/schema/menu-items.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { verifyApproverPin } from '../../auth/approval.js';
import { allocateKotNumber, syncOrderAndTableStatus } from './helpers.js';

export async function registerKotSendRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/orders/:id/kots',
    isPublic: false,
    permission: Permissions.KOT_CREATE,
  });

  /**
   * POST /orders/:id/kots - SEND KOT (diff engine, sequential numbering, idempotent)
   */
  app.post(
    '/orders/:id/kots',
    { preHandler: [requirePermission(Permissions.KOT_CREATE)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id: orderId } = request.params as { id: string };
      const idempotencyKey = extractIdempotencyKey(
        request,
        (request.body as { idempotencyKey?: string }) || null,
      );

      const bodyParse = sendKotInputSchema.safeParse(request.body || {});
      if (!bodyParse.success) {
        throw new AppError(
          'Invalid KOT payload',
          'VALIDATION_ERROR',
          400,
          bodyParse.error.format(),
        );
      }
      const { provisionalLabel, cancelledItems = [] } = bodyParse.data;

      // Diff engine execution inside single DB transaction with idempotency
      const { result: responsePayload, replayed } = await tenant.withTx(async (_tenantTx, tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: authUser.restaurantId,
            userId: authUser.userId,
            commandType: 'order.send_kot',
            key: idempotencyKey,
            requestBody: request.body,
          },
          async (trx) => {
            // Fetch order
            const [order] = await trx
              .select()
              .from(orders)
              .where(and(eq(orders.id, orderId), eq(orders.restaurantId, authUser.restaurantId)))
              .for('update')
              .limit(1);

            if (!order) {
              throw new AppError('Order not found', 'ORDER_NOT_FOUND', 404);
            }

            // Fetch all current order items
            const currentOrderItems = await trx
              .select()
              .from(orderItems)
              .where(eq(orderItems.orderId, orderId));

            // Fetch existing KOTs for order to determine KOT type ('new' vs 'additional'/'modified')
            const existingKots = await trx.select().from(kots).where(eq(kots.orderId, orderId));

            const isFirstKot = existingKots.length === 0;

            // Fetch previously sent kot_items to compute diff
            const existingKotItems = isFirstKot
              ? []
              : await trx
                  .select()
                  .from(kotItems)
                  .where(
                    inArray(
                      kotItems.kotId,
                      existingKots.map((k) => k.id),
                    ),
                  );

            // Verify out-of-stock items before sending
            const itemIdsToCheck = currentOrderItems
              .filter((i) => i.status === 'active' && i.kotState !== 'sent')
              .map((i) => i.itemId);

            if (itemIdsToCheck.length > 0) {
              const dbMenuItems = await trx
                .select({ id: menuItems.id, name: menuItems.name, available: menuItems.available })
                .from(menuItems)
                .where(inArray(menuItems.id, itemIdsToCheck));

              const oosList = dbMenuItems.filter((m) => !m.available);
              if (oosList.length > 0) {
                throw new AppError(
                  `Items are out of stock: ${oosList.map((m) => m.name).join(', ')}`,
                  'ITEM_OOS',
                  409,
                  { oosItemIds: oosList.map((m) => m.id) },
                );
              }
            }

            // Determine diff lines
            const linesToCreate: Array<{
              orderItemId: string;
              qty: number;
              action: 'add' | 'cancel' | 'update';
              noteSnapshot?: string | null;
              cancelledReason?: string;
            }> = [];

            // Check for unsent / updated items
            for (const item of currentOrderItems) {
              if (item.status === 'cancelled') continue;

              const previouslySentQty = existingKotItems
                .filter((ki) => ki.orderItemId === item.id)
                .reduce((sum, ki) => {
                  if (ki.action === 'add') return sum + ki.qty;
                  if (ki.action === 'cancel') return sum - ki.qty;
                  return sum;
                }, 0);

              if (previouslySentQty === 0) {
                linesToCreate.push({
                  orderItemId: item.id,
                  qty: item.qty,
                  action: 'add',
                  noteSnapshot: item.note,
                });
              } else if (item.qty > previouslySentQty) {
                linesToCreate.push({
                  orderItemId: item.id,
                  qty: item.qty - previouslySentQty,
                  action: 'add',
                  noteSnapshot: item.note,
                });
              } else if (item.qty < previouslySentQty) {
                linesToCreate.push({
                  orderItemId: item.id,
                  qty: previouslySentQty - item.qty,
                  action: 'update',
                  noteSnapshot: item.note,
                });
              }
            }

            // Check cancellations
            for (const cancelledReq of cancelledItems) {
              const targetOrderItem = currentOrderItems.find(
                (i) => i.id === cancelledReq.orderItemId,
              );
              if (!targetOrderItem) continue;

              const sentItemLogs = existingKotItems.filter(
                (ki) => ki.orderItemId === targetOrderItem.id && ki.status === 'done',
              );

              if (sentItemLogs.length > 0) {
                const pin = cancelledReq.pin ?? cancelledReq.managerPin;
                if (!pin || !cancelledReq.approverUserId) {
                  throw new AppError(
                    'Item is already prepared. Manager PIN required to cancel.',
                    'PIN_REQUIRED',
                    403,
                  );
                }

                await verifyApproverPin(trx, {
                  restaurantId: authUser.restaurantId,
                  approverUserId: cancelledReq.approverUserId,
                  pin,
                  allowedRoles: [Roles.OWNER, Roles.MANAGER],
                  reason: cancelledReq.reason,
                  entity: 'kot_item',
                  entityId: cancelledReq.orderItemId,
                  actorUserId: authUser.userId,
                  request,
                });
              }

              await trx
                .update(orderItems)
                .set({
                  status: 'cancelled',
                  cancelledReason: cancelledReq.reason,
                })
                .where(eq(orderItems.id, targetOrderItem.id));

              linesToCreate.push({
                orderItemId: targetOrderItem.id,
                qty: targetOrderItem.qty,
                action: 'cancel',
                noteSnapshot: targetOrderItem.note,
                cancelledReason: cancelledReq.reason,
              });

              await recordAuditLog({
                restaurantId: authUser.restaurantId,
                userId: authUser.userId,
                action: 'order.cancel_item_after_kot',
                entity: 'order_item',
                entityId: targetOrderItem.id,
                before: { status: 'active', qty: targetOrderItem.qty },
                after: { status: 'cancelled', reason: cancelledReq.reason },
                request,
              });
            }

            if (linesToCreate.length === 0) {
              if (existingKots.length > 0) {
                const latestKot = existingKots.reduce((latest, candidate) =>
                  candidate.createdAt > latest.createdAt ? candidate : latest,
                );
                return {
                  success: true,
                  duplicate: true,
                  kot: {
                    ...latestKot,
                    items: existingKotItems.filter((item) => item.kotId === latestKot.id),
                  },
                  provisionalMapping: null,
                };
              }
              throw new AppError('No new or modified items to send in KOT', 'EMPTY_KOT_DIFF', 400);
            }

            const kotNumber = await allocateKotNumber(authUser.restaurantId, trx);

            const kotType: 'new' | 'additional' | 'modified' = isFirstKot
              ? 'new'
              : linesToCreate.some((l) => l.action === 'cancel' || l.action === 'update')
                ? 'modified'
                : 'additional';

            const [newKot] = await trx
              .insert(kots)
              .values({
                orderId,
                restaurantId: authUser.restaurantId,
                kotNumber,
                provisionalLabel: provisionalLabel || null,
                type: kotType,
                status: 'new',
                createdBy: authUser.userId,
              })
              .returning();

            if (!newKot) {
              throw new AppError('Failed to generate KOT record', 'INTERNAL_SERVER_ERROR', 500);
            }

            const insertedKotItems = [];
            for (const line of linesToCreate) {
              const [insertedKi] = await trx
                .insert(kotItems)
                .values({
                  kotId: newKot.id,
                  orderItemId: line.orderItemId,
                  qty: line.qty,
                  action: line.action,
                  status: 'pending',
                  noteSnapshot: line.noteSnapshot,
                  cancelledReason: line.cancelledReason,
                })
                .returning();
              insertedKotItems.push(insertedKi);

              await trx
                .update(orderItems)
                .set({ kotState: 'sent' })
                .where(eq(orderItems.id, line.orderItemId));
            }

            await syncOrderAndTableStatus(orderId, authUser.restaurantId, trx);

            await recordAuditLog({
              restaurantId: authUser.restaurantId,
              userId: authUser.userId,
              action: 'kot.create',
              entity: 'kot',
              entityId: newKot.id,
              after: {
                kotNumber,
                type: kotType,
                linesCount: linesToCreate.length,
              },
              request,
            });

            return {
              success: true,
              duplicate: false,
              kot: {
                ...newKot,
                items: insertedKotItems,
              },
              provisionalMapping: provisionalLabel
                ? { provisional: provisionalLabel, kotNumber, kotId: newKot.id }
                : null,
            };
          },
        );
      });

      if (replayed || responsePayload.duplicate) {
        return reply.status(200).send(responsePayload);
      }

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.created',
        {
          kotId: responsePayload.kot.id,
          orderId,
          kotNumber: responsePayload.kot.kotNumber,
          type: responsePayload.kot.type,
          status: responsePayload.kot.status,
        },
        'kitchen',
      );

      emitRealtimeEvent(
        authUser.restaurantId,
        'kot.created',
        {
          kotId: responsePayload.kot.id,
          orderId,
          kotNumber: responsePayload.kot.kotNumber,
          type: responsePayload.kot.type,
        },
        'floor',
      );

      return reply.status(201).send(responsePayload);
    },
  );
}
