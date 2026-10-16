import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { invalidateUserSessionCache } from '../../auth/token-cache.js';
import { disconnectUserSockets } from '../../realtime/socket.js';
import { Permissions, AppError, staffResetCredentialSchema } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import { hashPassword, hashPin } from '../../auth/crypto.js';
import { canActorManageTargetRole } from '../../auth/role-hierarchy.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerStaffResetCredentialRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/staff/:id/reset-credential',
    isPublic: false,
    permission: Permissions.STAFF_MANAGE,
  });

  /**
   * POST /staff/:id/reset-credential - Reset password or PIN for staff member
   */
  app.post<{ Params: { id: string } }>(
    '/staff/:id/reset-credential',
    { preHandler: [requirePermission(Permissions.STAFF_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const { id } = request.params;
      const body = staffResetCredentialSchema.parse(request.body);

      const [targetUser] = await tenant.db
        .select({
          id: users.id,
          restaurantId: users.restaurantId,
          username: users.username,
          roleId: users.roleId,
          roleName: roles.name,
          passwordHash: users.passwordHash,
          pinHash: users.pinHash,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.id, id), eq(users.restaurantId, authUser.restaurantId)))
        .limit(1);

      if (!targetUser) {
        throw AppError.notFound('Staff member not found');
      }

      // Nobody resets their own credentials via staff management
      if (authUser.userId === targetUser.id) {
        throw AppError.forbidden('Users cannot reset their own credentials via staff management');
      }

      // Enforce role hierarchy: strictly lower rank required
      const targetRole = targetUser.roleName ?? 'WAITER';
      if (!canActorManageTargetRole(authUser.role, targetRole)) {
        throw AppError.forbidden(
          `Cannot reset credentials for staff with role '${targetRole}' (requires strictly higher rank)`,
        );
      }

      // Generate or take credential
      let passwordHash: string | null = null;
      let pinHash: string | null = null;
      let finalCredentialValue = '';

      if (body.credentialType === 'password') {
        finalCredentialValue =
          body.password || `Restro@${Math.floor(100000 + Math.random() * 900000)}`;
        passwordHash = await hashPassword(finalCredentialValue);
      } else {
        finalCredentialValue = body.pin || `${Math.floor(1000 + Math.random() * 9000)}`;
        pinHash = await hashPin(finalCredentialValue);
      }

      await tenant.db
        .update(users)
        .set({
          passwordHash: passwordHash ?? undefined,
          pinHash: pinHash ?? undefined,
          failedAttempts: 0,
          lockedUntil: null,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetUser.id));

      invalidateUserSessionCache(authUser.restaurantId, targetUser.id);
      disconnectUserSockets(targetUser.id, 'Credentials reset');

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'staff.reset_credential',
        entity: 'user',
        entityId: targetUser.id,
        before: {
          credentialType: targetUser.passwordHash ? 'password' : 'pin',
        },
        after: {
          credentialType: body.credentialType,
        },
        request,
      });

      return reply.status(200).send({
        success: true,
        credentialType: body.credentialType,
        credentialValue: finalCredentialValue,
      });
    },
  );
}
