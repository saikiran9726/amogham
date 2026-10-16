import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';
import { AppError, generateUuidV7 } from '@restaurant-os/shared';
import { forSystem } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import { refreshTokens } from '../../db/schema/refresh-tokens.js';
import { generateRandomToken, hashToken } from '../../auth/crypto.js';
import { signAccessToken } from '../../auth/jwt.js';
import { invalidateUserSessionCache } from '../../auth/token-cache.js';
import { disconnectUserSockets } from '../../realtime/socket.js';
import { registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { env } from '../../config/env.js';
import { isOriginAllowed } from '../../config/cors.js';
import { getUserPermissions } from './permissions.js';
import { COOKIE_NAME } from './login.js';

export async function registerAuthRefreshRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({ method: 'POST', url: '/auth/refresh', isPublic: true });

  /**
   * POST /auth/refresh - Rotate refresh token & issue fresh access token
   */
  app.post(
    '/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      // Origin check against CORS allow-list
      const origin = request.headers.origin;
      if (origin && !isOriginAllowed(origin)) {
        throw AppError.forbidden('CORS origin not allowed');
      }

      const rawToken = request.cookies[COOKIE_NAME];
      if (!rawToken) {
        throw AppError.unauthorized('Refresh token missing');
      }

      const hashed = hashToken(rawToken);
      const system = forSystem();

      const result = await system.withTx(async (tx) => {
        // Single atomic query: UPDATE active, unexpired token
        const [rotated] = await tx
          .update(refreshTokens)
          .set({
            revokedAt: new Date(),
            lastUsedAt: new Date(),
          })
          .where(
            and(
              eq(refreshTokens.tokenHash, hashed),
              isNull(refreshTokens.revokedAt),
              gt(refreshTokens.expiresAt, new Date()),
            ),
          )
          .returning();

        if (rotated) {
          // Token rotation success: fetch user with current token_version
          const [user] = await tx
            .select({
              id: users.id,
              restaurantId: users.restaurantId,
              roleId: users.roleId,
              name: users.name,
              username: users.username,
              active: users.active,
              tokenVersion: users.tokenVersion,
            })
            .from(users)
            .where(eq(users.id, rotated.userId))
            .limit(1);

          if (!user || !user.active) {
            return { type: 'user_inactive' as const };
          }

          let roleName = 'WAITER';
          if (user.roleId) {
            const [roleRow] = await tx
              .select({ name: roles.name })
              .from(roles)
              .where(eq(roles.id, user.roleId))
              .limit(1);
            if (roleRow) roleName = roleRow.name;
          }
          const userPermissions = await getUserPermissions(user.roleId);

          const newTokenId = generateUuidV7();
          const newRawRefreshToken = generateRandomToken();
          const newExpiresAt = new Date(
            Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
          );

          // Create successor in the same family first to satisfy FK constraint on replaced_by
          await tx.insert(refreshTokens).values({
            id: newTokenId,
            userId: user.id,
            familyId: rotated.familyId,
            tokenHash: hashToken(newRawRefreshToken),
            deviceLabel: rotated.deviceLabel,
            expiresAt: newExpiresAt,
          });

          // Link predecessor to successor
          await tx
            .update(refreshTokens)
            .set({ replacedBy: newTokenId })
            .where(eq(refreshTokens.id, rotated.id));

          // Issue access token with up-to-date token_version
          const newAccessToken = signAccessToken({
            userId: user.id,
            restaurantId: user.restaurantId,
            username: user.username,
            name: user.name,
            role: roleName,
            permissions: userPermissions,
            tv: user.tokenVersion ?? 0,
          });

          return {
            type: 'success' as const,
            accessToken: newAccessToken,
            rawRefreshToken: newRawRefreshToken,
            expiresAt: newExpiresAt,
            user: {
              id: user.id,
              restaurantId: user.restaurantId,
              name: user.name,
              username: user.username,
              role: roleName,
              active: user.active,
              permissions: userPermissions,
            },
          };
        }

        // If not updated: lookup by token hash to differentiate revoked vs non-existent
        const [existing] = await tx
          .select({
            id: refreshTokens.id,
            userId: refreshTokens.userId,
            familyId: refreshTokens.familyId,
            replacedBy: refreshTokens.replacedBy,
            revokedAt: refreshTokens.revokedAt,
            expiresAt: refreshTokens.expiresAt,
          })
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hashed))
          .limit(1);

        if (!existing) {
          return { type: 'invalid_or_expired' as const };
        }

        // Token was already revoked
        if (existing.revokedAt) {
          const now = Date.now();
          const revokedTime = existing.revokedAt.getTime();
          const gracePeriodMs = 10_000; // 10-second grace for immediate predecessor

          if (now - revokedTime <= gracePeriodMs && existing.replacedBy) {
            // Immediate predecessor retry within 10 seconds: return successor session
            const [successor] = await tx
              .select({
                id: refreshTokens.id,
                userId: refreshTokens.userId,
                revokedAt: refreshTokens.revokedAt,
                expiresAt: refreshTokens.expiresAt,
              })
              .from(refreshTokens)
              .where(eq(refreshTokens.id, existing.replacedBy))
              .limit(1);

            if (successor && !successor.revokedAt && successor.expiresAt > new Date()) {
              const [user] = await tx
                .select({
                  id: users.id,
                  restaurantId: users.restaurantId,
                  roleId: users.roleId,
                  name: users.name,
                  username: users.username,
                  active: users.active,
                  tokenVersion: users.tokenVersion,
                })
                .from(users)
                .where(eq(users.id, successor.userId))
                .limit(1);

              if (user && user.active) {
                let roleName = 'WAITER';
                if (user.roleId) {
                  const [roleRow] = await tx
                    .select({ name: roles.name })
                    .from(roles)
                    .where(eq(roles.id, user.roleId))
                    .limit(1);
                  if (roleRow) roleName = roleRow.name;
                }
                const userPermissions = await getUserPermissions(user.roleId);

                const newAccessToken = signAccessToken({
                  userId: user.id,
                  restaurantId: user.restaurantId,
                  username: user.username,
                  name: user.name,
                  role: roleName,
                  permissions: userPermissions,
                  tv: user.tokenVersion ?? 0,
                });

                return {
                  type: 'success_grace' as const,
                  accessToken: newAccessToken,
                  user: {
                    id: user.id,
                    restaurantId: user.restaurantId,
                    name: user.name,
                    username: user.username,
                    role: roleName,
                    active: user.active,
                    permissions: userPermissions,
                  },
                };
              }
            }
          }

          // Outside grace window: token reuse detected! Revoke entire family and bump token version
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)),
            );

          const [updatedUser] = await tx
            .update(users)
            .set({
              tokenVersion: sql`${users.tokenVersion} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existing.userId))
            .returning({ restaurantId: users.restaurantId });

          return {
            type: 'reuse_detected' as const,
            familyId: existing.familyId,
            userId: existing.userId,
            tokenId: existing.id,
            revokedAt: existing.revokedAt,
            restaurantId: updatedUser?.restaurantId ?? '00000000-0000-0000-0000-000000000000',
          };
        }

        // Expired token
        return { type: 'invalid_or_expired' as const };
      });

      if (result.type === 'success') {
        reply.setCookie(COOKIE_NAME, result.rawRefreshToken, {
          path: '/auth',
          httpOnly: true,
          secure: env.COOKIE_SECURE || env.NODE_ENV === 'production',
          sameSite: env.COOKIE_SAMESITE,
          expires: result.expiresAt,
        });

        return reply.status(200).send({
          accessToken: result.accessToken,
          user: result.user,
        });
      }

      if (result.type === 'success_grace') {
        return reply.status(200).send({
          accessToken: result.accessToken,
          user: result.user,
        });
      }

      if (result.type === 'reuse_detected') {
        // Invalidate cache after transaction commit
        invalidateUserSessionCache(result.restaurantId, result.userId);
        disconnectUserSockets(result.userId, 'Refresh token reuse detected: session terminated');

        await recordAuditLog({
          restaurantId: result.restaurantId,
          userId: result.userId,
          action: 'auth.refresh_reuse_detected',
          entity: 'refresh_token',
          entityId: result.tokenId,
          after: {
            familyId: result.familyId,
            revokedAt: result.revokedAt,
          },
          request,
        });

        reply.clearCookie(COOKIE_NAME, { path: '/auth' });
        throw AppError.unauthorized('Refresh token reuse detected: session terminated');
      }

      if (result.type === 'user_inactive') {
        reply.clearCookie(COOKIE_NAME, { path: '/auth' });
        throw AppError.unauthorized('User inactive or not found');
      }

      reply.clearCookie(COOKIE_NAME, { path: '/auth' });
      throw AppError.unauthorized('Invalid or expired refresh token');
    },
  );
}
