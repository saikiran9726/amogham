import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, desc, or, ilike } from 'drizzle-orm';
import {
  Permissions,
  AppError,
  computeCustomerSegment,
  type CustomerSegment,
  type CustomerPreferences,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { customers } from '../../db/schema/customers.js';
import { orders } from '../../db/schema/orders.js';
import { loyaltyAccounts, loyaltyTransactions } from '../../db/schema/loyalty.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { getCustomerDiningMemory } from './memory.js';

export async function registerCustomerManageRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/customers',
    isPublic: false,
    permission: Permissions.CUSTOMER_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/customers/:id',
    isPublic: false,
    permission: Permissions.CUSTOMER_MANAGE,
  });
  registerRouteGuard({
    method: 'DELETE',
    url: '/customers/:id',
    isPublic: false,
    permission: Permissions.CUSTOMER_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/customers/:id/export',
    isPublic: false,
    permission: Permissions.CUSTOMER_MANAGE,
  });

  /**
   * GET /customers - Owner list with segments and search filters
   */
  app.get(
    '/customers',
    { preHandler: [requirePermission(Permissions.CUSTOMER_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const { restaurantId } = authUser;
      const tenant = forTenant(restaurantId);
      const {
        search,
        segment: targetSegment,
        limit = 50,
        offset = 0,
      } = request.query as {
        search?: string;
        segment?: string;
        limit?: number;
        offset?: number;
      };

      const [settings] = await tenant.db
        .select()
        .from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, restaurantId))
        .limit(1);

      const segmentSettings = {
        regularMinVisits: settings?.segmentRegularMinVisits ?? 4,
        highValueMinSpentPaise: settings?.segmentHighValueMinSpentPaise ?? 500000,
        inactiveDays: settings?.segmentInactiveDays ?? 45,
      };

      const conditions = [eq(customers.restaurantId, restaurantId)];

      if (search && search.trim().length > 0) {
        const term = `%${search.trim()}%`;
        conditions.push(or(ilike(customers.name, term), ilike(customers.phone, term))!);
      }

      const allList = await tenant.db
        .select()
        .from(customers)
        .where(and(...conditions))
        .orderBy(desc(customers.lastVisitAt), desc(customers.createdAt));

      // Classify segments and tally counts
      const counts: Record<string, number> = {
        all: allList.length,
        new: 0,
        returning: 0,
        regular: 0,
        high_value: 0,
        inactive: 0,
        at_risk: 0,
      };

      const classified = allList.map((c) => {
        const seg = computeCustomerSegment(
          {
            visitCount: c.visitCount,
            totalSpentPaise: c.totalSpentPaise,
            lastVisitAt: c.lastVisitAt,
          },
          segmentSettings,
        );

        counts[seg.segment] = (counts[seg.segment] || 0) + 1;

        const aovPaise = c.visitCount > 0 ? Math.round(c.totalSpentPaise / c.visitCount) : 0;

        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          birthday: c.birthday,
          preferences: (c.preferences as CustomerPreferences) || { tags: [], note: '' },
          notes: c.notes,
          consentRecorded: c.consentRecorded,
          createdAt: c.createdAt.toISOString(),
          lastVisitAt: c.lastVisitAt?.toISOString() || null,
          visitCount: c.visitCount,
          totalSpentPaise: c.totalSpentPaise,
          averageOrderValuePaise: aovPaise,
          segment: seg.segment as CustomerSegment,
          segmentReason: seg.reason,
        };
      });

      // Filter by segment if specified
      let filtered = classified;
      if (targetSegment && targetSegment !== 'all') {
        filtered = classified.filter((c) => c.segment === targetSegment);
      }

      const paginated = filtered.slice(Number(offset), Number(offset) + Number(limit));

      return reply.status(200).send({
        customers: paginated,
        total: filtered.length,
        counts,
        preferenceTags: settings?.customerPreferenceTags || [
          'Less spicy',
          'Extra spicy',
          'No onion',
          'No garlic',
          'Jain',
        ],
      });
    },
  );

  /**
   * GET /customers/:id - Owner customer detail view with order history
   */
  app.get(
    '/customers/:id',
    { preHandler: [requirePermission(Permissions.CUSTOMER_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { id } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId } = authUser;
      const tenant = forTenant(restaurantId);

      const [customer] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.restaurantId, restaurantId)))
        .limit(1);

      if (!customer) {
        throw AppError.notFound('Customer not found');
      }

      const { favouriteItems } = await getCustomerDiningMemory(restaurantId, id);

      const [settings] = await tenant.db
        .select()
        .from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, restaurantId))
        .limit(1);

      const seg = computeCustomerSegment(
        {
          visitCount: customer.visitCount,
          totalSpentPaise: customer.totalSpentPaise,
          lastVisitAt: customer.lastVisitAt,
        },
        {
          regularMinVisits: settings?.segmentRegularMinVisits ?? 4,
          highValueMinSpentPaise: settings?.segmentHighValueMinSpentPaise ?? 500000,
          inactiveDays: settings?.segmentInactiveDays ?? 45,
        },
      );

      const aovPaise =
        customer.visitCount > 0 ? Math.round(customer.totalSpentPaise / customer.visitCount) : 0;

      // Recent orders list
      const customerOrders = await tenant.db
        .select({
          id: orders.id,
          createdAt: orders.createdAt,
          type: orders.type,
          status: orders.status,
          totalPaise: orders.totalPaise,
        })
        .from(orders)
        .where(and(eq(orders.restaurantId, restaurantId), eq(orders.customerId, id)))
        .orderBy(desc(orders.createdAt))
        .limit(10);

      const ownerDetail = {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        birthday: customer.birthday,
        preferences: (customer.preferences as CustomerPreferences) || { tags: [], note: '' },
        notes: customer.notes,
        consentRecorded: customer.consentRecorded,
        createdAt: customer.createdAt.toISOString(),
        lastVisitAt: customer.lastVisitAt?.toISOString() || null,
        visitCount: customer.visitCount,
        totalSpentPaise: customer.totalSpentPaise,
        averageOrderValuePaise: aovPaise,
        segment: seg.segment,
        segmentReason: seg.reason,
        favouriteItems,
        recentOrders: customerOrders,
      };

      return reply.status(200).send(ownerDetail);
    },
  );

  /**
   * DELETE /customers/:id - Anonymize customer (Right to Erasure compliance)
   */
  app.delete(
    '/customers/:id',
    { preHandler: [requirePermission(Permissions.CUSTOMER_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { id } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId } = authUser;
      const tenant = forTenant(restaurantId);

      const [existing] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.restaurantId, restaurantId)))
        .limit(1);

      if (!existing) {
        throw AppError.notFound('Customer not found');
      }

      // Anonymize row
      const anonymizedPhone = `+910000000000_anonymized_${id.slice(0, 8)}`;
      await tenant.db
        .update(customers)
        .set({
          name: null,
          phone: anonymizedPhone,
          email: null,
          birthday: null,
          notes: null,
          preferences: { tags: [], note: '' },
          updatedAt: new Date(),
        })
        .where(eq(customers.id, id));

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'customer.anonymize',
        entity: 'customer',
        entityId: id,
        before: { phone: existing.phone, name: existing.name },
        after: { phone: anonymizedPhone, anonymized: true },
        request,
      });

      return reply.status(200).send({
        success: true,
        message: 'Customer anonymized successfully. Identifying details removed.',
      });
    },
  );

  /**
   * GET /customers/:id/export - Data Portability / Privacy export
   */
  app.get(
    '/customers/:id/export',
    { preHandler: [requirePermission(Permissions.CUSTOMER_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { id } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId } = authUser;
      const tenant = forTenant(restaurantId);

      const [customer] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.restaurantId, restaurantId)))
        .limit(1);

      if (!customer) {
        throw AppError.notFound('Customer not found');
      }

      // Fetch customer orders
      const customerOrders = await tenant.db
        .select()
        .from(orders)
        .where(and(eq(orders.customerId, id), eq(orders.restaurantId, restaurantId)))
        .orderBy(desc(orders.createdAt));

      // Fetch loyalty account & transactions if exists
      const [loyaltyAcc] = await tenant.db
        .select()
        .from(loyaltyAccounts)
        .where(and(eq(loyaltyAccounts.customerId, id), eq(loyaltyAccounts.restaurantId, restaurantId)))
        .limit(1);

      const customerLoyaltyTx = loyaltyAcc
        ? await tenant.db
            .select()
            .from(loyaltyTransactions)
            .where(and(eq(loyaltyTransactions.accountId, loyaltyAcc.id), eq(loyaltyTransactions.restaurantId, restaurantId)))
            .orderBy(desc(loyaltyTransactions.createdAt))
        : [];

      return reply.status(200).send({
        exportedAt: new Date().toISOString(),
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          birthday: customer.birthday,
          preferences: customer.preferences,
          notes: customer.notes,
          consentRecorded: customer.consentRecorded,
          visitCount: customer.visitCount,
          totalSpentPaise: customer.totalSpentPaise,
          createdAt: customer.createdAt.toISOString(),
          updatedAt: customer.updatedAt.toISOString(),
        },
        orders: customerOrders.map((o) => ({
          id: o.id,
          type: o.type,
          status: o.status,
          totalPaise: o.totalPaise,
          createdAt: o.createdAt.toISOString(),
        })),
        loyalty: loyaltyAcc
          ? {
              pointsBalance: loyaltyAcc.pointsBalance,
              tier: loyaltyAcc.tier,
              lifetimePoints: loyaltyAcc.lifetimePoints,
              transactions: customerLoyaltyTx.map((tx) => ({
                id: tx.id,
                type: tx.type,
                points: tx.points,
                reason: tx.reason,
                createdAt: tx.createdAt.toISOString(),
              })),
            }
          : null,
      });
    },
  );
}

