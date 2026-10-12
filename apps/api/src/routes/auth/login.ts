import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Roles, loginRequestSchema, AppError, generateUuidV7 } from '@restaurant-os/shared';
import { forSystem } from '../../db/tenant.js';
import { users } from '../../db/schema/users.js';
import { roles } from '../../db/schema/roles.js';
import { refreshTokens } from '../../db/schema/refresh-tokens.js';
import {
  verifyPassword,
  verifyPin,
  generateRandomToken,
  hashToken,
  verifyDummyCredential,
} from '../../auth/crypto.js';
import { signAccessToken } from '../../auth/jwt.js';
import { isAccountLocked, recordFailedAttemptAtomic, resetLockoutAtomic } from '../../auth/lockout.js';
import { registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import { checkLoginIpUsernameRateLimit } from '../../plugins/rate-limit.js';
import { env } from '../../config/env.js';
import { MetricsService } from '../../services/metrics.js';
import { getUserPermissions } from './permissions.js';

export const COOKIE_NAME = 'restaurant_os_refresh_token';

export async function registerAuthLoginRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({ method: 'POST', url: '/auth/login', isPublic: true });

  /**
   * POST /auth/login - Authenticate via Password or PIN
   */
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const body = loginRequestSchema.parse(request.body);
      const system = forSystem();

      // Route-specific rate limit: 5 req/min per IP + username
      await checkLoginIpUsernameRateLimit(request.ip, body.username);

      // 1. Fetch user by username joined with role
      const [user] = await system.db
        .select({
          id: users.id,
          restaurantId: users.restaurantId,
          roleId: users.roleId,
          roleName: roles.name,
          name: users.name,
          username: users.username,
          passwordHash: users.passwordHash,
          pinHash: users.pinHash,
          active: users.active,
          tokenVersion: users.tokenVersion,
          failedAttempts: users.failedAttempts,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.username, body.username))
        .limit(1);

      // Constant-time generic error to prevent user enumeration
      const genericAuthError = () => AppError.unauthorized('Invalid username or credential');

      if (!user || !user.active) {
        // Run constant-time dummy Argon2 verification to defeat response timing attacks
        await verifyDummyCredential(body.password || body.pin || 'dummy_credential');

        if (user && !user.active) {
          await recordAuditLog({
            restaurantId: user.restaurantId,
            userId: user.id,
            action: 'auth.login_failure',
            entity: 'user',
            entityId: user.id,
            after: { failureReason: 'user_inactive' },
            request,
          });
        }
        throw genericAuthError();
      }

      // 2. Check if account is currently locked out
      if (isAccountLocked(user)) {
        await verifyDummyCredential(body.password || body.pin || 'dummy_credential');

        await recordAuditLog({
          restaurantId: user.restaurantId,
          userId: user.id,
          action: 'auth.login_locked',
          entity: 'user',
          entityId: user.id,
          after: { failureReason: 'account_locked', lockedUntil: user.lockedUntil },
          request,
        });

        throw genericAuthError();
      }

      // 3. Verify role configuration & policy
      const userRole = user.roleName || Roles.WAITER;
      if (
        body.credentialType === 'pin' &&
        (userRole === Roles.OWNER || userRole === Roles.MANAGER)
      ) {
        await verifyDummyCredential(body.pin || 'dummy_credential');
        await recordAuditLog({
          restaurantId: user.restaurantId,
          userId: user.id,
          action: 'auth.login_failure',
          entity: 'user',
          entityId: user.id,
          after: { failureReason: 'pin_login_disallowed_for_role' },
          request,
        });
        throw genericAuthError();
      }

      // 4. Verify Credentials
      let isValid = false;
      if (body.credentialType === 'password') {
        if (user.passwordHash && body.password) {
          isValid = await verifyPassword({ hash: user.passwordHash, secret: body.password });
        } else {
          await verifyDummyCredential(body.password || 'dummy_credential');
        }
      } else if (body.credentialType === 'pin') {
        if (user.pinHash && body.pin) {
          isValid = await verifyPin({ hash: user.pinHash, secret: body.pin });
        } else {
          await verifyDummyCredential(body.pin || 'dummy_credential');
        }
      }

      // 5. Handle failed authentication atomically
      if (!isValid) {
        const lockoutState = await recordFailedAttemptAtomic(system.db, user.id);
        if (lockoutState.lockedUntil) {
          MetricsService.incrementLockout(user.restaurantId);
        }

        await recordAuditLog({
          restaurantId: user.restaurantId,
          userId: user.id,
          action: lockoutState.lockedUntil ? 'auth.login_locked' : 'auth.login_failure',
          entity: 'user',
          entityId: user.id,
          after: {
            failureReason: 'invalid_credential',
            failedAttempts: lockoutState.failedAttempts,
            locked: Boolean(lockoutState.lockedUntil),
          },
          request,
        });

        throw genericAuthError();
      }

      // 6. Successful login: atomically reset failed attempts & record lastLoginAt
      await resetLockoutAtomic(system.db, user.id);

      // 7. Fetch permissions
      const roleName = userRole;
      const userPermissions = await getUserPermissions(user.roleId);

      // 8. Issue short-lived access token (15 mins) with tokenVersion claim
      const accessToken = signAccessToken({
        userId: user.id,
        restaurantId: user.restaurantId,
        username: user.username,
        name: user.name,
        role: roleName,
        permissions: userPermissions,
        tv: user.tokenVersion ?? 0,
      });

      // 9. Issue and rotate refresh token (stored as SHA-256 hash in DB)
      const rawRefreshToken = generateRandomToken();
      const tokenHash = hashToken(rawRefreshToken);
      const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
      const tokenId = generateUuidV7();

      await system.db.insert(refreshTokens).values({
        id: tokenId,
        userId: user.id,
        familyId: tokenId,
        tokenHash,
        deviceLabel: body.deviceLabel || request.headers['user-agent'] || null,
        expiresAt,
      });

      // Set secure, httpOnly cookie for refresh token
      reply.setCookie(COOKIE_NAME, rawRefreshToken, {
        path: '/auth',
        httpOnly: true,
        secure: env.COOKIE_SECURE || env.NODE_ENV === 'production',
        sameSite: env.COOKIE_SAMESITE,
        expires: expiresAt,
      });

      // Record login audit log
      await recordAuditLog({
        restaurantId: user.restaurantId,
        userId: user.id,
        action: 'auth.login_success',
        entity: 'user',
        entityId: user.id,
        request,
      });

      return reply.status(200).send({
        user: {
          id: user.id,
          restaurantId: user.restaurantId,
          name: user.name,
          username: user.username,
          role: roleName,
          active: user.active,
          permissions: userPermissions,
          lastLoginAt: new Date(),
        },
        accessToken,
      });
    },
  );
}
