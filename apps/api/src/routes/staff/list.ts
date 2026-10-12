import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { Permissions, Roles } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';

export async function registerStaffListRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/staff',
    isPublic: false,
    permission: Permissions.STAFF_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/staff/approvers',
    isPublic: false,
    permission: Permissions.ORDER_READ,
  });

  /**
   * GET /staff/approvers - List active OWNER/MANAGER users who can approve overrides
   */
  app.get(
    '/staff/approvers',
    { preHandler: [requirePermission(Permissions.ORDER_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const approvers = await tenant.db
        .select({
          id: users.id,
          name: users.name,
          role: roles.name,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(
          and(
            eq(users.restaurantId, authUser.restaurantId),
            eq(users.active, true),
            inArray(roles.name, [Roles.OWNER, Roles.MANAGER]),
          ),
        )
        .orderBy(roles.name, users.name);

      return reply.status(200).send(
        approvers.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
        })),
      );
    },
  );

  /**
   * GET /staff - List all staff in the restaurant
   */
  app.get(
    '/staff',
    { preHandler: [requirePermission(Permissions.STAFF_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const staffList = await tenant.db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          roleId: users.roleId,
          roleName: roles.name,
          active: users.active,
          failedAttempts: users.failedAttempts,
          lockedUntil: users.lockedUntil,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.restaurantId, authUser.restaurantId));

      return reply.status(200).send(
        staffList.map((s) => ({
          id: s.id,
          name: s.name,
          username: s.username,
          role: s.roleName ?? 'WAITER',
          active: s.active,
          failedAttempts: s.failedAttempts,
          lockedUntil: s.lockedUntil,
          lastLoginAt: s.lastLoginAt,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      );
    },
  );
}
