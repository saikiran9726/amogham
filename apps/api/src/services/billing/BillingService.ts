import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  Permissions,
  AppError,
  Roles,
  type CreateBillInput,
  type ApplyDiscountInput,
  type BillFilterInput,
  type PrintEventInput,
  calculateBill,
  type BillingLineInput,
  type ReceiptData,
  buildReceiptEscPos,
  formatReceiptPlainText,
  generateUpiIntentUrl,
  generateUuidV7,
  getBusinessDate,
} from '@restaurant-os/shared';
import { db } from '../../db/client.js';
import type { DbOrTx } from '../../db/types.js';
import { bills, billLines, payments, refunds, billCounters } from '../../db/schema/bills.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { tables } from '../../db/schema/tables.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { restaurants } from '../../db/schema/restaurants.js';
import { users } from '../../db/schema/users.js';
import { printerConfigurations, printEvents } from '../../db/schema/printers.js';
import { paymentRequests } from '../../db/schema/payment-requests.js';
import { recordAuditLog } from '../audit.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { verifyApproverPin } from '../../auth/approval.js';
import { withIdempotency } from '../../http/idempotency.js';
import { assertBusinessDateNotLocked } from './PaymentService.js';
import { batchUpdateBillLines } from './LoyaltyRedemptionService.js';

export function inferStoredBillTaxMode(
  lines: Array<{
    taxRateBp: number;
    taxPaise: number;
    taxablePaise: number;
    subtotalPaise: number;
    discountPaise: number;
  }>,
): 'inclusive' | 'exclusive' | null {
  const taxedLine = lines.find((line) => line.taxRateBp > 0 && line.taxPaise > 0);
  if (!taxedLine) return null;
  return taxedLine.taxablePaise < taxedLine.subtotalPaise - taxedLine.discountPaise
    ? 'inclusive'
    : 'exclusive';
}

export async function assertBillReprintAuthorized(
  restaurantId: string,
  billStatus: string,
  isReprint: boolean,
  userPerms: string[],
  approverUserId: string | undefined,
  pin: string | undefined,
  actorUserId: string,
  billId: string,
  tx: DbOrTx,
  request?: FastifyRequest,
): Promise<void> {
  if (!isReprint || billStatus !== 'paid' || userPerms.includes(Permissions.BILL_REPRINT)) return;
  if (!pin || !approverUserId) {
    throw AppError.forbidden(
      'Reprinting a paid bill requires bill.reprint permission or approver PIN',
    );
  }
  await verifyApproverPin(tx, {
    restaurantId,
    approverUserId,
    pin,
    allowedRoles: [Roles.OWNER, Roles.MANAGER],
    reason: 'bill_reprint',
    entity: 'bill',
    entityId: billId,
    actorUserId,
    request,
  });
}

export function getRoleDiscountCap(
  roleName: string,
  settings: {
    discountCapOwnerPercent?: number | null;
    discountCapManagerPercent?: number | null;
    discountCapCashierPercent?: number | null;
  } | null | undefined,
): number {
  if (roleName === Roles.OWNER) return settings?.discountCapOwnerPercent ?? 100;
  if (roleName === Roles.MANAGER) return settings?.discountCapManagerPercent ?? 25;
  if (roleName === Roles.CASHIER) return settings?.discountCapCashierPercent ?? 10;
  return 0;
}

export interface CreateBillServiceParams {
  orderId: string;
  restaurantId: string;
  userId: string;
  roleName: string;
  body: CreateBillInput;
  idempotencyKey?: string;
  request?: FastifyRequest;
}

