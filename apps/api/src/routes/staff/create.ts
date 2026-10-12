import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  Permissions,
  Roles,
  AppError,
  generateUuidV7,
  staffCreateSchema,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import { hashPassword, hashPin } from '../../auth/crypto.js';
import { canActorCreateRole } from '../../auth/role-hierarchy.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerStaffCreateRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/staff',
    isPublic: false,
    permission: Permissions.STAFF_MANAGE,
  });

  /**
   * POST /staff - Create new staff member
   */
  app.post(
    '/staff',
    { preHandler: [requirePermission(Permissions.STAFF_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = staffCreateSchema.parse(request.body);

      // Enforce role hierarchy on creation
      if (!canActorCreateRole(authUser.role, body.role)) {
        if (body.role === Roles.OWNER || body.role === Roles.MANAGER) {
          throw AppError.forbidden('Only an owner may create an OWNER or MANAGER');
        }
        throw AppError.forbidden(
          `Cannot create staff with role '${body.role}' (requires strictly higher rank)`,
        );
      }

      // Check if username already taken
      const [existing] = await tenant.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username))
        .limit(1);

      if (existing) {
        throw AppError.conflict(`Username '${body.username}' is already taken`);
      }

      // Find role by name
      const [roleRow] = await tenant.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, body.role))
        .limit(1);

      if (!roleRow) {
        throw AppError.badRequest(`Role '${body.role}' not found`);
      }

      // Hash credentials
      let passwordHash: string | null = null;
      let pinHash: string | null = null;

      if (body.credentialType === 'password' && body.password) {
        passwordHash = await hashPassword(body.password);
      } else if (body.credentialType === 'pin' && body.pin) {
        pinHash = await hashPin(body.pin);
      }

      const newUserId = generateUuidV7();

      const [created] = await tenant.db
        .insert(users)
        .values({
          id: newUserId,
          restaurantId: authUser.restaurantId,
          roleId: roleRow.id,
          name: body.name,
          username: body.username,
          passwordHash,
          pinHash,
          active: true,
          failedAttempts: 0,
        })
        .returning({
          id: users.id,
          name: users.name,
          username: users.username,
          active: users.active,
          createdAt: users.createdAt,
        });

      if (!created) {
        throw AppError.internal('Failed to create staff member');
      }

      // Audit log
      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'staff.create',
        entity: 'user',
        entityId: created.id,
        before: null,
        after: {
          name: created.name,
          username: created.username,
          role: body.role,
        },
        request,
      });

      return reply.status(201).send({
        id: created.id,
        name: created.name,
        username: created.username,
        role: body.role,
        active: created.active,
        createdAt: created.createdAt,
        // The one-time credential confirmation
        credential: {
          type: body.credentialType,
          value: body.credentialType === 'password' ? body.password : body.pin,
        },
      });
    },
  );
}
