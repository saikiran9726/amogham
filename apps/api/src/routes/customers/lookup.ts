import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  Permissions,
  AppError,
  normalizePhoneNumber,
  createCustomerSchema,
  updateCustomerWaiterSchema,
  updateCustomerOwnerSchema,
  attachCustomerToOrderSchema,
  computeCustomerSegment,
  type CustomerWaiterSummary,
  type CustomerOwnerDetail,
  type CustomerPreferences,
  generateUuidV7,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { customers } from '../../db/schema/customers.js';
import { orders } from '../../db/schema/orders.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { getCustomerDiningMemory } from './memory.js';

export async function registerCustomerLookupRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/customers/lookup',
    isPublic: false,
    permission: Permissions.CUSTOMER_READ,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/customers',
    isPublic: false,
    permission: Permissions.CUSTOMER_READ,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/customers/:id',
    isPublic: false,
    permission: Permissions.CUSTOMER_READ,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/orders/:id/customer',
    isPublic: false,
    permission: Permissions.ORDER_UPDATE,
  });

  /**
   * GET /customers/lookup?phone=...
   */
  app.get(
    '/customers/lookup',
    {
      preHandler: [requirePermission(Permissions.CUSTOMER_READ)],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply) => {
      const { phone } = request.query as { phone?: string };
      const authUser = request.user!;
      const { restaurantId, permissions } = authUser;
      const tenant = forTenant(restaurantId);

      if (!phone || phone.trim().length < 6) {
        return reply.status(200).send({ customer: null });
      }

      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhoneNumber(phone);
      } catch {
        return reply.status(200).send({ customer: null });
      }

      const [customer] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.restaurantId, restaurantId), eq(customers.phone, normalizedPhone)))
        .limit(1);

      if (!customer) {
        return reply.status(200).send({ customer: null });
      }

      const { favouriteItems, lastOrder } = await getCustomerDiningMemory(
        restaurantId,
        customer.id,
      );

      const canManage = permissions.includes(Permissions.CUSTOMER_MANAGE);
      if (!canManage) {
        const waiterSummary: CustomerWaiterSummary = {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          preferences: (customer.preferences as CustomerPreferences) || { tags: [], note: '' },
          favouriteItems,
          lastOrder,
          lastVisitAt: customer.lastVisitAt?.toISOString() || null,
          visitCount: customer.visitCount,
        };
        return reply.status(200).send({ customer: waiterSummary });
      }

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

      const { segment, reason: segmentReason } = computeCustomerSegment(
        {
          visitCount: customer.visitCount,
          totalSpentPaise: customer.totalSpentPaise,
          lastVisitAt: customer.lastVisitAt,
        },
        segmentSettings,
      );

      const aovPaise =
        customer.visitCount > 0 ? Math.round(customer.totalSpentPaise / customer.visitCount) : 0;

      const ownerDetail: CustomerOwnerDetail = {
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
        visitFrequencyDays: null,
        segment,
        segmentReason,
        favouriteItems,
      };

      return reply.status(200).send({ customer: ownerDetail });
    },
  );

  /**
   * POST /customers - Create new customer or return existing on duplicate phone.
   */
  app.post(
    '/customers',
    { preHandler: [requirePermission(Permissions.CUSTOMER_READ)] },
    async (request: FastifyRequest, reply) => {
      const authUser = request.user!;
      const { restaurantId, userId, permissions } = authUser;
      const tenant = forTenant(restaurantId);
      const body = createCustomerSchema.parse(request.body);

      const normalizedPhone = normalizePhoneNumber(body.phone);

      const [existing] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.restaurantId, restaurantId), eq(customers.phone, normalizedPhone)))
        .limit(1);

      if (existing) {
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name && !existing.name) updateData.name = body.name;
        if (body.preferences && body.preferences.tags.length > 0) {
          updateData.preferences = body.preferences;
        }

        const [updated] = await tenant.db
          .update(customers)
          .set(updateData)
          .where(eq(customers.id, existing.id))
          .returning();

        const memory = await getCustomerDiningMemory(restaurantId, updated!.id);
        const canManage = permissions.includes(Permissions.CUSTOMER_MANAGE);

        if (!canManage) {
          const waiterSummary: CustomerWaiterSummary = {
            id: updated!.id,
            name: updated!.name,
            phone: updated!.phone,
            preferences: (updated!.preferences as CustomerPreferences) || { tags: [], note: '' },
            favouriteItems: memory.favouriteItems,
            lastOrder: memory.lastOrder,
            lastVisitAt: updated!.lastVisitAt?.toISOString() || null,
            visitCount: updated!.visitCount,
          };
          return reply.status(200).send(waiterSummary);
        }

        return reply.status(200).send(updated);
      }

      const newId = generateUuidV7();
      const [created] = await tenant.db
        .insert(customers)
        .values({
          id: newId,
          restaurantId,
          name: body.name || null,
          phone: normalizedPhone,
          email: body.email || null,
          birthday: body.birthday || null,
          preferences: body.preferences || { tags: [], note: '' },
          notes: body.notes || null,
          consentRecorded: body.consentRecorded ?? true,
        })
        .returning();

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'customer.create',
        entity: 'customer',
        entityId: newId,
        after: { name: created!.name, phone: created!.phone },
        request,
      });

      const canManage = permissions.includes(Permissions.CUSTOMER_MANAGE);
      if (!canManage) {
        const waiterSummary: CustomerWaiterSummary = {
          id: created!.id,
          name: created!.name,
          phone: created!.phone,
          preferences: (created!.preferences as CustomerPreferences) || { tags: [], note: '' },
          favouriteItems: [],
          lastOrder: null,
          lastVisitAt: null,
          visitCount: 0,
        };
        return reply.status(201).send(waiterSummary);
      }

      return reply.status(201).send(created);
    },
  );

  /**
   * PATCH /customers/:id - Update customer preferences or profile
   */
  app.patch(
    '/customers/:id',
    { preHandler: [requirePermission(Permissions.CUSTOMER_READ)] },
    async (request: FastifyRequest, reply) => {
      const { id } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId, userId, permissions } = authUser;
      const tenant = forTenant(restaurantId);

      const [existing] = await tenant.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.restaurantId, restaurantId)))
        .limit(1);

      if (!existing) {
        throw AppError.notFound('Customer not found');
      }

      const canManage = permissions.includes(Permissions.CUSTOMER_MANAGE);
      const updateValues: Record<string, unknown> = { updatedAt: new Date() };

      if (!canManage) {
        const waiterBody = updateCustomerWaiterSchema.parse(request.body);
        if (waiterBody.name !== undefined) updateValues.name = waiterBody.name;
        if (waiterBody.preferences !== undefined) updateValues.preferences = waiterBody.preferences;
      } else {
        const ownerBody = updateCustomerOwnerSchema.parse(request.body);
        if (ownerBody.name !== undefined) updateValues.name = ownerBody.name;
        if (ownerBody.phone) updateValues.phone = normalizePhoneNumber(ownerBody.phone);
        if (ownerBody.email !== undefined) updateValues.email = ownerBody.email || null;
        if (ownerBody.birthday !== undefined) updateValues.birthday = ownerBody.birthday || null;
        if (ownerBody.preferences !== undefined) updateValues.preferences = ownerBody.preferences;
        if (ownerBody.notes !== undefined) updateValues.notes = ownerBody.notes || null;
        if (ownerBody.consentRecorded !== undefined)
          updateValues.consentRecorded = ownerBody.consentRecorded;
      }

      const [updated] = await tenant.db
        .update(customers)
        .set(updateValues)
        .where(eq(customers.id, id))
        .returning();

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'customer.update',
        entity: 'customer',
        entityId: id,
        before: existing,
        after: updated,
        request,
      });

      if (!canManage) {
        const memory = await getCustomerDiningMemory(restaurantId, id);
        const summary: CustomerWaiterSummary = {
          id: updated!.id,
          name: updated!.name,
          phone: updated!.phone,
          preferences: (updated!.preferences as CustomerPreferences) || { tags: [], note: '' },
          favouriteItems: memory.favouriteItems,
          lastOrder: memory.lastOrder,
          lastVisitAt: updated!.lastVisitAt?.toISOString() || null,
          visitCount: updated!.visitCount,
        };
        return reply.status(200).send(summary);
      }

      return reply.status(200).send(updated);
    },
  );

  /**
   * PATCH /orders/:id/customer - Attach or detach customer from an order
   */
  app.patch(
    '/orders/:id/customer',
    { preHandler: [requirePermission(Permissions.ORDER_UPDATE)] },
    async (request: FastifyRequest, reply) => {
      const { id: orderId } = request.params as { id: string };
      const authUser = request.user!;
      const { restaurantId } = authUser;
      const tenant = forTenant(restaurantId);
      const body = attachCustomerToOrderSchema.parse(request.body);

      const [order] = await tenant.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.restaurantId, restaurantId)))
        .limit(1);

      if (!order) {
        throw AppError.notFound('Order not found');
      }

      if (body.customerId) {
        const [customer] = await tenant.db
          .select()
          .from(customers)
          .where(and(eq(customers.id, body.customerId), eq(customers.restaurantId, restaurantId)))
          .limit(1);

        if (!customer) {
          throw AppError.notFound('Customer not found');
        }
      }

      const [updatedOrder] = await tenant.db
        .update(orders)
        .set({
          customerId: body.customerId,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      return reply.status(200).send(updatedOrder);
    },
  );
}
