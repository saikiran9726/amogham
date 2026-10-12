import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  Permissions,
  redeemPointsSchema,
} from '@restaurant-os/shared';
import { requirePermission } from '../../auth/middleware.js';
import { extractIdempotencyKey, withIdempotency } from '../../http/idempotency.js';
import { LoyaltyRedemptionService } from '../../services/billing/LoyaltyRedemptionService.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import { billLines } from '../../db/schema/bills.js';
import { forTenant } from '../../db/tenant.js';

export async function redeemRoutes(fastify: FastifyInstance) {
  /**
   * POST /bills/:id/redeem
   * Redeems customer loyalty points against a bill in blocks.
   * Concurrency protected via SELECT FOR UPDATE on loyalty_accounts.
   */
  fastify.post(
    '/bills/:id/redeem',
    { preHandler: [requirePermission(Permissions.PAYMENT_TAKE)] },
    async (request: FastifyRequest, reply) => {
      const { id: billId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;

      const body = redeemPointsSchema.parse(request.body);
      const idempotencyKey = extractIdempotencyKey(request, body);

      const tenant = forTenant(restaurantId);
      const execution = await tenant.withTx(async (_t, tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId,
            userId,
            commandType: 'loyalty.redeem',
            key: idempotencyKey,
            requestBody: request.body,
          },
          async (tx) => {
            const redeemResult = await LoyaltyRedemptionService.redeem(tx, {
              restaurantId,
              billId,
              pointsToRedeem: body.pointsToRedeem,
              userId,
              request,
            });

            const refreshedLines = await tx
              .select()
              .from(billLines)
              .where(eq(billLines.billId, billId));

            const responsePayload = {
              success: true,
              bill: redeemResult.bill,
              lines: refreshedLines,
              redeemedPoints: redeemResult.pointsRedeemed,
              discountPaise: redeemResult.discountPaise,
              newBalance: redeemResult.account.pointsBalance,
            };

            return responsePayload;
          },
        );
      });

      if (!execution.replayed) {
        emitRealtimeEvent(restaurantId, 'bill.updated', { billId }, 'floor');
        emitRealtimeEvent(restaurantId, 'bill.updated', { billId }, 'owner');
      }

      return reply.send(execution.result);
    },
  );
}
