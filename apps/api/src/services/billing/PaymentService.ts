import { eq, and, sql, desc } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AppError, generateUuidV7, generateUpiIntentUrl } from '@restaurant-os/shared';
import { db } from '../../db/client.js';
import { bills, payments } from '../../db/schema/bills.js';
import { orders } from '../../db/schema/orders.js';
import { tables } from '../../db/schema/tables.js';
import { customers } from '../../db/schema/customers.js';
import { conflictReviews } from '../../db/schema/sync.js';
import { dailySummaries } from '../../db/schema/daily-summaries.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { paymentRequests } from '../../db/schema/payment-requests.js';
import { recordAuditLog } from '../audit.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { processBillPaidLoyaltyEarn } from '../loyalty.js';
import { withIdempotency } from '../../http/idempotency.js';
import { type DbOrTx, type Tx } from '../../db/types.js';
export type { DbOrTx, Tx };

export async function assertBusinessDateNotLocked(
  restaurantId: string,
  businessDate: string | null | undefined,
  tx: DbOrTx,
): Promise<void> {
  if (!businessDate) return;
  const [lockedDay] = await tx
    .select({ id: dailySummaries.id })
    .from(dailySummaries)
    .where(
      and(
        eq(dailySummaries.restaurantId, restaurantId),
        eq(dailySummaries.businessDate, businessDate),
        eq(dailySummaries.locked, true),
      ),
    )
    .limit(1);

  if (lockedDay) {
    throw AppError.badRequest(
      `Business date ${businessDate} is closed and locked. Modifying settled records requires day reopen with owner PIN.`,
    );
  }
}

export interface RecordPaymentParams {
  restaurantId: string;
  billId: string;
  amountPaise: number;
  tenderedPaise?: number;
  method: 'cash' | 'upi' | 'card';
  reference?: string;
  userId?: string;
  idempotencyKey?: string;
  request?: FastifyRequest;
  flagConflictOnOverpayment?: boolean;
  deviceId?: string;
}

export interface PaymentSuccessData {
  payment: typeof payments.$inferSelect;
  bill: typeof bills.$inferSelect;
  changePaise: number;
  isFullyPaid: boolean;
}

export interface RecordPaymentResult {
  duplicateReplay: boolean;
  status: 'applied' | 'conflict';
  payment?: typeof payments.$inferSelect;
  bill?: typeof bills.$inferSelect;
  changePaise?: number;
  isFullyPaid?: boolean;
  duplicateFlagged?: boolean;
  overpaymentFlagged?: boolean;
  remainingPaise?: number;
  message?: string;
  result?: unknown;
}

export class PaymentService {
  /**
   * Records a payment against a bill within a transaction.
   * Enforces business-date locks, non-cancelled/non-paid checks, remaining balance constraints,
   * cash change calculation, UPI pending confirmation rule, table auto-release, and audit logging.
   */
  static async recordPayment(
    tx: DbOrTx,
    params: RecordPaymentParams,
  ): Promise<RecordPaymentResult> {
    const { restaurantId, billId, amountPaise, tenderedPaise, method, reference, userId } = params;

    const exec = await withIdempotency(
      tx,
      {
        restaurantId,
        userId: params.userId,
        commandType: 'bill.payment',
        key: params.idempotencyKey,
        requestBody: params.request?.body ?? {
          billId,
          amountPaise,
          tenderedPaise,
          method,
          reference,
        },
      },
      async (tx) => {
        const billRows = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
          .for('update')
          .limit(1);

        const bill = billRows[0];
        if (!bill) throw AppError.notFound(`Bill ${billId} not found`);

        await assertBusinessDateNotLocked(restaurantId, bill.businessDate, tx);

        if (bill.status === 'cancelled') {
          throw AppError.badRequest('Cannot record payment on a cancelled bill');
        }

        if (bill.status === 'paid') {
          if (params.flagConflictOnOverpayment) {
            await tx.insert(conflictReviews).values({
              restaurantId,
              type: 'duplicate_payment',
              referenceId: billId,
              severity: 'critical',
              details: {
                billId,
                billNumber: bill.billNumber,
                extraAmountPaise: amountPaise,
                method,
                deviceId: params.deviceId,
                message: 'Payment received for already-paid bill. Routed to owner review queue.',
              },
            });

            const [flaggedPayment] = await tx
              .insert(payments)
              .values({
                billId,
                restaurantId,
                amountPaise,
                tenderedPaise: params.tenderedPaise ?? amountPaise,
                changePaise: 0,
                method,
                status: 'confirmed',
                reference: '[POSSIBLE DUPLICATE PAYMENT - ROUTED TO OWNER REVIEW]',
                businessDate: bill.businessDate || new Date().toISOString().split('T')[0]!,
                createdBy: userId,
              })
              .returning();

            const conflictData = {
              billId,
              duplicateFlagged: true,
              message:
                'Bill was already marked paid. Payment recorded and routed to owner conflict queue.',
            };

            return {
              duplicateReplay: false,
              status: 'conflict',
              duplicateFlagged: true,
              payment: flaggedPayment,
              message: conflictData.message,
              result: conflictData,
            };
          }
          throw AppError.badRequest('Bill is already fully paid');
        }

        // Calculate existing payments
        const existingPayments = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.billId, billId), eq(payments.restaurantId, restaurantId)));

