import { eq, and } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AppError, Roles } from '@restaurant-os/shared';
import { db } from '../../db/client.js';
import type { DbOrTx } from '../../db/types.js';
import { bills, payments, refunds } from '../../db/schema/bills.js';
import { orders } from '../../db/schema/orders.js';
import { tables } from '../../db/schema/tables.js';
import { paymentRequests } from '../../db/schema/payment-requests.js';
import { recordAuditLog } from '../audit.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { verifyApproverPin } from '../../auth/approval.js';
import { processBillReversalLoyalty } from '../loyalty.js';
import { assertBusinessDateNotLocked } from './PaymentService.js';

export interface CancelBillParams {
  restaurantId: string;
  billId: string;
  userId: string;
  roleName: string;
  reason: string;
  approverUserId?: string;
  pin?: string;
  overridePin?: string;
  request?: FastifyRequest;
}

export interface RefundBillParams {
  restaurantId: string;
  billId: string;
  userId: string;
  amountPaise: number;
  method: 'cash' | 'upi' | 'card';
  reason: string;
  paymentId?: string;
  approverUserId?: string;
  pin?: string;
  overridePin?: string;
  request?: FastifyRequest;
}

export class RefundService {
  /**
   * Cancels an unpaid bill or cancels a paid bill with owner authorization.
   */
  static async cancelBill(params: CancelBillParams, executor: DbOrTx = db) {
    const { restaurantId, billId, userId, roleName, reason, approverUserId, pin, overridePin, request } = params;

    const result = await executor.transaction(async (tx) => {
      const billRows = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
        .for('update')
        .limit(1);

      const bill = billRows[0];
      if (!bill) throw AppError.notFound('Bill not found');

      await assertBusinessDateNotLocked(restaurantId, bill.businessDate, tx);

      if (bill.status === 'cancelled') {
        throw AppError.badRequest('Bill is already cancelled');
      }

      // If bill was already paid, requires OWNER role or approver PIN override
      if (bill.status === 'paid' && roleName !== Roles.OWNER) {
        const effectivePin = pin ?? overridePin;
        if (!approverUserId || !effectivePin) {
          throw AppError.forbidden(
            'Cancelling a paid bill requires Owner authorization or approver PIN override',
          );
        }
        await verifyApproverPin(tx, {
          restaurantId,
          approverUserId,
          pin: effectivePin,
          allowedRoles: [Roles.OWNER, Roles.MANAGER],
          reason,
          entity: 'bill',
          entityId: bill.id,
          actorUserId: userId,
          request,
        });
      }

      const [cancelledBill] = await tx
        .update(bills)
        .set({
          status: 'cancelled',
          updatedAt: new Date(),
        })
        .where(eq(bills.id, bill.id))
        .returning();

      // Invalidate all pending UPI QR payment requests for this bill
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

      // If order was billed, revert to saved
      await tx
        .update(orders)
        .set({ status: 'saved', updatedAt: new Date() })
        .where(eq(orders.id, bill.orderId));

      const order = (
        await tx.select().from(orders).where(eq(orders.id, bill.orderId)).limit(1)
      )[0];

      if (order?.tableId) {
        await tx
          .update(tables)
          .set({ status: 'occupied', updatedAt: new Date() })
          .where(eq(tables.id, order.tableId));
      }

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'bill.cancel',
        entity: 'bill',
        entityId: bill.id,
        before: bill,
        after: cancelledBill,
        request,
      });

      // Loyalty reversal hook
      await processBillReversalLoyalty(
        {
          restaurantId,
          billId: bill.id,
          reason,
          userId,
          request,
        },
        tx,
      );

      return cancelledBill;
    });

    emitRealtimeEvent(restaurantId, 'bill.cancelled', { billId }, 'floor');
    emitRealtimeEvent(restaurantId, 'bill.cancelled', { billId }, 'owner');

    return result;
  }

  /**
   * Records a refund on a paid or partially paid bill.
   */
  static async refundBill(params: RefundBillParams, executor: DbOrTx = db) {
    const { restaurantId, billId, userId, amountPaise, method, reason, paymentId, approverUserId, pin, overridePin, request } = params;

    const result = await executor.transaction(async (tx) => {
      const billRows = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
        .for('update')
        .limit(1);

      const bill = billRows[0];
      if (!bill) throw AppError.notFound('Bill not found');

      await assertBusinessDateNotLocked(restaurantId, bill.businessDate, tx);

      if (bill.status !== 'paid' && bill.status !== 'partially_paid') {
        throw AppError.badRequest(`Cannot issue refund for a bill with status "${bill.status}"`);
      }

      const allPayments = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.billId, billId), eq(payments.status, 'confirmed')));

      const totalConfirmedPaise = allPayments.reduce((sum, p) => sum + p.amountPaise, 0);

      const existingRefunds = await tx.select().from(refunds).where(eq(refunds.billId, billId));
      const totalRefundedPaise = existingRefunds.reduce((sum, r) => sum + r.amountPaise, 0);

      if (totalRefundedPaise + amountPaise > totalConfirmedPaise) {
        throw AppError.badRequest(
          `Total refunds (${totalRefundedPaise + amountPaise} paise) would exceed confirmed payments (${totalConfirmedPaise} paise)`,
        );
      }

      const effectivePin = pin ?? overridePin;
      if (approverUserId && effectivePin) {
        await verifyApproverPin(tx, {
          restaurantId,
          approverUserId,
          pin: effectivePin,
          allowedRoles: [Roles.OWNER, Roles.MANAGER],
          reason,
          entity: 'bill',
          entityId: billId,
          actorUserId: userId,
          request,
        });
      }

      const [refundRecord] = await tx
        .insert(refunds)
        .values({
          restaurantId,
          billId,
          paymentId,
          amountPaise,
          method,
          reason,
          approvedBy: userId,
        })
        .returning();

      if (!refundRecord) throw AppError.internal('Failed to record refund');

      const isFullyRefunded = totalRefundedPaise + amountPaise >= totalConfirmedPaise;
      let updatedBill = bill;

      if (isFullyRefunded) {
        const [updated] = await tx
          .update(bills)
          .set({ status: 'refunded', updatedAt: new Date() })
          .where(eq(bills.id, bill.id))
          .returning();
        if (updated) updatedBill = updated;
      }

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'bill.refund',
        entity: 'refund',
        entityId: refundRecord.id,
        after: refundRecord,
        request,
      });

      // Loyalty reversal hook on refund
      await processBillReversalLoyalty(
        {
          restaurantId,
          billId: bill.id,
          reason,
          userId,
          request,
        },
        tx,
      );

      return {
        refund: refundRecord,
        bill: updatedBill,
      };
    });

    emitRealtimeEvent(
      restaurantId,
      'bill.refunded',
      { billId, refundId: result.refund?.id },
      'floor',
    );
    emitRealtimeEvent(
      restaurantId,
      'bill.refunded',
      { billId, refundId: result.refund?.id },
      'owner',
    );

    return result;
  }
}
