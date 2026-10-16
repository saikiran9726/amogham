import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Permissions, printEventSchema } from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { forTenant } from '../../db/tenant.js';

export async function printBillRoutes(fastify: FastifyInstance) {
  /**
   * POST /bills/:id/reprint
   * Pre-authorizes a reprint before any printer is invoked.
   */
  fastify.post(
    '/bills/:id/reprint',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, permissions: userPerms } = authUser;
      const { ownerPin, pin, approverUserId } = printEventSchema
        .pick({ approverUserId: true, ownerPin: true, pin: true })
        .parse(request.body || {});

      const tenant = forTenant(restaurantId);
      const result = await BillingService.reprintBill(
        {
          restaurantId,
          billId,
          userId: authUser.userId,
          permissions: userPerms,
          approverUserId,
          pin,
          ownerPin,
          request,
        },
        tenant.db,
      );

      return reply.send(result);
    },
  );

  /**
   * GET /bills/:id/receipt
   * Generates structured receipt data, monospace plain text, and ESC/POS byte sequence.
   */
  fastify.get(
    '/bills/:id/receipt',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const { widthMm: queryWidth, printerId } = (request.query || {}) as {
        widthMm?: string;
        printerId?: string;
      };
      const authUser = request.user!;
      const { restaurantId } = authUser;

      const tenant = forTenant(restaurantId);
      const result = await BillingService.getReceipt(
        {
          restaurantId,
          billId,
          widthMm: queryWidth,
          printerId,
        },
        tenant.db,
      );

      return reply.send(result);
    },
  );

  /**
   * POST /bills/:id/print-events
   * Records physical/browser print attempt, audits reprints/duplicates, and updates bills.printed_count.
   */
  fastify.post(
    '/bills/:id/print-events',
    { preHandler: [requirePermission(Permissions.BILL_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId, permissions: userPerms } = authUser;
      const body = printEventSchema.parse(request.body || {});

      const tenant = forTenant(restaurantId);
      const result = await BillingService.recordPrintEvent(
        {
          restaurantId,
          billId,
          userId,
          permissions: userPerms,
          body,
          request,
        },
        tenant.db,
      );

      return reply.status(201).send(result);
    },
  );
}
