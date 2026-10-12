import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Permissions, CreateBillSchema } from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { extractIdempotencyKey } from '../../http/idempotency.js';
import { BillingService } from '../../services/billing/BillingService.js';

export async function createBillRoutes(fastify: FastifyInstance) {
  /**
   * POST /orders/:id/bill
   * Generates or fetches an existing active bill for an order.
   */
  fastify.post(
    '/orders/:id/bill',
    { preHandler: [requirePermission(Permissions.BILL_CREATE)] },
    async (request: FastifyRequest, reply) => {
      const { id: orderId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId, role: roleName } = authUser;

      const body = CreateBillSchema.parse(request.body || {});
      const idempotencyKey = extractIdempotencyKey(request, body);

      const execution = await BillingService.createBill({
        orderId,
        restaurantId,
        userId,
        roleName,
        body,
        idempotencyKey,
        request,
      });

      return reply.status(execution.replayed ? 200 : 201).send(execution.result);
    },
  );
}
