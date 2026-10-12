import type { FastifyInstance } from 'fastify';
import { eq, and, ne, sql } from 'drizzle-orm';
import { invalidateUserSessionCache } from '../../auth/token-cache.js';
import {
  Permissions,
  Roles,
  AppError,
  staffUpdateSchema,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import {
  canActorManageTargetRole,
  canActorPromoteRole,
} from '../../auth/role-hierarchy.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerStaffUpdateRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'PATCH',
    url: '/staff/:id',
    isPublic: false,
    permission: Permissions.STAFF_MANAGE,
  });

  /**
   * PATCH /staff/:id - Update staff profile, role, or active status
   * Enforces last-owner protection (cannot deactivate or demote the last active owner)
   */
  app.patch<{ Params: { id: string } }>(
    '/staff/:id',
    { preHandler: [requirePermission(Permissions.STAFF_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;
      const body = staffUpdateSchema.parse(request.body);

      // Fetch target user with their current role
      const [targetUser] = await tenant.db
        .select({
          id: users.id,
          restaurantId: users.restaurantId,
          roleId: users.roleId,
          name: users.name,
          username: users.username,
          active: users.active,
          roleName: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.id, id), eq(users.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!targetUser) {
        throw AppError.notFound('Staff member not found');
      }

      // Last-owner check:
      const isTargetActiveOwner = targetUser.active && targetUser.roleName === 'OWNER';
      const isDeactivating = body.active === false;
      const isChangingRoleAway = body.role && body.role !== 'OWNER';

      if (isTargetActiveOwner && (isDeactivating || isChangingRoleAway)) {
        // Count how many OTHER active owners exist in this restaurant
        const otherActiveOwners = await tenant.db
          .select({ id: users.id })
          .from(users)
          .innerJoin(roles, eq(users.roleId, roles.id))
          .where(
            and(
              eq(users.restaurantId, authUser.restaurantId),
              eq(roles.name, 'OWNER'),
              eq(users.active, true),
              ne(users.id, targetUser.id),
            ),
          );

        if (otherActiveOwners.length === 0) {
          throw AppError.badRequest(
            'Cannot deactivate or demote the last active owner of the restaurant.',
          );
        }
      }

      // Self-modification check: nobody changes their own role or deactivates themselves
      if (authUser.userId === targetUser.id) {
        if (body.active === false) {
          throw AppError.badRequest('Users cannot deactivate themselves');
        }
        if (body.role && body.role !== targetUser.roleName) {
          throw AppError.forbidden('Users cannot change their own role');
        }
      }

      // Role hierarchy enforcement for managing other users
      if (authUser.userId !== targetUser.id) {
        const currentTargetRole = targetUser.roleName ?? 'WAITER';
        if (!canActorManageTargetRole(authUser.role, currentTargetRole)) {
          throw AppError.forbidden(
            `Cannot modify staff with role '${currentTargetRole}' (requires strictly higher rank)`,
          );
        }

        if (body.role && body.role !== currentTargetRole) {
          if (!canActorPromoteRole(authUser.role, currentTargetRole, body.role)) {
            if (body.role === Roles.OWNER || body.role === Roles.MANAGER) {
              throw AppError.forbidden('Only an owner may promote an OWNER or MANAGER');
            }
            throw AppError.forbidden(
              `Cannot assign role '${body.role}' (requires strictly higher rank)`,
            );
          }
        }
      }

      // Determine new role ID if role is updating
      let newRoleId = targetUser.roleId;
      if (body.role) {
        const [foundRole] = await tenant.db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.name, body.role))
          .limit(1);

        if (!foundRole) {
          throw AppError.badRequest(`Role '${body.role}' not found`);
        }
        newRoleId = foundRole.id;
      }

      const roleChanged = Boolean(newRoleId && newRoleId !== targetUser.roleId);
      const activeChanged = Boolean(body.active !== undefined && body.active !== targetUser.active);

      const [updated] = await tenant.db
        .update(users)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(roleChanged ? { roleId: newRoleId } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(roleChanged || activeChanged ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetUser.id))
        .returning({
          id: users.id,
          name: users.name,
          username: users.username,
          roleId: users.roleId,
          active: users.active,
          updatedAt: users.updatedAt,
        });

      if (roleChanged || activeChanged) {
        invalidateUserSessionCache(authUser.restaurantId, targetUser.id);
      }

      if (!updated) {
        throw AppError.internal('Failed to update staff member');
      }

      // Audit logs
      if (body.active !== undefined && body.active !== targetUser.active) {
        await recordAuditLog({
          restaurantId: authUser.restaurantId,
          userId: authUser.userId,
          action: body.active ? 'staff.reactivate' : 'staff.deactivate',
          entity: 'user',
          entityId: targetUser.id,
          before: { active: targetUser.active },
          after: { active: body.active },
          request,
        });
      }

      if (body.role && body.role !== targetUser.roleName) {
        await recordAuditLog({
          restaurantId: authUser.restaurantId,
          userId: authUser.userId,
          action: 'staff.role_change',
          entity: 'user',
          entityId: targetUser.id,
          before: { role: targetUser.roleName },
          after: { role: body.role },
          request,
        });
      }

      if (body.name && body.name !== targetUser.name) {
        await recordAuditLog({
          restaurantId: authUser.restaurantId,
          userId: authUser.userId,
          action: 'staff.edit',
          entity: 'user',
          entityId: targetUser.id,
          before: { name: targetUser.name },
          after: { name: body.name },
          request,
        });
      }

      return reply.status(200).send({
        id: updated.id,
        name: updated.name,
        username: updated.username,
        role: body.role ?? targetUser.roleName,
        active: updated.active,
        updatedAt: updated.updatedAt,
      });
    },
  );
}
