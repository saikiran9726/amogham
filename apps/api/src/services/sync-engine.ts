import { eq, and, desc, asc, sql, gt } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { db } from '../db/client.js';
import {
  deviceRegistry,
  hubRegistry,
  syncEvents,
  deadLetterCommands,
  conflictReviews,
} from '../db/schema/sync.js';
import { orders, orderItems, syncCommands } from '../db/schema/orders.js';
import { kots } from '../db/schema/kots.js';
import { emitRealtimeEvent } from '../realtime/socket.js';
import {
  AppError,
  orderCreateCommandPayloadSchema,
  kotStatusCommandPayloadSchema,
  paymentRecordCommandPayloadSchema,
  type SyncPushBatchInput,
  type SyncPushBatchResponse,
  type SyncPushCommandResult,
  type SyncPullResponse,
  type SyncEventItem,
  type RegisterHubInput,
  type HubRegistryItem,
  type DeadLetterCommandItem,
  type ConflictReviewItem,
  type SyncStatusOverview,
  type SyncCommandBatchItem,
} from '@restaurant-os/shared';
import { hasPermissionForCommand } from './sync/permissions.js';
import { computeOrderTotals, verifyTableBelongsToRestaurant } from './orders/pricing.js';
import { PaymentService } from './billing/PaymentService.js';

export class SyncEngineService {
  /**
   * Process an ordered batch of commands pushed by a client device or Local Hub.
   * Enforces tenant verification from authenticated token, monotonicity, idempotency,
   * single-writer domain invariants, and conflict rules.
   */
  static async processPushBatch(
    restaurantId: string,
    input: SyncPushBatchInput,
    actor?: { userId?: string; permissions?: readonly string[] },
  ): Promise<SyncPushBatchResponse> {
    const { deviceId, batchId, commands } = input;
    const results: SyncPushCommandResult[] = [];
    let latestSeq = 0;

    // Track/update device in device registry
    await this.touchDevice(restaurantId, deviceId, 'waiter');

    for (const cmd of commands) {
      // Reject unknown types with a clear result without silently dead-lettering
      if (
        cmd.type !== 'order.create' &&
        cmd.type !== 'kot.status' &&
        cmd.type !== 'payment.record'
      ) {
        results.push({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          seq: 0,
          status: 'rejected',
          errorCode: 'UNKNOWN_COMMAND_TYPE',
          errorMessage: `Unknown command type: ${cmd.type}`,
          serverTimestamp: new Date().toISOString(),
        });
        continue;
      }

      // Permission check per command
      if (!hasPermissionForCommand(cmd.type, actor?.permissions)) {
        results.push({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          seq: 0,
          status: 'rejected',
          errorCode: 'FORBIDDEN',
          errorMessage: `Forbidden: Missing required permission for command ${cmd.type}`,
          serverTimestamp: new Date().toISOString(),
        });
        continue;
      }

      try {
        const outcome = await db.transaction(async (tx) => {
          // Serialize check-and-apply via transaction advisory lock
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${restaurantId}:${cmd.idempotencyKey}`}, 0))`,
          );

          const [existing] = await tx
            .select()
            .from(syncEvents)
            .where(
              and(
                eq(syncEvents.restaurantId, restaurantId),
                eq(syncEvents.idempotencyKey, cmd.idempotencyKey),
              ),
            )
            .limit(1);

          if (existing) {
            return {
              duplicate: true as const,
              event: existing,
              status: 'duplicate' as const,
              resultPayload: (existing.payload as Record<string, unknown>) || undefined,
            };
          }

          const { status, resultPayload } = await this.executeDomainCommand(
            tx,
            restaurantId,
            deviceId,
            cmd,
            actor,
          );

          const [insertedEvent] = await tx
            .insert(syncEvents)
            .values({
              restaurantId,
              deviceId,
              commandId: cmd.id,
              idempotencyKey: cmd.idempotencyKey,
              type: cmd.type,
              payload: resultPayload || (cmd.payload as Record<string, unknown>),
              claimedAt: cmd.claimedAt ? new Date(cmd.claimedAt) : null,
            })
            .returning();

          if (!insertedEvent) throw AppError.internal('Failed to persist sync event');

          await tx
            .insert(syncCommands)
            .values({
              restaurantId,
              idempotencyKey: cmd.idempotencyKey,
              commandType: cmd.type,
              result: resultPayload || (cmd.payload as Record<string, unknown>),
            })
            .onConflictDoNothing();

          return {
            duplicate: false as const,
            event: insertedEvent,
            status,
            resultPayload,
          };
        });

        if (outcome.duplicate) {
          results.push({
            commandId: cmd.id,
            idempotencyKey: cmd.idempotencyKey,
            seq: outcome.event.seq,
            status: 'duplicate',
            serverTimestamp: outcome.event.serverTimestamp.toISOString(),
            resultPayload: outcome.resultPayload,
          });
          latestSeq = Math.max(latestSeq, outcome.event.seq);
          continue;
        }

        const seq = outcome.event.seq;
        latestSeq = Math.max(latestSeq, seq);

        // Broadcast event to realtime rooms
        emitRealtimeEvent(
          restaurantId,
          'sync:event',
          {
            seq,
            type: cmd.type,
            payload: outcome.resultPayload || (cmd.payload as Record<string, unknown>),
            deviceId,
          },
          'all',
        );

        results.push({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          seq,
          status: outcome.status,
          serverTimestamp: outcome.event.serverTimestamp.toISOString(),
          resultPayload: outcome.resultPayload,
        });
      } catch (err: unknown) {
        const isAppError = err instanceof AppError;
        const isZodError = err instanceof z.ZodError;
        const errorCode = isAppError
          ? err.code
          : isZodError
            ? 'VALIDATION_ERROR'
            : 'INTERNAL_ERROR';
        const errorMessage = isAppError
          ? err.message
          : isZodError
            ? 'Invalid command payload format or value'
            : 'Command execution failed';

        if (!isAppError && !isZodError) {
          console.error('[SyncEngine] Unexpected command execution error:', {
            restaurantId,
            commandId: cmd.id,
            type: cmd.type,
            error: err,
          });
        }

        // Poison command or unexpected failure: record in dead letter queue
        await db
          .insert(deadLetterCommands)
          .values({
            restaurantId,
            commandId: cmd.id,
            idempotencyKey: cmd.idempotencyKey,
            deviceId,
            type: cmd.type,
            payload: (cmd.payload as Record<string, unknown>) || {},
            errorMessage: `[${errorCode}] ${errorMessage}`,
            attempts: 1,
            status: 'dead_letter',
          })
          .onConflictDoNothing();

        results.push({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          seq: 0,
          status: 'rejected',
          errorCode,
          errorMessage,
          serverTimestamp: new Date().toISOString(),
        });
      }
    }