        const confirmedPaise = existingPayments
          .filter((p) => p.status === 'confirmed' || p.status === 'recorded')
          .reduce((sum, p) => sum + p.amountPaise, 0);

        const pendingPaise = existingPayments
          .filter((p) => p.status === 'pending_confirmation')
          .reduce((sum, p) => sum + p.amountPaise, 0);

        const remainingPaise = Math.max(0, bill.totalPaise - confirmedPaise - pendingPaise);

        if (amountPaise > remainingPaise) {
          if (params.flagConflictOnOverpayment) {
            await tx.insert(conflictReviews).values({
              restaurantId,
              type: 'duplicate_payment',
              referenceId: billId,
              severity: 'critical',
              details: {
                billId,
                billNumber: bill.billNumber,
                requestedAmountPaise: amountPaise,
                remainingPaise,
                method,
                deviceId: params.deviceId,
                message: 'Payment exceeds the remaining bill balance and requires owner review.',
              },
            });

            const conflictData = {
              billId,
              overpaymentFlagged: true,
              remainingPaise,
              message: 'Payment exceeds the remaining balance and was routed to owner review.',
            };

            return {
              duplicateReplay: false,
              status: 'conflict',
              overpaymentFlagged: true,
              remainingPaise,
              message: conflictData.message,
              result: conflictData,
            };
          }
          throw AppError.badRequest(
            `Payment amount (${amountPaise} paise) exceeds remaining balance of ${remainingPaise} paise`,
          );
        }

        // Cash change calculation
        let changePaise = 0;
        const tenderedPaise = params.tenderedPaise ?? amountPaise;
        if (method === 'cash') {
          if (tenderedPaise < amountPaise) {
            throw AppError.badRequest('Cash tendered amount cannot be less than payment amount');
          }
          changePaise = tenderedPaise - amountPaise;
        }

        // Status rule: UPI starts as pending_confirmation until staff confirms receipt; Cash & Card confirmed immediately
        const initialStatus = method === 'upi' ? 'pending_confirmation' : 'confirmed';

        const [paymentRecord] = await tx
          .insert(payments)
          .values({
            restaurantId,
            billId,
            method,
            amountPaise,
            tenderedPaise,
            changePaise,
            status: initialStatus,
            reference: params.reference,
            businessDate: bill.businessDate,
            confirmedBy: initialStatus === 'confirmed' ? userId : null,
            confirmedAt: initialStatus === 'confirmed' ? new Date() : null,
            createdBy: userId,
          })
          .returning();

        if (!paymentRecord) throw AppError.internal('Failed to record payment');

        // Calculate updated confirmed total
        const newConfirmedTotal =
          confirmedPaise + (initialStatus === 'confirmed' ? amountPaise : 0);

        let newBillStatus = bill.status;
        let isFullyPaid = false;

        if (newConfirmedTotal >= bill.totalPaise) {
          newBillStatus = 'paid';
          isFullyPaid = true;
        } else if (newConfirmedTotal > 0) {
          newBillStatus = 'partially_paid';
        }

        const [updatedBill] = await tx
          .update(bills)
          .set({
            status: newBillStatus,
            paidAt: isFullyPaid ? new Date() : bill.paidAt,
            updatedAt: new Date(),
          })
          .where(eq(bills.id, bill.id))
          .returning();

