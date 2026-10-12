import type { FastifyInstance } from 'fastify';
import { eq, and, asc, inArray } from 'drizzle-orm';
import {
  Permissions,
  createModifierGroupSchema,
  updateModifierGroupSchema,
  AppError,
  generateUuidV7,
} from '@restaurant-os/shared';
import { forTenant } from '../db/tenant.js';
import { modifierGroups, modifiers } from '../db/schema/modifiers.js';
import { requirePermission, registerRouteGuard } from '../auth/middleware.js';
import { recordAuditLog } from '../services/audit.js';

export async function registerModifiersRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/modifier-groups',
    isPublic: false,
    permission: Permissions.MENU_READ,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/modifier-groups',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/modifier-groups/:id',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'DELETE',
    url: '/modifier-groups/:id',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });

  /**
   * GET /modifier-groups - List modifier groups with nested options
   */
  app.get(
    '/modifier-groups',
    { preHandler: [requirePermission(Permissions.MENU_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const groups = await tenant.db
        .select()
        .from(modifierGroups)
        .where(eq(modifierGroups.restaurantId, authUser.restaurantId))
        .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.name));

      if (groups.length === 0) {
        return reply.status(200).send([]);
      }

      const groupIds = groups.map((g) => g.id);
      const allModifiers = await tenant.db
        .select()
        .from(modifiers)
        .where(inArray(modifiers.modifierGroupId, groupIds))
        .orderBy(asc(modifiers.sortOrder), asc(modifiers.name));

      const optionsByGroupId = new Map<string, typeof allModifiers>();
      for (const opt of allModifiers) {
        const list = optionsByGroupId.get(opt.modifierGroupId) ?? [];
        list.push(opt);
        optionsByGroupId.set(opt.modifierGroupId, list);
      }

      const result = groups.map((g) => ({
        ...g,
        options: optionsByGroupId.get(g.id) ?? [],
      }));

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /modifier-groups - Create modifier group with options
   */
  app.post(
    '/modifier-groups',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = createModifierGroupSchema.parse(request.body);

      const groupId = generateUuidV7();
      const [createdGroup] = await tenant.db
        .insert(modifierGroups)
        .values({
          id: groupId,
          restaurantId: authUser.restaurantId,
          name: body.name,
          description: body.description,
          minSelections: body.minSelections,
          maxSelections: body.maxSelections,
          sortOrder: body.sortOrder,
          active: true,
        })
        .returning();

      // Insert options
      const insertedOptions = [];
      if (body.options && body.options.length > 0) {
        for (let i = 0; i < body.options.length; i++) {
          const opt = body.options[i]!;
          const optId = generateUuidV7();
          const [createdOpt] = await tenant.db
            .insert(modifiers)
            .values({
              id: optId,
              modifierGroupId: groupId,
              name: opt.name,
              priceDeltaPaise: opt.priceDeltaPaise,
              sortOrder: opt.sortOrder ?? i,
            })
            .returning();
          insertedOptions.push(createdOpt!);
        }
      }

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'modifier_group.create',
        entity: 'modifier_group',
        entityId: groupId,
        after: body,
        request,
      });

      return reply.status(201).send({
        ...createdGroup,
        options: insertedOptions,
      });
    },
  );

  /**
   * PATCH /modifier-groups/:id - Update group and replace options
   */
  app.patch<{ Params: { id: string } }>(
    '/modifier-groups/:id',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;
      const body = updateModifierGroupSchema.parse(request.body);

      const [target] = await tenant.db
        .select()
        .from(modifierGroups)
        .where(
          and(eq(modifierGroups.id, id), eq(modifierGroups.restaurantId, authUser.restaurantId)),
        )
        .limit(1);

      if (!target) {
        throw AppError.notFound('Modifier group not found');
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.minSelections !== undefined) updateData.minSelections = body.minSelections;
      if (body.maxSelections !== undefined) updateData.maxSelections = body.maxSelections;
      if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

      const [updatedGroup] = await tenant.db
        .update(modifierGroups)
        .set(updateData)
        .where(eq(modifierGroups.id, target.id))
        .returning();

      // If options passed, replace options
      if (body.options !== undefined) {
        await tenant.db.delete(modifiers).where(eq(modifiers.modifierGroupId, target.id));
        for (let i = 0; i < body.options.length; i++) {
          const opt = body.options[i]!;
          await tenant.db.insert(modifiers).values({
            id: generateUuidV7(),
            modifierGroupId: target.id,
            name: opt.name,
            priceDeltaPaise: opt.priceDeltaPaise,
            sortOrder: opt.sortOrder ?? i,
          });
        }
      }

      const currentOptions = await tenant.db
        .select()
        .from(modifiers)
        .where(eq(modifiers.modifierGroupId, target.id))
        .orderBy(asc(modifiers.sortOrder));

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'modifier_group.update',
        entity: 'modifier_group',
        entityId: target.id,
        before: { name: target.name },
        after: body,
        request,
      });

      return reply.status(200).send({
        ...updatedGroup,
        options: currentOptions,
      });
    },
  );

  /**
   * DELETE /modifier-groups/:id - Deactivate group
   */
  app.delete<{ Params: { id: string } }>(
    '/modifier-groups/:id',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;

      const [target] = await tenant.db
        .select()
        .from(modifierGroups)
        .where(
          and(eq(modifierGroups.id, id), eq(modifierGroups.restaurantId, authUser.restaurantId)),
        )
        .limit(1);

      if (!target) {
        throw AppError.notFound('Modifier group not found');
      }

      await tenant.db
        .update(modifierGroups)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(modifierGroups.id, target.id));

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'modifier_group.deactivate',
        entity: 'modifier_group',
        entityId: target.id,
        request,
      });

      return reply.status(200).send({ success: true });
    },
  );
}
