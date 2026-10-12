import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Permissions,
  RecordPaymentSchema,
} from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { extractIdempotencyKey } from '../../http/idempotency.js';
import { PaymentService } from '../../services/billing/PaymentService.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { forTenant } from '../../db/tenant.js';

export async function paymentRoutes(fastify: FastifyInstance) {
  /**
   * POST /bills/:id/payments
   * Records a payment against a bill (cash, UPI, card, or split payment line).
   */
  fastify.post(
    '/bills/:id/payments',
    { preHandler: [requirePermission(Permissions.PAYMENT_TAKE)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;

      const body = RecordPaymentSchema.parse(request.body);
      const idempotencyKey = extractIdempotencyKey(request, body);

      const tenant = forTenant(restaurantId);
      const result = await tenant.withTx(async (_t, tx) => {
        return PaymentService.recordPayment(tx, {
          restaurantId,
          billId,
          amountPaise: body.amountPaise,
          tenderedPaise: body.tenderedPaise,
          method: body.method,
          reference: body.reference,
          userId,
          idempotencyKey,
          request,
          flagConflictOnOverpayment: false,
        });
      });

      if (result.duplicateReplay) {
        return reply.status(200).send(result.result);
      }
      const payment = result.payment!;

      emitRealtimeEvent(
        restaurantId,
        'payment.recorded',
        { billId, paymentId: payment.id },
        'floor',
      );
      emitRealtimeEvent(
        restaurantId,
        'payment.recorded',
        { billId, paymentId: payment.id },
        'owner',
      );
      if (result.isFullyPaid) {
        emitRealtimeEvent(restaurantId, 'bill.paid', { billId }, 'floor');
        emitRealtimeEvent(restaurantId, 'bill.paid', { billId }, 'owner');
      }

      return reply.status(201).send(result.result);
    },
  );

  /**
   * POST /payments/:id/confirm
   * Staff explicitly confirms a pending UPI payment.
   */
  fastify.post(
    '/payments/:id/confirm',
    { preHandler: [requirePermission(Permissions.PAYMENT_TAKE)] },
    async (request: FastifyRequest, reply) => {
      const { id: paymentId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;

      const tenant = forTenant(restaurantId);
      const result = await PaymentService.confirmPayment(
        {
          restaurantId,
          paymentId,
          userId,
          request,
        },
        tenant.db,
      );

      return reply.send(result);
    },
  );

  /**
   * GET /payments/pending
   * Owner/Manager view of pending UPI confirmations.
   */
  fastify.get(
    '/payments/pending',
    { preHandler: [requirePermission(Permissions.PAYMENT_TAKE)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const { restaurantId } = authUser;

      const tenant = forTenant(restaurantId);
      const pendingPayments = await PaymentService.getPendingPayments(restaurantId, tenant.db);

      return reply.send({ pendingPayments });
    },
  );

  /**
   * GET /bills/:id/payment-requests
   * Lists dynamic UPI QR payment requests for this bill.
   */
  fastify.get(
    '/bills/:id/payment-requests',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId } = authUser;

      const tenant = forTenant(restaurantId);
      const list = await PaymentService.getPaymentRequests(restaurantId, billId, tenant.db);

      return reply.send({ paymentRequests: list });
    },
  );

  /**
   * POST /bills/:id/payment-requests
   * Generates a dynamic UPI QR payment request for current balance due.
   */
  fastify.post(
    '/bills/:id/payment-requests',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId } = authUser;

      const tenant = forTenant(restaurantId);
      const created = await PaymentService.createPaymentRequest(
        { restaurantId, billId },
        tenant.db,
      );

      return reply.status(201).send(created);
    },
  );
}