        // If fully paid, transition order and release table
        if (isFullyPaid) {
          await tx
            .update(orders)
            .set({ status: 'billed', updatedAt: new Date() })
            .where(eq(orders.id, bill.orderId));

          const [order] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, bill.orderId))
            .limit(1);

          if (order?.customerId) {
            await tx
              .update(customers)
              .set({
                lastVisitAt: new Date(),
                visitCount: sql`${customers.visitCount} + 1`,
                totalSpentPaise: sql`${customers.totalSpentPaise} + ${bill.totalPaise}`,
                updatedAt: new Date(),
              })
              .where(eq(customers.id, order.customerId));

            // Award loyalty earn points on fully paid bill
            await processBillPaidLoyaltyEarn(
              {
                restaurantId,
                billId: bill.id,
                userId,
                request: params.request,
              },
              tx,
            );
          }

          if (order?.tableId) {
            await tx
              .update(tables)
              .set({
                status: 'available',
                currentOrderId: null,
                updatedAt: new Date(),
              })
              .where(and(eq(tables.id, order.tableId), eq(tables.currentOrderId, order.id)));
          }
        }

        await recordAuditLog({
          restaurantId,
          userId,
          action: 'payment.record',
          entity: 'payment',
          entityId: paymentRecord.id,
          after: paymentRecord,
          request: params.request,
          tx,
        });

        const responseData = {
          payment: paymentRecord,
          bill: updatedBill,
          changePaise,
          isFullyPaid,
        };

        return {
          duplicateReplay: false,
          status: 'applied' as const,
          payment: paymentRecord,
          bill: updatedBill,
          changePaise,
          isFullyPaid,
          result: responseData,
        };
      },
    );

    if (exec.replayed) {
      const stored = exec.result as Record<string, unknown>;
      return {
        duplicateReplay: true,
        status: 'applied' as const,
        result: (stored.result ?? stored) as Record<string, unknown>,
      };
    }

    const payload = (exec.result as Record<string, unknown>) ?? {};
    const successResult = (payload.result ?? payload) as Record<string, unknown>;

    return {
      duplicateReplay: false,
      status: (payload.status as 'applied' | 'conflict') ?? 'applied',
      payment: (payload.payment as typeof payments.$inferSelect) ?? exec.payment,
      bill: (payload.bill as typeof bills.$inferSelect) ?? exec.bill,
      changePaise: (payload.changePaise as number) ?? exec.changePaise,
      isFullyPaid: (payload.isFullyPaid as boolean) ?? exec.isFullyPaid,
      duplicateFlagged: payload.duplicateFlagged as boolean | undefined,
      overpaymentFlagged: payload.overpaymentFlagged as boolean | undefined,
      remainingPaise: payload.remainingPaise as number | undefined,
      message: payload.message as string | undefined,
      result: successResult,
    };
  }

  /**
   * Confirms a pending payment.
   */
  static async confirmPayment(
    params: {
      restaurantId: string;
      paymentId: string;
      userId: string;
      request?: FastifyRequest;
    },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, paymentId, userId, request } = params;

    const result = await executor.transaction(async (tx) => {
      const [paymentReference] = await tx
        .select({ billId: payments.billId })
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
        .limit(1);

      if (!paymentReference) throw AppError.notFound('Payment record not found');

      const [bill] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, paymentReference.billId), eq(bills.restaurantId, restaurantId)))
        .for('update')
        .limit(1);

      if (!bill) throw AppError.notFound('Bill not found');

      const paymentRows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.restaurantId, restaurantId)))
        .for('update')
        .limit(1);

      const payment = paymentRows[0];
      if (!payment) throw AppError.notFound('Payment record not found');

      if (payment.status === 'confirmed') {
        return {
          payment,
          bill,
          alreadyConfirmed: true,
          isFullyPaid: bill.status === 'paid',
        };
      }
      if (payment.status !== 'pending_confirmation') {
        throw AppError.badRequest(`Cannot confirm payment with status "${payment.status}"`);
      }
      if (bill.status === 'cancelled' || bill.status === 'paid') {
        throw AppError.conflict('The bill is no longer accepting payment confirmation');
      }

      const [confirmedPayment] = await tx
        .update(payments)
        .set({
          status: 'confirmed',
          confirmedBy: userId,
          confirmedAt: new Date(),
        })
        .where(eq(payments.id, payment.id))
        .returning();

      // Recompute bill payments
      const allPayments = await tx
        .select()
        .from(payments)
        .where(eq(payments.billId, payment.billId));

      const confirmedPaise = allPayments
        .filter((p) => p.status === 'confirmed' || p.status === 'recorded')
        .reduce((sum, p) => sum + p.amountPaise, 0);

      const isFullyPaid = confirmedPaise >= bill.totalPaise;
      const newStatus = isFullyPaid
        ? 'paid'
        : confirmedPaise > 0
          ? 'partially_paid'
          : bill.status;

      const [updatedBill] = await tx
        .update(bills)
        .set({
          status: newStatus,
          paidAt: isFullyPaid ? new Date() : bill.paidAt,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, bill.id))
        .returning();

      if (isFullyPaid) {
        await tx
          .update(orders)
          .set({ status: 'billed', updatedAt: new Date() })
          .where(eq(orders.id, bill.orderId));

        const order = (
          await tx.select().from(orders).where(eq(orders.id, bill.orderId)).limit(1)
        )[0];

        if (order?.customerId) {
          await tx
            .update(customers)
            .set({
              lastVisitAt: new Date(),
              visitCount: sql`${customers.visitCount} + 1`,
              totalSpentPaise: sql`${customers.totalSpentPaise} + ${bill.totalPaise}`,
              updatedAt: new Date(),
            })
            .where(eq(customers.id, order.customerId));

          // Award loyalty earn points on fully paid bill
          await processBillPaidLoyaltyEarn(
            {
              restaurantId,
              billId: bill.id,
              userId,
              request,
            },
            tx,
          );
        }

        if (order?.tableId) {
          await tx
            .update(tables)
            .set({
              status: 'available',
              currentOrderId: null,
              updatedAt: new Date(),
            })
            .where(and(eq(tables.id, order.tableId), eq(tables.currentOrderId, order.id)));
        }
      }

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'payment.confirm',
        entity: 'payment',
        entityId: payment.id,
        before: payment,
        after: confirmedPayment,
        request,
      });

      return {
        payment: confirmedPayment,
        bill: updatedBill,
        isFullyPaid,
      };
    });

    emitRealtimeEvent(restaurantId, 'payment.confirmed', { paymentId }, 'floor');
    emitRealtimeEvent(restaurantId, 'payment.confirmed', { paymentId }, 'owner');

    return result;
  }

  /**
   * Lists pending payments for an owner/manager.
   */
  static async getPendingPayments(restaurantId: string, executor: DbOrTx = db) {
    const pending = await executor
      .select({
        payment: payments,
        bill: bills,
      })
      .from(payments)
      .innerJoin(bills, eq(payments.billId, bills.id))
      .where(
        and(eq(payments.restaurantId, restaurantId), eq(payments.status, 'pending_confirmation')),
      )
      .orderBy(desc(payments.createdAt));

    return pending.map((p) => ({
      ...p.payment,
      billNumber: p.bill.billNumber,
      billTotalPaise: p.bill.totalPaise,
    }));
  }

  /**
   * Lists payment requests for a bill.
   */
  static async getPaymentRequests(restaurantId: string, billId: string, executor: DbOrTx = db) {
    const [bill] = await executor
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .limit(1);

    if (!bill) {
      throw AppError.notFound('Bill not found');
    }

    return executor
      .select()
      .from(paymentRequests)
      .where(
        and(eq(paymentRequests.billId, billId), eq(paymentRequests.restaurantId, restaurantId)),
      )
      .orderBy(desc(paymentRequests.createdAt));
  }

  /**
   * Generates a dynamic UPI QR payment request.
   */
  static async createPaymentRequest(
    params: { restaurantId: string; billId: string },
    executor: DbOrTx = db,
  ) {
    const { restaurantId, billId } = params;

    const [bill] = await executor
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .limit(1);

    if (!bill) throw AppError.notFound('Bill not found');

    const [settings] = await executor
      .select()
      .from(restaurantSettings)
      .where(eq(restaurantSettings.restaurantId, restaurantId))
      .limit(1);

    if (!settings?.upiVpa) {
      throw AppError.badRequest('UPI VPA not configured for this restaurant');
    }

    const billPayments = await executor
      .select()
      .from(payments)
      .where(eq(payments.billId, billId));

    const confirmedPaid = billPayments
      .filter((p) => p.status === 'confirmed')
      .reduce((acc, p) => acc + p.amountPaise, 0);

    const duePaise = Math.max(0, bill.totalPaise - confirmedPaid);
    if (duePaise === 0) {
      throw AppError.badRequest('Bill is already paid in full');
    }

    const upiRef = `UPI${bill.billNumber.replace(/[^A-Za-z0-9]/g, '')}${Date.now().toString().slice(-4)}`;
    const qrPayload = generateUpiIntentUrl({
      vpa: settings.upiVpa,
      payeeName: settings.upiPayeeName || settings.name || 'Restaurant OS',
      amountPaise: duePaise,
      billNumber: bill.billNumber,
      transactionRef: upiRef,
    });

    // Invalidate any older pending payment requests for this bill
    await executor
      .update(paymentRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(paymentRequests.billId, billId),
          eq(paymentRequests.restaurantId, restaurantId),
          eq(paymentRequests.status, 'pending'),
        ),
      );

    const [created] = await executor
      .insert(paymentRequests)
      .values({
        id: generateUuidV7(),
        restaurantId,
        billId,
        amountPaise: duePaise,
        upiRef,
        qrPayload,
        status: 'pending',
      })
      .returning();

    return created;
  }
}
