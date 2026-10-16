import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Permissions, CancelBillSchema, RefundBillSchema } from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { RefundService } from '../../services/billing/RefundService.js';
import { forTenant } from '../../db/tenant.js';

export async function refundRoutes(fastify: FastifyInstance) {
  /**
   * POST /bills/:id/cancel
   * Cancels an unpaid bill or cancels a paid bill with owner authorization.
   */
  fastify.post(
    '/bills/:id/cancel',
    { preHandler: [requirePermission(Permissions.BILL_CREATE)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId, role: roleName } = authUser;

      const body = CancelBillSchema.parse(request.body);

      const tenant = forTenant(restaurantId);
      const result = await RefundService.cancelBill(
        {
          restaurantId,
          billId,
          userId,
          roleName,
          reason: body.reason,
          approverUserId: body.approverUserId,
          pin: body.pin,
          overridePin: body.overridePin,
          request,
        },
        tenant.db,
      );

      return reply.send({ bill: result });
    },
  );

  /**
   * POST /bills/:id/refunds
   * Records a refund on a paid or partially paid bill.
   */
  fastify.post(
    '/bills/:id/refunds',
    { preHandler: [requirePermission(Permissions.BILL_REFUND)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;

      const body = RefundBillSchema.parse(request.body);

      const tenant = forTenant(restaurantId);
      const result = await RefundService.refundBill(
        {
          restaurantId,
          billId,
          userId,
          amountPaise: body.amountPaise,
          method: body.method,
          reason: body.reason,
          paymentId: body.paymentId ?? undefined,
          approverUserId: body.approverUserId,
          pin: body.pin,
          overridePin: body.overridePin,
          request,
        },
        tenant.db,
      );

      return reply.status(201).send(result);
    },
  );
}
