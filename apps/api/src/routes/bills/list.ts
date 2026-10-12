import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Permissions,
  BillFilterSchema,
  ApplyDiscountSchema,
} from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { BillingService } from '../../services/billing/BillingService.js';

export async function listBillRoutes(fastify: FastifyInstance) {
  /**
   * GET /bills
   * Lists bills with filters (date, status, table, search, pagination).
   */
  fastify.get(
    '/bills',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const { restaurantId, userId, role: roleName } = authUser;
      const query = BillFilterSchema.parse(request.query || {});

      const result = await BillingService.listBills({
        restaurantId,
        userId,
        roleName,
        query,
      });

      return reply.send(result);
    },
  );

  /**
   * GET /bills/:id
   * Fetches bill details, line snapshots, payment logs, and refunds.
   */
  fastify.get(
    '/bills/:id',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;

      const result = await BillingService.getBillById({
        restaurantId,
        billId,
        userId,
        request,
      });

      return reply.send(result);
    },
  );

  /**
   * PATCH /bills/:id/discount
   * Applies or updates discount on an unpaid bill.
   */
  fastify.patch(
    '/bills/:id/discount',
    { preHandler: [requirePermission(Permissions.DISCOUNT_APPLY)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId, role: roleName } = authUser;

      const body = ApplyDiscountSchema.parse(request.body);

      const result = await BillingService.applyDiscount({
        restaurantId,
        billId,
        userId,
        roleName,
        body,
        request,
      });

      return reply.send(result);
    },
  );
}
