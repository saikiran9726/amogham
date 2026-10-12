import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import {
  Permissions,
  createMenuItemSchema,
  updateMenuItemSchema,
  AppError,
  generateUuidV7,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { menuItems, itemModifierGroups } from '../../db/schema/menu-items.js';
import { menuCategories } from '../../db/schema/menu-categories.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerMenuItemCrudRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/menu/items',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/menu/items/:id',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'DELETE',
    url: '/menu/items/:id',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });

  /**
   * POST /menu/items - Create menu item
   */
  app.post(
    '/menu/items',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = createMenuItemSchema.parse(request.body);

      // Verify category exists and belongs to restaurant
      const [category] = await tenant.db
        .select({ id: menuCategories.id })
        .from(menuCategories)
        .where(
          and(
            eq(menuCategories.id, body.categoryId),
            eq(menuCategories.restaurantId, authUser.restaurantId),
          ),
        )
        .limit(1);

      if (!category) {
        throw AppError.badRequest('Invalid category');
      }

      // Check unique item name per category for active items
      const [existing] = await tenant.db
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.restaurantId, authUser.restaurantId),
            eq(menuItems.categoryId, body.categoryId),
            sql`lower(${menuItems.name}) = lower(${body.name})`,
            eq(menuItems.active, true),
          ),
        )
        .limit(1);

      if (existing) {
        throw AppError.conflict(`An item named '${body.name}' already exists in this category.`);
      }

      const id = generateUuidV7();
      const [created] = await tenant.db
        .insert(menuItems)
        .values({
          id,
          restaurantId: authUser.restaurantId,
          categoryId: body.categoryId,
          name: body.name,
          aliases: body.aliases,
          isVeg: body.isVeg,
          pricePaise: body.pricePaise,
          taxRateBp: body.taxRateBp ?? 500,
          available: body.available ?? true,
          oosReason: body.oosReason,
          sortOrder: body.sortOrder ?? 0,
          active: true,
          version: 1,
        })
        .returning();

      // Assign modifier groups
      if (body.modifierGroupIds && body.modifierGroupIds.length > 0) {
        for (let i = 0; i < body.modifierGroupIds.length; i++) {
          await tenant.db.insert(itemModifierGroups).values({
            itemId: id,
            modifierGroupId: body.modifierGroupIds[i]!,
            sortOrder: i,
          });
        }
      }

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu_item.create',
        entity: 'menu_item',
        entityId: id,
        after: body,
        request,
      });

      return reply.status(201).send({
        ...created,
        modifierGroupIds: body.modifierGroupIds || [],
      });
    },
  );

  /**
   * PATCH /menu/items/:id - Update menu item
   */
  app.patch<{ Params: { id: string } }>(
    '/menu/items/:id',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;
      const body = updateMenuItemSchema.parse(request.body);

      const [target] = await tenant.db
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.id, id), eq(menuItems.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!target) {
        throw AppError.notFound('Menu item not found');
      }

      if (body.version !== undefined && target.version !== body.version) {
        throw AppError.conflict(
          'This item was modified by another user. Please refresh and try again.',
        );
      }

      const nextCategory = body.categoryId || target.categoryId;
      const nextName = body.name || target.name;
      if (
        (body.name && body.name.toLowerCase() !== target.name.toLowerCase()) ||
        (body.categoryId && body.categoryId !== target.categoryId)
      ) {
        const [conflict] = await tenant.db
          .select({ id: menuItems.id })
          .from(menuItems)
          .where(
            and(
              eq(menuItems.restaurantId, authUser.restaurantId),
              eq(menuItems.categoryId, nextCategory),
              sql`lower(${menuItems.name}) = lower(${nextName})`,
              eq(menuItems.active, true),
            ),
          )
          .limit(1);

        if (conflict && conflict.id !== target.id) {
          throw AppError.conflict(`An item named '${nextName}' already exists in this category.`);
        }
      }

      const updateValues: Record<string, unknown> = {
        version: target.version + 1,
        updatedAt: new Date(),
      };

      if (body.name !== undefined) updateValues.name = body.name;
      if (body.categoryId !== undefined) updateValues.categoryId = body.categoryId;
      if (body.aliases !== undefined) updateValues.aliases = body.aliases;
      if (body.isVeg !== undefined) updateValues.isVeg = body.isVeg;
      if (body.pricePaise !== undefined) updateValues.pricePaise = body.pricePaise;
      if (body.taxRateBp !== undefined) updateValues.taxRateBp = body.taxRateBp;
      if (body.available !== undefined) updateValues.available = body.available;
      if (body.oosReason !== undefined) updateValues.oosReason = body.oosReason;
      if (body.sortOrder !== undefined) updateValues.sortOrder = body.sortOrder;
      if (body.active !== undefined) updateValues.active = body.active;

      const [updated] = await tenant.db
        .update(menuItems)
        .set(updateValues)
        .where(eq(menuItems.id, target.id))
        .returning();

      if (body.modifierGroupIds !== undefined) {
        await tenant.db.delete(itemModifierGroups).where(eq(itemModifierGroups.itemId, target.id));
        for (let i = 0; i < body.modifierGroupIds.length; i++) {
          await tenant.db.insert(itemModifierGroups).values({
            itemId: target.id,
            modifierGroupId: body.modifierGroupIds[i]!,
            sortOrder: i,
          });
        }
      }

      if (body.pricePaise !== undefined && body.pricePaise !== target.pricePaise) {
        await recordAuditLog({
          restaurantId: authUser.restaurantId,
          userId: authUser.userId,
          action: 'menu_item.price_change',
          entity: 'menu_item',
          entityId: target.id,
          before: { pricePaise: target.pricePaise },
          after: { pricePaise: body.pricePaise },
          request,
        });
      }

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu_item.update',
        entity: 'menu_item',
        entityId: target.id,
        before: { name: target.name, isVeg: target.isVeg, available: target.available },
        after: body,
        request,
      });

      return reply.status(200).send(updated);
    },
  );

  /**
   * DELETE /menu/items/:id - Deactivate item
   */
  app.delete<{ Params: { id: string } }>(
    '/menu/items/:id',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;

      const [target] = await tenant.db
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.id, id), eq(menuItems.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!target) {
        throw AppError.notFound('Menu item not found');
      }

      await tenant.db
        .update(menuItems)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(menuItems.id, target.id));

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu_item.deactivate',
        entity: 'menu_item',
        entityId: target.id,
        request,
      });

      return reply.status(200).send({ success: true });
    },
  );
}