    return {
      success: true,
      batchId,
      lastSeq: latestSeq,
      results,
    };
  }

  /**
   * Domain command execution with exact conflict rules:
   * - Order line additions commutative; server recalculates pricing, verifying itemIds and tableId
   * - Two devices open order on same table: both preserved, 2nd flagged with collision review
   * - KOT status forward-only: new -> preparing -> ready -> served
   * - Duplicate payments routed to owner review queue
   */
  private static async executeDomainCommand(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    restaurantId: string,
    deviceId: string,
    cmd: SyncCommandBatchItem,
    actor?: { userId?: string; permissions?: readonly string[] },
  ): Promise<{ status: 'applied' | 'conflict'; resultPayload: Record<string, unknown> }> {
    const { type, payload: rawPayload } = cmd;

    switch (type) {
      case 'order.create': {
        const payload = orderCreateCommandPayloadSchema.parse(rawPayload);
        const orderId = payload.id;
        const tableId = payload.tableId;

        // Verify table belongs to caller's restaurant
        if (tableId) {
          await verifyTableBelongsToRestaurant(restaurantId, tableId, tx);
        }

        // Compute pricing server-side, verifying every itemId belongs to caller's restaurant and is active/available
        const itemsInput = (payload.items || []).map((item) => ({
          itemId: item.itemId,
          qty: item.qty,
          modifiers: (item.modifiers || []).map((m) => ({
            name: m.name,
            priceDeltaPaise: m.priceDeltaPaise,
          })),
          note: item.note,
        }));

        const pricing = await computeOrderTotals(restaurantId, itemsInput, tx);

        // Conflict check: Check if table already has an active open order
        if (tableId) {
          const [openOrderOnTable] = await tx
            .select()
            .from(orders)
            .where(
              and(
                eq(orders.restaurantId, restaurantId),
                eq(orders.tableId, tableId),
                eq(orders.status, 'open'),
              ),
            )
            .limit(1);

          if (openOrderOnTable && openOrderOnTable.id !== orderId) {
            // Table Collision Rule: Both orders preserved; flag conflict for owner/waiter review
            await tx.insert(conflictReviews).values({
              restaurantId,
              type: 'table_collision',
              referenceId: tableId,
              severity: 'warning',
              details: {
                existingOrderId: openOrderOnTable.id,
                collidingOrderId: orderId,
                deviceId,
                message:
                  'Two devices opened an order on the same table. Both orders are preserved.',
              },
            });

            // Insert new order with real server-computed totals
            await tx
              .insert(orders)
              .values({
                id: orderId,
                restaurantId,
                tableId,
                type: payload.type || 'dine_in',
                guests: payload.guests || 2,
                status: 'open',
                specialInstructions: `[Table collision notice] ${payload.specialInstructions || ''}`,
                subtotalPaise: pricing.subtotalPaise,
                taxPaise: pricing.taxPaise,
                totalPaise: pricing.totalPaise,
                version: 1,
              })
              .onConflictDoNothing();

            if (pricing.processedItems.length > 0) {
              const itemRows = pricing.processedItems.map((item) => ({
                orderId,
                itemId: item.itemId,
                nameSnapshot: item.nameSnapshot,
                pricePaiseSnapshot: item.pricePaiseSnapshot,
                taxRateBpSnapshot: item.taxRateBpSnapshot,
                qty: item.qty,
                modifiers: item.modifiers,
                note: item.note,
                lineNo: item.lineNo,
                kotState: 'unsent' as const,
              }));
              await tx.insert(orderItems).values(itemRows).onConflictDoNothing();
            }

            return {
              status: 'conflict',
              resultPayload: {
                orderId,
                collision: true,
                existingOrderId: openOrderOnTable.id,
                message:
                  'Table already has an open order. Second order preserved separately for split billing.',
              },
            };
          }
        }

        // Standard order creation with server-computed totals
        await tx
          .insert(orders)
          .values({
            id: orderId,
            restaurantId,
            tableId: payload.tableId || null,
            type: payload.type || 'dine_in',
            guests: payload.guests || 2,
            status: 'open',
            specialInstructions: payload.specialInstructions || null,
            subtotalPaise: pricing.subtotalPaise,
            taxPaise: pricing.taxPaise,
            totalPaise: pricing.totalPaise,
            version: 1,
          })
          .onConflictDoNothing();

        if (pricing.processedItems.length > 0) {
          const itemRows = pricing.processedItems.map((item) => ({
            orderId,
            itemId: item.itemId,
            nameSnapshot: item.nameSnapshot,
            pricePaiseSnapshot: item.pricePaiseSnapshot,
            taxRateBpSnapshot: item.taxRateBpSnapshot,
            qty: item.qty,
            modifiers: item.modifiers,
            note: item.note,
            lineNo: item.lineNo,
            kotState: 'unsent' as const,
          }));
          await tx.insert(orderItems).values(itemRows).onConflictDoNothing();
        }

        return { status: 'applied', resultPayload: { orderId, success: true } };
      }

      case 'kot.status': {
        const payload = kotStatusCommandPayloadSchema.parse(rawPayload);
        const { kotId, status: nextStatus } = payload;
        const [kot] = await tx
          .select()
          .from(kots)
          .where(and(eq(kots.id, kotId), eq(kots.restaurantId, restaurantId)))
          .limit(1);

        if (!kot) {
          throw AppError.notFound(`KOT ${kotId} not found`);
        }

        // Forward-only state machine rule: new (1) -> preparing (2) -> ready (3) -> served (4)
        const rank: Record<string, number> = { new: 1, preparing: 2, ready: 3, served: 4 };
        const currentRank = rank[kot.status] || 0;
        const newRank = rank[nextStatus] || 0;

        if (newRank < currentRank) {
          return {
            status: 'conflict',
            resultPayload: {
              kotId,
              ignored: true,
              currentStatus: kot.status,
              attemptedStatus: nextStatus,
              message: `Stale backward KOT status update ignored (current: ${kot.status}, attempted: ${nextStatus}).`,
            },
          };
        }

        await tx.update(kots).set({ status: nextStatus }).where(eq(kots.id, kotId));

        return { status: 'applied', resultPayload: { kotId, status: nextStatus } };
      }

      case 'payment.record': {
        const payload = paymentRecordCommandPayloadSchema.parse(rawPayload);
        const paymentResult = await PaymentService.recordPayment(tx, {
          restaurantId,
          billId: payload.billId,
          amountPaise: payload.amountPaise,
          tenderedPaise: payload.tenderedPaise,
          method: payload.method,
          reference: payload.reference,
          userId: actor?.userId,
          deviceId,
          flagConflictOnOverpayment: true,
        });

        return {
          status: paymentResult.status,
          resultPayload: (paymentResult.result as Record<string, unknown>) || {
            billId: payload.billId,
            status: paymentResult.status,
          },
        };
      }

      default:
        throw AppError.badRequest(`Unknown command type: ${type}`);
    }
  }

  /**
   * Pull replication event log since a specific sequence number.
   * Hub pulls configuration or client pulls operational events.
   */
  static async pullEvents(
    restaurantId: string,
    sinceSeq: number,
    limit: number = 100,
  ): Promise<SyncPullResponse> {
    const rows = await db
      .select()
      .from(syncEvents)
      .where(and(eq(syncEvents.restaurantId, restaurantId), gt(syncEvents.seq, sinceSeq)))
      .orderBy(asc(syncEvents.seq))
      .limit(limit);

    const events: SyncEventItem[] = rows.map((r) => ({
      seq: r.seq,
      restaurantId: r.restaurantId,
      deviceId: r.deviceId,
      commandId: r.commandId,
      idempotencyKey: r.idempotencyKey,
      type: r.type,
      payload: (r.payload as Record<string, unknown>) || {},
      serverTimestamp: r.serverTimestamp.toISOString(),
      appliedAt: r.appliedAt.toISOString(),
    }));

    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : sinceSeq;

    return {
      success: true,
      lastSeq,
      hasMore: events.length === limit,
      events,
    };
  }

  /**
   * Get sync status overview for restaurant owner.
   */
  static async getStatusOverview(restaurantId: string): Promise<SyncStatusOverview> {
    const [maxEvent] = await db
      .select({ maxSeq: sql<number>`coalesce(max(${syncEvents.seq}), 0)` })
      .from(syncEvents)
      .where(eq(syncEvents.restaurantId, restaurantId));

    const [hub] = await db
      .select()
      .from(hubRegistry)
      .where(and(eq(hubRegistry.restaurantId, restaurantId), eq(hubRegistry.isActive, true)))
      .limit(1);

    const [deadLetters] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deadLetterCommands)
      .where(
        and(
          eq(deadLetterCommands.restaurantId, restaurantId),
          eq(deadLetterCommands.status, 'dead_letter'),
        ),
      );

    const [conflicts] = await db
      .select({ count: sql<number>`count(*)` })
      .from(conflictReviews)
      .where(
        and(eq(conflictReviews.restaurantId, restaurantId), eq(conflictReviews.status, 'pending')),
      );

    const [deviceCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceRegistry)
      .where(eq(deviceRegistry.restaurantId, restaurantId));

    return {
      currentSeq: Number(maxEvent?.maxSeq || 0),
      activeHub: hub
        ? {
            id: hub.id,
            restaurantId: hub.restaurantId,
            deviceId: hub.deviceId,
            name: hub.name,
            hostAddress: hub.hostAddress,
            isActive: hub.isActive,
            lastHeartbeat: hub.lastHeartbeat.toISOString(),
            lastSyncedSeq: hub.lastSyncedSeq,
            createdAt: hub.createdAt.toISOString(),
            updatedAt: hub.updatedAt.toISOString(),
          }
        : null,
      pendingDeadLettersCount: Number(deadLetters?.count || 0),
      pendingConflictsCount: Number(conflicts?.count || 0),
      devicesCount: Number(deviceCount?.count || 0),
      isCloudWriter: !hub || !hub.isActive,
    };
  }

  /**
   * Register or update Local Hub for a restaurant.
   */
  static async registerHub(
    restaurantId: string,
    input: RegisterHubInput,
  ): Promise<HubRegistryItem> {
    const apiKeyHash = crypto.createHash('sha256').update(input.apiKey).digest('hex');

    const [hub] = await db
      .insert(hubRegistry)
      .values({
        restaurantId,
        deviceId: input.deviceId,
        name: input.name,
        hostAddress: input.hostAddress,
        apiKeyHash,
        isActive: true,
        lastHeartbeat: new Date(),
      })
      .onConflictDoUpdate({
        target: hubRegistry.restaurantId,
        set: {
          deviceId: input.deviceId,
          name: input.name,
          hostAddress: input.hostAddress,
          apiKeyHash,
          isActive: true,
          lastHeartbeat: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      id: hub!.id,
      restaurantId: hub!.restaurantId,
      deviceId: hub!.deviceId,
      name: hub!.name,
      hostAddress: hub!.hostAddress,
      isActive: hub!.isActive,
      lastHeartbeat: hub!.lastHeartbeat.toISOString(),
      lastSyncedSeq: hub!.lastSyncedSeq,
      createdAt: hub!.createdAt.toISOString(),
      updatedAt: hub!.updatedAt.toISOString(),
    };
  }

  /**
   * List dead letter poison commands.
   */
  static async listDeadLetters(restaurantId: string): Promise<DeadLetterCommandItem[]> {
    const rows = await db
      .select()
      .from(deadLetterCommands)
      .where(eq(deadLetterCommands.restaurantId, restaurantId))
      .orderBy(desc(deadLetterCommands.createdAt));

    return rows.map((r) => ({
      id: r.id,
      restaurantId: r.restaurantId,
      commandId: r.commandId,
      idempotencyKey: r.idempotencyKey,
      deviceId: r.deviceId,
      type: r.type,
      payload: (r.payload as Record<string, unknown>) || {},
      errorMessage: r.errorMessage,
      attempts: r.attempts,
      status: r.status as 'dead_letter' | 'replayed' | 'discarded',
      discardReason: r.discardReason,
      discardedBy: r.discardedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Discard a dead-letter command with an audited reason.
   */
  static async discardDeadLetter(
    restaurantId: string,
    deadLetterId: string,
    userId: string,
    reason: string,
  ): Promise<DeadLetterCommandItem> {
    const [row] = await db
      .select()
      .from(deadLetterCommands)
      .where(
        and(
          eq(deadLetterCommands.id, deadLetterId),
          eq(deadLetterCommands.restaurantId, restaurantId),
        ),
      )
      .limit(1);

    if (!row) {
      throw AppError.notFound('Dead letter command not found');
    }

    const [updated] = await db
      .update(deadLetterCommands)
      .set({
        status: 'discarded',
        discardReason: reason,
        discardedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(deadLetterCommands.id, deadLetterId))
      .returning();

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      commandId: updated!.commandId,
      idempotencyKey: updated!.idempotencyKey,
      deviceId: updated!.deviceId,
      type: updated!.type,
      payload: (updated!.payload as Record<string, unknown>) || {},
      errorMessage: updated!.errorMessage,
      attempts: updated!.attempts,
      status: updated!.status as 'dead_letter' | 'replayed' | 'discarded',
      discardReason: updated!.discardReason,
      discardedBy: updated!.discardedBy,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  /**
   * List conflict review items.
   */
  static async listConflicts(restaurantId: string): Promise<ConflictReviewItem[]> {
    const rows = await db
      .select()
      .from(conflictReviews)
      .where(eq(conflictReviews.restaurantId, restaurantId))
      .orderBy(desc(conflictReviews.createdAt));

    return rows.map((r) => ({
      id: r.id,
      restaurantId: r.restaurantId,
      type: r.type as ConflictReviewItem['type'],
      referenceId: r.referenceId,
      severity: r.severity as ConflictReviewItem['severity'],
      details: (r.details as Record<string, unknown>) || {},
      status: r.status as ConflictReviewItem['status'],
      resolvedBy: r.resolvedBy,
      resolutionNote: r.resolutionNote,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Resolve a conflict with resolution note.
   */
  static async resolveConflict(
    restaurantId: string,
    conflictId: string,
    userId: string,
    note: string,
  ): Promise<ConflictReviewItem> {
    const [row] = await db
      .select()
      .from(conflictReviews)
      .where(
        and(eq(conflictReviews.id, conflictId), eq(conflictReviews.restaurantId, restaurantId)),
      )
      .limit(1);

    if (!row) {
      throw AppError.notFound('Conflict review not found');
    }

    const [updated] = await db
      .update(conflictReviews)
      .set({
        status: 'resolved',
        resolutionNote: note,
        resolvedBy: userId,
        resolvedAt: new Date(),
      })
      .where(eq(conflictReviews.id, conflictId))
      .returning();

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      type: updated!.type as ConflictReviewItem['type'],
      referenceId: updated!.referenceId,
      severity: updated!.severity as ConflictReviewItem['severity'],
      details: (updated!.details as Record<string, unknown>) || {},
      status: updated!.status as ConflictReviewItem['status'],
      resolvedBy: updated!.resolvedBy,
      resolutionNote: updated!.resolutionNote,
      resolvedAt: updated!.resolvedAt ? updated!.resolvedAt.toISOString() : null,
      createdAt: updated!.createdAt.toISOString(),
    };
  }

  /**
   * Touch device registry for device heartbeat and presence.
   */
  static async touchDevice(
    restaurantId: string,
    deviceId: string,
    role: string = 'waiter',
  ): Promise<void> {
    await db
      .insert(deviceRegistry)
      .values({
        id: deviceId,
        restaurantId,
        name: `Device-${deviceId.slice(0, 6)}`,
        role,
        lastSeen: new Date(),
      })
      .onConflictDoUpdate({
        target: deviceRegistry.id,
        set: {
          lastSeen: new Date(),
        },
      });
  }
}
