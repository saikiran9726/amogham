import { eq, and, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AppError, Roles } from '@restaurant-os/shared';
import { env } from '../config/env.js';
import { users } from '../db/schema/users.js';
import { roles } from '../db/schema/roles.js';
import { verifyPin } from './crypto.js';
import { isAccountLocked } from './lockout.js';
import { recordAuditLog, type DbOrTx } from '../services/audit.js';
import { checkApprovalRateLimit } from '../plugins/rate-limit.js';

export interface VerifyApproverPinParams {
  restaurantId: string;
  approverUserId: string;
  pin: string;
  allowedRoles?: readonly string[];
  reason?: string;
  entity: string;
  entityId?: string;
  actorUserId: string;
  request?: FastifyRequest;
}

export interface ApproverVerificationResult {
  approverId: string;
  approverName: string;
  role: string;
}

/**
 * Validates and authorizes an action via approver PIN.
 *
 * Enforces:
 * 1. Approver exists in the same restaurant, is active, and possesses an authorized role (default OWNER, MANAGER).
 * 2. Approver is not currently locked out.
 * 3. Atomic counter increment and lockout on wrong PIN.
 * 4. Lockout reset on valid PIN.
 * 5. Security audit logging for both approval.success and approval.failure.
 */
export async function verifyApproverPin(
  tx: DbOrTx,
  params: VerifyApproverPinParams,
): Promise<ApproverVerificationResult> {
  const {
    restaurantId,
    approverUserId,
    pin,
    allowedRoles = [Roles.OWNER, Roles.MANAGER],
    reason,
    entity,
    entityId,
    actorUserId,
    request,
  } = params;

  if (!approverUserId || !pin) {
    throw AppError.forbidden('Approver user ID and PIN are required for authorization');
  }

  // 0. Enforce approval rate limit: 10/min per user
  await checkApprovalRateLimit(actorUserId);

  // 1. Load approver user within the caller's restaurant
  const [approver] = await tx
    .select({
      id: users.id,
      name: users.name,
      restaurantId: users.restaurantId,
      roleId: users.roleId,
      roleName: roles.name,
      active: users.active,
      pinHash: users.pinHash,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, approverUserId), eq(users.restaurantId, restaurantId)))
    .limit(1);

  if (!approver || !approver.active) {
    await recordAuditLog({
      restaurantId,
      userId: actorUserId,
      action: 'approval.failure',
      entity,
      entityId: entityId || approverUserId,
      after: {
        actorUserId,
        approverUserId,
        reason,
        failureReason: 'approver_not_found_or_inactive',
      },
      request,
    });
    throw AppError.forbidden('Approver not found or inactive');
  }

  // 2. Verify approver role is in allowedRoles
  if (!allowedRoles.includes(approver.roleName)) {
    await recordAuditLog({
      restaurantId,
      userId: actorUserId,
      action: 'approval.failure',
      entity,
      entityId: entityId || approver.id,
      after: {
        actorUserId,
        approverUserId,
        approverRole: approver.roleName,
        allowedRoles,
        reason,
        failureReason: 'role_not_allowed',
      },
      request,
    });
    throw AppError.forbidden(
      `Approver role "${approver.roleName}" is not authorized for this action`,
    );
  }

  // 3. Verify approver has a configured PIN
  if (!approver.pinHash) {
    await recordAuditLog({
      restaurantId,
      userId: actorUserId,
      action: 'approval.failure',
      entity,
      entityId: entityId || approver.id,
      after: {
        actorUserId,
        approverUserId,
        reason,
        failureReason: 'no_pin_configured',
      },
      request,
    });
    throw AppError.forbidden('Approver does not have a PIN configured');
  }

  // 4. Lockout check
  if (
    isAccountLocked({ failedAttempts: approver.failedAttempts, lockedUntil: approver.lockedUntil })
  ) {
    await recordAuditLog({
      restaurantId,
      userId: actorUserId,
      action: 'approval.failure',
      entity,
      entityId: entityId || approver.id,
      after: {
        actorUserId,
        approverUserId,
        reason,
        failureReason: 'account_locked',
        lockedUntil: approver.lockedUntil,
      },
      request,
    });
    throw AppError.unauthorized(
      'Approver account is temporarily locked due to too many failed attempts.',
    );
  }

  // 5. Verify PIN with Argon2id using named params { hash, secret }
  const isValid = await verifyPin({
    hash: approver.pinHash,
    secret: pin,
  });

  // 6. Handle failure: atomic increment and conditional lockout
  if (!isValid) {
    const [updated] = await tx
      .update(users)
      .set({
        failedAttempts: sql`${users.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${users.failedAttempts} + 1 >= ${env.MAX_FAILED_LOGIN_ATTEMPTS} THEN NOW() + (${env.LOCKOUT_DURATION_MINUTES} || ' minutes')::interval ELSE NULL END`,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, approver.id), eq(users.restaurantId, restaurantId)))
      .returning({
        failedAttempts: users.failedAttempts,
        lockedUntil: users.lockedUntil,
      });

    await recordAuditLog({
      restaurantId,
      userId: actorUserId,
      action: 'approval.failure',
      entity,
      entityId: entityId || approver.id,
      after: {
        actorUserId,
        approverUserId,
        reason,
        failureReason: 'invalid_pin',
        failedAttempts: updated?.failedAttempts,
        locked: Boolean(updated?.lockedUntil),
      },
      request,
    });

    if (updated?.lockedUntil) {
      throw AppError.unauthorized(
        'Approver account is temporarily locked due to too many failed attempts.',
      );
    }

    throw AppError.forbidden('Invalid approver PIN');
  }

  // 7. Successful approval: reset failed attempts & lockout
  await tx
    .update(users)
    .set({
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, approver.id), eq(users.restaurantId, restaurantId)));

  await recordAuditLog({
    restaurantId,
    userId: actorUserId,
    action: 'approval.success',
    entity,
    entityId: entityId || approver.id,
    after: {
      actorUserId,
      approverUserId,
      approverRole: approver.roleName,
      reason,
    },
    request,
  });

  return {
    approverId: approver.id,
    approverName: approver.name,
    role: approver.roleName,
  };
}
