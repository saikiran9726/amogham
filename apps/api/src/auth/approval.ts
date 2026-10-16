import { eq, and, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AppError, Roles } from '@restaurant-os/shared';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { users } from '../db/schema/users.js';
import { roles } from '../db/schema/roles.js';
import { verifyPin, verifyDummyCredential } from './crypto.js';
import { isAccountLocked } from './lockout.js';
import { recordAuditLog, type DbOrTx } from '../services/audit.js';
import { checkApprovalRateLimit } from '../plugins/rate-limit.js';

export interface AuthorizeApproverParams {
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

export type VerifyApproverPinParams = AuthorizeApproverParams;

export interface ApproverVerificationResult {
  approverId: string;
  approverName: string;
  role: string;
}

export interface RecordApprovalUseParams {
  restaurantId: string;
  approver: ApproverVerificationResult;
  entity: string;
  entityId?: string;
  actorUserId: string;
  reason?: string;
  action?: string;
  request?: FastifyRequest;
}

/**
 * Validates and authorizes an approver outside of business transactions.
 * Executes against the root DB pool so failure counters, lockouts, and audit
 * logs persist even if the calling business transaction later rolls back.
 *
 * Anti-enumeration protections:
 * 1. Constant-time dummy Argon2id verification for all invalid user/role/lockout states.
 * 2. Identical forbidden error messages and status codes across failure modes.
 */
export async function authorizeApprover(
  dbClient: DbOrTx = db,
  params: AuthorizeApproverParams,
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
    throw AppError.forbidden('Invalid approver credentials or authorization denied');
  }

  // 0. Enforce approval rate limit: 10/min per actor user
  await checkApprovalRateLimit(actorUserId);

  // 1. Load approver user within the caller's restaurant
  const [approver] = await dbClient
    .select({
      id: users.id,
      name: users.name,
      restaurantId: users.restaurantId,
      roleId: users.roleId,
      roleName: roles.name,
      active: users.active,
      pinHash: users.pinHash,
      pinFailedAttempts: users.pinFailedAttempts,
      pinLockedUntil: users.pinLockedUntil,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, approverUserId), eq(users.restaurantId, restaurantId)))
    .limit(1);

  if (!approver || !approver.active) {
    await verifyDummyCredential(pin);
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
    throw AppError.forbidden('Invalid approver credentials or authorization denied');
  }

  // 2. Verify approver role is in allowedRoles
  if (!allowedRoles.includes(approver.roleName)) {
    await verifyDummyCredential(pin);
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
    throw AppError.forbidden('Invalid approver credentials or authorization denied');
  }

  // 3. Verify approver has a configured PIN
  if (!approver.pinHash) {
    await verifyDummyCredential(pin);
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
    throw AppError.forbidden('Invalid approver credentials or authorization denied');
  }

  // 4. Check approver PIN lockout
  const rawLockedUntil = approver.pinLockedUntil ?? approver.lockedUntil;
  const lockedUntil = rawLockedUntil ? new Date(rawLockedUntil) : null;
  const rawFailedAttempts = approver.pinFailedAttempts ?? approver.failedAttempts ?? 0;
  const isLocked = isAccountLocked({
    failedAttempts: rawFailedAttempts,
    lockedUntil,
  });

  if (isLocked) {
    await verifyDummyCredential(pin);
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
        lockedUntil,
      },
      request,
    });
    throw AppError.unauthorized(
      'Approver account is temporarily locked due to too many failed attempts.',
    );
  }

  // 5. Verify PIN with Argon2id
  const isValid = await verifyPin({
    hash: approver.pinHash,
    secret: pin,
  });

  // 6. Handle failure: atomic increment of pin_failed_attempts and conditional pin_locked_until
  if (!isValid) {
    const [updated] = await dbClient
      .update(users)
      .set({
        pinFailedAttempts: sql`${users.pinFailedAttempts} + 1`,
        pinLockedUntil: sql`CASE WHEN ${users.pinFailedAttempts} + 1 >= ${env.MAX_FAILED_LOGIN_ATTEMPTS} THEN NOW() + (${env.LOCKOUT_DURATION_MINUTES} || ' minutes')::interval ELSE NULL END`,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, approver.id), eq(users.restaurantId, restaurantId)))
      .returning({
        pinFailedAttempts: users.pinFailedAttempts,
        pinLockedUntil: users.pinLockedUntil,
        failedAttempts: users.failedAttempts,
        lockedUntil: users.lockedUntil,
      });

    const updatedAttempts = updated?.pinFailedAttempts ?? updated?.failedAttempts;
    const updatedLockedUntil = updated?.pinLockedUntil ?? updated?.lockedUntil;
    const isNowLocked = Boolean(
      updatedLockedUntil && new Date(updatedLockedUntil).getTime() > Date.now(),
    );

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
        failedAttempts: updatedAttempts,
        locked: isNowLocked,
      },
      request,
    });

    if (isNowLocked) {
      throw AppError.unauthorized(
        'Approver account is temporarily locked due to too many failed attempts.',
      );
    }

    throw AppError.forbidden('Invalid approver credentials or authorization denied');
  }

  // 7. Successful approver validation: reset failed attempts & lockout outside transaction
  await dbClient
    .update(users)
    .set({
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, approver.id), eq(users.restaurantId, restaurantId)));

  return {
    approverId: approver.id,
    approverName: approver.name,
    role: approver.roleName,
  };
}

/**
 * Records an approval.success audit log inside an active business transaction.
 */
export async function recordApprovalUse(
  tx: DbOrTx,
  params: RecordApprovalUseParams,
): Promise<void> {
  const {
    restaurantId,
    approver,
    entity,
    entityId,
    actorUserId,
    reason,
    action = 'approval.success',
    request,
  } = params;

  await recordAuditLog({
    restaurantId,
    userId: actorUserId,
    action,
    entity,
    entityId: entityId || approver.approverId,
    after: {
      actorUserId,
      approverUserId: approver.approverId,
      approverRole: approver.role,
      reason,
    },
    request,
    tx,
  });
}

/**
 * Backward-compatible helper that delegates validation to authorizeApprover (outside tx)
 * and records approval use via recordApprovalUse (inside tx).
 */
export async function verifyApproverPin(
  tx: DbOrTx,
  params: VerifyApproverPinParams,
): Promise<ApproverVerificationResult> {
  // Authorize against root pool db to persist counters regardless of caller transaction outcome
  const approver = await authorizeApprover(db, params);
  await recordApprovalUse(tx, {
    restaurantId: params.restaurantId,
    approver,
    entity: params.entity,
    entityId: params.entityId,
    actorUserId: params.actorUserId,
    reason: params.reason,
    request: params.request,
  });
  return approver;
}
