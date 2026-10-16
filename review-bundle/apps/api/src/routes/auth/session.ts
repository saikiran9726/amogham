import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { AppError } from '@restaurant-os/shared';
import { forSystem } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { refreshTokens } from '../../db/schema/refresh-tokens.js';
import { hashToken } from '../../auth/crypto.js';
import { authenticate, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { isOriginAllowed } from '../../config/cors.js';
import { invalidateUserSessionCache } from '../../auth/token-cache.js';
import { disconnectUserSockets } from '../../realtime/socket.js';
import { getUserPermissions } from './permissions.js';
import { COOKIE_NAME } from './login.js';

export async function registerAuthSessionRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({ method: 'POST', url: '/auth/logout', isPublic: true });
  registerRouteGuard({
    method: 'POST',
    url: '/auth/logout-all',
    isPublic: false,
    permission: 'authenticated',
  });
  registerRouteGuard({ method: 'GET', url: '/me', isPublic: false, permission: 'authenticated' });

  /**
   * POST /auth/logout - Revoke refresh token & clear cookie
   */
  app.post('/auth/logout', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      throw AppError.forbidden('CORS origin not allowed');
    }

    const rawToken = request.cookies[COOKIE_NAME];
    if (rawToken) {
      const hashed = hashToken(rawToken);
      const system = forSystem();
      const [tokenRow] = await system.db
        .select({ id: refreshTokens.id, userId: refreshTokens.userId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashed))
        .limit(1);

      if (tokenRow) {
        await system.db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.id, tokenRow.id));

        const [u] = await system.db
          .select({ restaurantId: users.restaurantId })
          .from(users)
          .where(eq(users.id, tokenRow.userId))
          .limit(1);

        if (u) {
          await recordAuditLog({
            restaurantId: u.restaurantId,
            userId: tokenRow.userId,
            action: 'auth.logout',
            entity: 'user',
            entityId: tokenRow.userId,
            request,
          });
        }
        disconnectUserSockets(tokenRow.userId, 'User logged out');
      }
    }

    reply.clearCookie(COOKIE_NAME, { path: '/auth' });
    return reply.status(200).send({ success: true });
  });

  /**
   * POST /auth/logout-all - Invalidate all active sessions for current user
   */
  app.post('/auth/logout-all', { preHandler: [authenticate] }, async (request, reply) => {
    const authUser = request.user!;
    const system = forSystem();

    await system.withTx(async (tx) => {
      // 1. Atomically bump user's token_version
      await tx
        .update(users)
        .set({
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, authUser.userId));

      // 2. Revoke all active refresh tokens for the user
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, authUser.userId), isNull(refreshTokens.revokedAt)));

      // 3. Audit log
      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'auth.logout_all',
        entity: 'user',
        entityId: authUser.userId,
        request,
      });
    });

    // Invalidate memory cache cleanly after transaction commit
    invalidateUserSessionCache(authUser.restaurantId, authUser.userId);
    disconnectUserSockets(authUser.userId, 'User logged out from all sessions');

    reply.clearCookie(COOKIE_NAME, { path: '/auth' });
    return reply.status(200).send({ success: true });
  });

  /**
   * GET /me - Current authenticated user session details
   */
  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const authUser = request.user!;
    const system = forSystem();

    const [user] = await system.db
      .select({
        id: users.id,
        restaurantId: users.restaurantId,
        name: users.name,
        username: users.username,
        active: users.active,
        roleId: users.roleId,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.id, authUser.userId))
      .limit(1);

    if (!user || !user.active) {
      throw AppError.unauthorized('User not found or deactivated');
    }

    const currentPermissions = await getUserPermissions(user.roleId);

    return reply.status(200).send({
      id: user.id,
      restaurantId: user.restaurantId,
      name: user.name,
      username: user.username,
      role: authUser.role,
      active: user.active,
      permissions: currentPermissions,
      lastLoginAt: user.lastLoginAt,
    });
  });
}