export class BillingService {
  /**
   * Generates or fetches an existing active bill for an order with idempotency.
   */
  static async createBill(params: CreateBillServiceParams, executor: DbOrTx = db) {
    const { orderId, restaurantId, userId, roleName, body, idempotencyKey, request } = params;

    const execution = await executor.transaction(async (tx) => {
      return withIdempotency(
        tx,
        {
          restaurantId,
          userId,
          commandType: 'bill.create',
          key: idempotencyKey,
          requestBody: request?.body,
        },
        async (tx) => {
          // 1. Fetch Order and items
          const orderResult = await tx
            .select()
            .from(orders)
            .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
            .for('update')
            .limit(1);

          const order = orderResult[0];
          if (!order) {
            throw AppError.notFound('Order not found');
          }

          // 2. Check if an active bill already exists for this order
          const existingBills = await tx
            .select()
            .from(bills)
            .where(
              and(
                eq(bills.orderId, orderId),
                eq(bills.restaurantId, restaurantId),
                inArray(bills.status, ['draft', 'unpaid', 'partially_paid', 'paid']),
              ),
            )
            .limit(1);

          if (existingBills.length > 0 && existingBills[0]) {
            const existingBill = existingBills[0];
            const lines = await tx
              .select()
              .from(billLines)
              .where(eq(billLines.billId, existingBill.id));
            const billPayments = await tx
              .select()
              .from(payments)
              .where(eq(payments.billId, existingBill.id));
            const billRefunds = await tx
              .select()
              .from(refunds)
              .where(eq(refunds.billId, existingBill.id));

            return {
              bill: existingBill,
              taxMode: inferStoredBillTaxMode(lines),
              order: { id: order.id, customerId: order.customerId },
              lines,
              payments: billPayments,
              refunds: billRefunds,
            };
          }

          // 3. Fetch active order items
          const items = await tx
            .select()
            .from(orderItems)
            .where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'active')));

          if (items.length === 0) {
            throw AppError.badRequest('Cannot generate bill for an order with no active items');
          }

          // 4. Fetch Restaurant Settings
          const settingsResult = await tx
            .select()
            .from(restaurantSettings)
            .where(eq(restaurantSettings.restaurantId, restaurantId))
            .limit(1);
          const settings = settingsResult[0];

          const taxMode = (settings?.taxMode as 'inclusive' | 'exclusive') || 'exclusive';
          const serviceChargePercent =
            body.serviceChargePercent ?? (Number(settings?.serviceChargePercent) || 0);
          const defaultGstRateBp = settings?.defaultGstRateBp ?? 500;
          const roundOffEnabled = body.roundOffEnabled ?? true;

          // 5. Validate discount cap & PIN override if discount specified
          if (body.discount && body.discount.value > 0) {
            const capPercent = getRoleDiscountCap(roleName, settings);
            let requestedPercent = 0;

            if (body.discount.type === 'percent') {
              requestedPercent = body.discount.value;
            } else {
              const rawSubtotal = items.reduce(
                (sum, item) => sum + item.qty * item.pricePaiseSnapshot,
                0,
              );
              requestedPercent = rawSubtotal > 0 ? (body.discount.value / rawSubtotal) * 100 : 0;
            }

            if (requestedPercent > capPercent) {
              const approverUserId = body.discount.approverUserId;
              const pin = body.discount.pin ?? body.discount.overridePin;
              if (!approverUserId || !pin) {
                throw AppError.forbidden(
                  `Discount exceeds your allowed role cap of ${capPercent}%. Approver PIN override is required.`,
                );
              }
              await verifyApproverPin(tx, {
                restaurantId,
                approverUserId,
                pin,
                allowedRoles: [Roles.OWNER, Roles.MANAGER],
                reason: body.discount.reason,
                entity: 'order',
                entityId: orderId,
                actorUserId: userId,
                request,
              });
            }
          }

          // 6. Compute Bill using billing engine
          const billingLines: BillingLineInput[] = items.map((item) => ({
            orderItemId: item.id,
            itemId: item.itemId,
            name: item.nameSnapshot,
            qty: item.qty,
            pricePaise: item.pricePaiseSnapshot,
            taxRateBp: item.taxRateBpSnapshot,
            modifiers: Array.isArray(item.modifiers)
              ? (item.modifiers as unknown as BillingLineInput['modifiers'])
              : [],
            note: item.note,
          }));

          const calculated = calculateBill({
            lines: billingLines,
            taxMode,
            discount: body.discount,
            serviceChargePercent,
            defaultGstRateBp,
            roundOffEnabled,
          });

          // 7. Allocate daily sequential bill number based on business date
          const todayStr = getBusinessDate(
            new Date(),
            settings?.businessDayStartHour ?? 5,
            settings?.timezone ?? 'Asia/Kolkata',
          );
          const counterRows = await tx
            .select()
            .from(billCounters)
            .where(
              and(eq(billCounters.restaurantId, restaurantId), eq(billCounters.date, todayStr)),
            )
            .for('update');

          let nextNum = 1;
          if (counterRows.length === 0 || !counterRows[0]) {
            await tx.insert(billCounters).values({
              restaurantId,
              date: todayStr,
              lastNumber: 1,
            });
          } else {
            nextNum = counterRows[0].lastNumber + 1;
            await tx
              .update(billCounters)
              .set({ lastNumber: nextNum })
              .where(
                and(eq(billCounters.restaurantId, restaurantId), eq(billCounters.date, todayStr)),
              );
          }

          const dateSlug = todayStr.replace(/-/g, '');
          const billNumber = `B-${dateSlug}-${String(nextNum).padStart(4, '0')}`;

          // 8. Insert Bill
          const [insertedBill] = await tx
            .insert(bills)
            .values({
              restaurantId,
              orderId,
              billNumber,
              businessDate: todayStr,
              subtotalPaise: calculated.subtotalPaise,
              discountPaise: calculated.discountPaise,
              discountType: calculated.discountType,
              discountValue: calculated.discountValue,
              discountReason: calculated.discountReason,
              serviceChargePaise: calculated.serviceChargePaise,
              taxPaise: calculated.taxPaise,
              roundOffPaise: calculated.roundOffPaise,
              totalPaise: calculated.totalPaise,
              taxMode,
              serviceChargePercent: String(serviceChargePercent),
              defaultGstRateBp,
              roundOffEnabled,
              status: 'unpaid',
              createdBy: userId,
            })
            .returning();

          if (!insertedBill) throw AppError.internal('Failed to create bill record');

          // 9. Insert Bill Lines snapshot
          const insertedLines = await tx
            .insert(billLines)
            .values(
              calculated.lines.map((l) => ({
                billId: insertedBill.id,
                orderItemId: l.orderItemId,
                itemId: l.itemId!,
                name: l.name,
                qty: l.qty,
                pricePaise: l.pricePaise,
                subtotalPaise: l.subtotalPaise,
                discountPaise: l.discountPaise,
                taxablePaise: l.taxablePaise,
                taxRateBp: l.taxRateBp,
                taxPaise: l.taxPaise,
                cgstPaise: l.cgstPaise,
                sgstPaise: l.sgstPaise,
                modifiers: (l.modifiers || []) as unknown as Record<string, unknown>[],
                note: l.note,
              })),
            )
            .returning();

          // 10. Update table status to 'payment_pending' if dine-in
          if (order.tableId) {
            await tx
              .update(tables)
              .set({ status: 'payment_pending', updatedAt: new Date() })
              .where(eq(tables.id, order.tableId));
          }

          // 11. Audit log
          await recordAuditLog({
            restaurantId,
            userId,
            action: 'bill.create',
            entity: 'bill',
            entityId: insertedBill.id,
            after: insertedBill,
            request,
          });

          return {
            bill: insertedBill,
            taxMode,
            order: { id: order.id, customerId: order.customerId },
            lines: insertedLines,
            payments: [],
            refunds: [],
          };
        },
      );
    });

    if (!execution.replayed) {
      emitRealtimeEvent(
        restaurantId,
        'bill.created',
        { billId: execution.result.bill.id, orderId },
        'floor',
      );
      emitRealtimeEvent(
        restaurantId,
        'bill.created',
        { billId: execution.result.bill.id, orderId },
        'owner',
      );
    }

    return execution;
  }

  /**
   * Fetches bill details, line snapshots, payment logs, and refunds.
   */
  static async getBillById(
    params: {
      restaurantId: string;
      billId: string;
      userId: string;
      request?: FastifyRequest;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId, userId, request } = params;

    let billRows: Array<typeof bills.$inferSelect> = [];
    try {
      billRows = await executor
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
        .limit(1);
    } catch (err: unknown) {
      request?.log.debug({ err }, 'Database error looking up bill, treating as not found');
    }

    const bill = billRows[0];
    if (!bill) {
      // Anti-IDOR security telemetry: check if entity exists under another tenant
      try {
        const [foreignBill] = await executor
          .select({ id: bills.id, restaurantId: bills.restaurantId })
          .from(bills)
          .where(eq(bills.id, billId))
          .limit(1);

        if (foreignBill) {
          await recordAuditLog({
            restaurantId,
            userId,
            action: 'security.cross_tenant_access_attempt',
            entity: 'bill',
            entityId: billId,
            before: { targetRestaurantId: foreignBill.restaurantId },
            request,
          });
          request?.log.warn(
            {
              billId,
              targetRestaurantId: foreignBill.restaurantId,
              callerRestaurantId: restaurantId,
            },
            'Cross-tenant bill access probe detected and neutralized',
          );
        }
      } catch (err: unknown) {
        request?.log.debug({ err }, 'Could not probe foreign tenant existence');
      }

      throw AppError.notFound('Bill not found');
    }

    const lines = await executor.select().from(billLines).where(eq(billLines.billId, billId));
    const billPayments = await executor.select().from(payments).where(eq(payments.billId, billId));
    const billRefunds = await executor.select().from(refunds).where(eq(refunds.billId, billId));

    const [order] = await executor
      .select({ id: orders.id, customerId: orders.customerId })
      .from(orders)
      .where(eq(orders.id, bill.orderId))
      .limit(1);

    return {
      bill,
      order: order || null,
      customerId: order?.customerId || null,
      lines,
      payments: billPayments,
      refunds: billRefunds,
    };
  }

  /**
   * Applies or updates discount on an unpaid bill.
   */
  static async applyDiscount(
    params: {
      restaurantId: string;
      billId: string;
      userId: string;
      roleName: string;
      body: ApplyDiscountInput;
      request?: FastifyRequest;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId, userId, roleName, body, request } = params;

    const updated = await executor.transaction(async (tx) => {
      const billRows = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
        .for('update')
        .limit(1);

      const bill = billRows[0];
      if (!bill) throw AppError.notFound('Bill not found');

      await assertBusinessDateNotLocked(restaurantId, bill.businessDate, tx);

      if (bill.status !== 'unpaid' && bill.status !== 'draft') {
        throw AppError.badRequest(
          `Cannot modify discount on a bill with status "${bill.status}"`,
        );
      }

      const existingPayments = await tx
        .select()
        .from(payments)
        .where(
          and(eq(payments.billId, billId), inArray(payments.status, ['confirmed', 'recorded'])),
        );

      if (existingPayments.length > 0) {
        throw AppError.badRequest('Cannot alter discount after payments have been recorded');
      }

      const settings = (
        await tx
          .select()
          .from(restaurantSettings)
          .where(eq(restaurantSettings.restaurantId, restaurantId))
          .limit(1)
      )[0];

      const capPercent = getRoleDiscountCap(roleName, settings);
      let requestedPercent = 0;
      if (body.type === 'percent') {
        requestedPercent = body.value;
      } else {
        requestedPercent = bill.subtotalPaise > 0 ? (body.value / bill.subtotalPaise) * 100 : 0;
      }

      if (requestedPercent > capPercent) {
        const approverUserId = body.approverUserId;
        const pin = body.pin ?? body.overridePin;
        if (!approverUserId || !pin) {
          throw AppError.forbidden(
            `Discount exceeds your allowed role cap of ${capPercent}%. Approver PIN override is required.`,
          );
        }
        await verifyApproverPin(tx, {
          restaurantId,
          approverUserId,
          pin,
          allowedRoles: [Roles.OWNER, Roles.MANAGER],
          reason: body.reason,
          entity: 'bill',
          entityId: bill.id,
          actorUserId: userId,
          request,
        });
      }

      const loyaltyDiscountPaise = bill.loyaltyDiscountPaise || 0;
      let manualDiscountPaise = 0;
      if (body.type === 'percent') {
        manualDiscountPaise = Math.round((bill.subtotalPaise * body.value) / 100);
      } else {
        manualDiscountPaise = body.value;
      }

      const totalCombinedDiscountPaise = manualDiscountPaise + loyaltyDiscountPaise;

      const lines = await tx.select().from(billLines).where(eq(billLines.billId, billId));
      const billingLines: BillingLineInput[] = lines.map((l) => ({
        orderItemId: l.orderItemId ?? undefined,
        itemId: l.itemId,
        name: l.name,
        qty: l.qty,
        pricePaise: l.pricePaise,
        taxRateBp: l.taxRateBp,
        modifiers: Array.isArray(l.modifiers)
          ? (l.modifiers as unknown as BillingLineInput['modifiers'])
          : [],
        note: l.note,
      }));

      const calculated = calculateBill({
        lines: billingLines,
        taxMode: (bill.taxMode as 'inclusive' | 'exclusive') || 'exclusive',
        discount: {
          type: 'flat',
          value: totalCombinedDiscountPaise,
          reason:
            loyaltyDiscountPaise > 0
              ? `${body.reason || 'Manual discount'} + Loyalty Redemption`
              : body.reason,
        },
        serviceChargePercent: Number(bill.serviceChargePercent) || 0,
        defaultGstRateBp: bill.defaultGstRateBp,
        roundOffEnabled: bill.roundOffEnabled,
      });

      const lineUpdates = calculated.lines
        .map((cl) => {
          const match = lines.find((l) => l.orderItemId === cl.orderItemId && l.name === cl.name);
          if (!match) return null;
          return {
            id: match.id,
            discountPaise: cl.discountPaise,
            taxablePaise: cl.taxablePaise,
            taxPaise: cl.taxPaise,
            cgstPaise: cl.cgstPaise,
            sgstPaise: cl.sgstPaise,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      await batchUpdateBillLines(tx, lineUpdates);

      const [updatedBill] = await tx
        .update(bills)
        .set({
          discountPaise: calculated.discountPaise,
          discountType: calculated.discountType,
          discountValue: calculated.discountValue,
          discountReason: calculated.discountReason,
          serviceChargePaise: calculated.serviceChargePaise,
          taxPaise: calculated.taxPaise,
          roundOffPaise: calculated.roundOffPaise,
          totalPaise: calculated.totalPaise,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, bill.id))
        .returning();

      if (!updatedBill) throw AppError.internal('Failed to update bill');

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'discount.apply',
        entity: 'bill',
        entityId: bill.id,
        before: bill,
        after: updatedBill,
        request,
      });

      await tx
        .update(paymentRequests)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(paymentRequests.billId, bill.id),
            eq(paymentRequests.restaurantId, restaurantId),
            eq(paymentRequests.status, 'pending'),
          ),
        );

      const refreshedLines = await tx
        .select()
        .from(billLines)
        .where(eq(billLines.billId, billId));

      return {
        bill: updatedBill,
        lines: refreshedLines,
      };
    });

    emitRealtimeEvent(restaurantId, 'bill.updated', { billId }, 'floor');
    emitRealtimeEvent(restaurantId, 'bill.updated', { billId }, 'owner');

    return updated;
  }

  /**
   * Lists bills with filters and keyset pagination.
   */
  static async listBills(
    params: {
      restaurantId: string;
      userId: string;
      roleName: string;
      query: BillFilterInput;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, userId, roleName, query } = params;

    const conditions = [eq(bills.restaurantId, restaurantId)];

    if (query.status) {
      conditions.push(eq(bills.status, query.status));
    }
    if (query.date) {
      conditions.push(eq(bills.businessDate, query.date));
    }
    if (query.tableId) {
      conditions.push(
        sql`${bills.orderId} IN (SELECT id FROM orders WHERE table_id = ${query.tableId}::uuid)`,
      );
    }
    if (query.search) {
      const escaped = query.search.replace(/([%_\\])/g, '\\$1');
      conditions.push(sql`${bills.billNumber} ILIKE ${'%' + escaped + '%'}`);
    }

    if (roleName === Roles.WAITER) {
      conditions.push(eq(bills.createdBy, userId));
    }

    if (query.cursorCreatedAt && query.cursorId) {
      conditions.push(
        sql`(${bills.createdAt}, ${bills.id}) < (${query.cursorCreatedAt}::timestamptz, ${query.cursorId}::uuid)`,
      );
    }

    const queryBuilder = executor
      .select()
      .from(bills)
      .where(and(...conditions))
      .orderBy(desc(bills.createdAt), desc(bills.id))
      .limit(query.limit);

    const results =
      query.cursorCreatedAt && query.cursorId
        ? await queryBuilder
        : await queryBuilder.offset(query.offset);

    const lastBill = results.length === query.limit ? results[results.length - 1] : null;
    const nextCursor = lastBill
      ? {
          cursorCreatedAt: lastBill.createdAt.toISOString(),
          cursorId: lastBill.id,
        }
      : null;

    return {
      bills: results,
      limit: query.limit,
      offset: query.offset,
      nextCursor,
    };
  }

  /**
   * Pre-authorizes a bill reprint.
   */
  static async reprintBill(
    params: {
      restaurantId: string;
      billId: string;
      userId: string;
      permissions: string[];
      approverUserId?: string;
      pin?: string;
      ownerPin?: string;
      request?: FastifyRequest;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId, userId, permissions: userPerms, approverUserId, pin, ownerPin, request } = params;

    const [bill] = await executor
      .select({ id: bills.id, status: bills.status, printedCount: bills.printedCount })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .limit(1);

    if (!bill) throw AppError.notFound('Bill not found');

    await assertBillReprintAuthorized(
      restaurantId,
      bill.status,
      bill.printedCount > 0,
      userPerms,
      approverUserId,
      pin ?? ownerPin,
      userId,
      billId,
      executor,
      request,
    );

    return {
      billId,
      authorized: true,
      printedCount: bill.printedCount,
    };
  }

  /**
   * Generates structured receipt data, monospace text, and ESC/POS byte sequence.
   */
  static async getReceipt(
    params: {
      restaurantId: string;
      billId: string;
      widthMm?: string;
      printerId?: string;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId, widthMm: queryWidth, printerId } = params;

    const [bill] = await executor
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .limit(1);

    if (!bill) throw AppError.notFound('Bill not found');

    const lines = await executor.select().from(billLines).where(eq(billLines.billId, billId));
    const billPayments = await executor.select().from(payments).where(eq(payments.billId, billId));
    const [order] = await executor.select().from(orders).where(eq(orders.id, bill.orderId)).limit(1);

    let tableName: string | undefined;
    if (order?.tableId) {
      const [table] = await executor.select().from(tables).where(eq(tables.id, order.tableId)).limit(1);
      tableName = table?.label;
    }

    let waiterName: string | undefined;
    if (order?.createdBy) {
      const [waiter] = await executor
        .select()
        .from(users)
        .where(eq(users.id, order.createdBy))
        .limit(1);
      waiterName = waiter?.name;
    }

    const [settings] = await executor
      .select()
      .from(restaurantSettings)
      .where(eq(restaurantSettings.restaurantId, restaurantId))
      .limit(1);

    const [restaurant] = await executor
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))
      .limit(1);

    const confirmedPaid = billPayments
      .filter((p) => p.status === 'confirmed')
      .reduce((acc, p) => acc + p.amountPaise, 0);

    const balanceDuePaise = Math.max(0, bill.totalPaise - confirmedPaid);

    let upiQrPayload: string | undefined;
    if (balanceDuePaise > 0 && settings?.upiVpa) {
      try {
        upiQrPayload = generateUpiIntentUrl({
          vpa: settings.upiVpa,
          payeeName: settings.upiPayeeName || settings.name || restaurant?.name || 'Restaurant OS',
          amountPaise: balanceDuePaise,
          billNumber: bill.billNumber,
          transactionRef: bill.id.replace(/-/g, '').slice(0, 16),
        });
      } catch {
        // Ignore invalid VPA
      }
    }

    const receiptData: ReceiptData = {
      restaurantName: settings?.name || restaurant?.name || 'Restaurant OS',
      restaurantAddress: settings?.address || undefined,
      restaurantPhone: settings?.phone || undefined,
      restaurantGstin: settings?.gstin || undefined,
      billNumber: bill.billNumber,
      orderType: (order?.type as 'dine_in' | 'takeaway') || 'dine_in',
      tableName,
      waiterName,
      date: bill.createdAt,
      lines: lines.map((l) => ({
        name: l.name,
        qty: l.qty,
        pricePaise: l.pricePaise,
        totalPaise: l.subtotalPaise,
        modifiers: Array.isArray(l.modifiers)
          ? (l.modifiers as Array<{ name?: string } | string>).map((m) =>
              typeof m === 'object' && m && 'name' in m ? String(m.name) : String(m),
            )
          : [],
        note: l.note || undefined,
      })),
      subtotalPaise: bill.subtotalPaise,
      discountPaise: bill.discountPaise,
      discountReason: bill.discountReason || undefined,
      serviceChargePaise: bill.serviceChargePaise,
      cgstPaise: lines.reduce((acc, l) => acc + l.cgstPaise, 0),
      sgstPaise: lines.reduce((acc, l) => acc + l.sgstPaise, 0),
      roundOffPaise: bill.roundOffPaise,
      totalPaise: bill.totalPaise,
      paidPaise: confirmedPaid,
      balanceDuePaise,
      payments: billPayments.map((p) => ({
        method: p.method,
        amountPaise: p.amountPaise,
        status: p.status,
      })),
      isDuplicate: bill.printedCount > 0,
      printedCount: bill.printedCount,
      upiQrPayload,
    };

    let targetWidth: 58 | 80 = 80;
    let targetCharsPerLine = 48;
    let autoCut = true;
    let drawerPulse = false;

    if (printerId) {
      const [printer] = await executor
        .select()
        .from(printerConfigurations)
        .where(eq(printerConfigurations.id, printerId))
        .limit(1);
      if (printer) {
        targetWidth = printer.widthMm as 58 | 80;
        targetCharsPerLine = printer.charsPerLine;
        autoCut = printer.autoCut;
        drawerPulse = printer.drawerPulse;
      }
    } else if (queryWidth === '58') {
      targetWidth = 58;
      targetCharsPerLine = 32;
    }

    const templateConfig = {
      widthMm: targetWidth,
      charsPerLine: targetCharsPerLine,
      autoCut,
      drawerPulse,
      headerLines: settings?.receiptHeaderLines || [],
      footerLines: settings?.receiptFooterLines || [],
      showGstin: settings?.receiptShowGstin ?? true,
      showTable: true,
      showWaiter: true,
      showItemNotes: settings?.receiptShowItemNotes ?? false,
      showServiceCharge: settings?.receiptShowServiceCharge ?? true,
      showQr: settings?.receiptShowQr ?? true,
      rupeeMode: (settings?.rupeeSymbolMode as 'text_rs' | 'symbol' | 'image') || 'text_rs',
    };

    const plainText = formatReceiptPlainText(receiptData, templateConfig);
    const escposBytes = buildReceiptEscPos(receiptData, templateConfig);
    const escposBase64 = Buffer.from(escposBytes).toString('base64');

    return {
      receiptData,
      templateConfig,
      plainText,
      escposBase64,
      byteCount: escposBytes.length,
    };
  }

  /**
   * Records a print attempt and increments bills.printed_count on success.
   */
  static async recordPrintEvent(
    params: {
      restaurantId: string;
      billId: string;
      userId: string;
      permissions: string[];
      body: PrintEventInput;
      request?: FastifyRequest;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId, userId, permissions: userPerms, body, request } = params;

    const [bill] = await executor
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .limit(1);

    if (!bill) throw AppError.notFound('Bill not found');

    const pin = body.pin ?? body.ownerPin;
    const approverUserId = body.approverUserId;

    if (body.type === 'reprint' || bill.printedCount > 0) {
      await assertBillReprintAuthorized(
        restaurantId,
        bill.status,
        true,
        userPerms,
        approverUserId,
        pin,
        userId,
        billId,
        executor,
        request,
      );
    }

    const { event, printedCount, duplicate } = await executor.transaction(async (tx) => {
      const [event] = await tx
        .insert(printEvents)
        .values({
          id: body.eventId || generateUuidV7(),
          restaurantId,
          billId,
          userId,
          type: body.type,
          printerId: body.printerId || null,
          result: body.result,
          error: body.error || null,
        })
        .onConflictDoNothing()
        .returning();

      if (!event) {
        const [existingEvent] = await tx
          .select()
          .from(printEvents)
          .where(
            and(
              eq(printEvents.id, body.eventId!),
              eq(printEvents.restaurantId, restaurantId),
              eq(printEvents.billId, billId),
            ),
          )
          .limit(1);
        if (!existingEvent) throw AppError.conflict('Print event identifier is already in use');
        if (
          existingEvent.type !== body.type ||
          existingEvent.result !== body.result ||
          existingEvent.printerId !== (body.printerId || null) ||
          existingEvent.error !== (body.error || null)
        ) {
          throw AppError.conflict('Print event identifier was reused with a different outcome');
        }
        return { event: existingEvent, printedCount: bill.printedCount, duplicate: true };
      }

      let printedCount = bill.printedCount;
      if (body.result === 'success') {
        const [updatedBill] = await tx
          .update(bills)
          .set({
            printedCount: sql`${bills.printedCount} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
          .returning({ printedCount: bills.printedCount });
        if (!updatedBill) throw AppError.notFound('Bill not found');
        printedCount = updatedBill.printedCount;
      }
      return { event, printedCount, duplicate: false };
    });

    if (!duplicate) {
      await recordAuditLog({
        restaurantId,
        userId,
        action: `bill.${body.type}`,
        entity: 'bill',
        entityId: billId,
        after: {
          eventId: event?.id,
          type: body.type,
          printerId: body.printerId,
          result: body.result,
          newPrintedCount: printedCount,
        },
        request,
      });
    }

    return {
      event,
      printedCount,
      duplicate,
    };
  }
}
