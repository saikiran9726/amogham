import { Roles } from '@restaurant-os/shared';

/**
 * Role hierarchy ranking:
 * OWNER (4) > MANAGER (3) > CASHIER (2) > WAITER (1) = KITCHEN (1)
 */
export const ROLE_HIERARCHY: Record<string, number> = {
  [Roles.OWNER]: 4,
  [Roles.MANAGER]: 3,
  [Roles.CASHIER]: 2,
  [Roles.WAITER]: 1,
  [Roles.KITCHEN]: 1,
};

/**
 * Returns the numeric rank of a given role.
 * Defaults to 0 for unknown roles.
 */
export function getRoleRank(role: string): number {
  return ROLE_HIERARCHY[role] ?? 0;
}

/**
 * Checks if targetRole is of strictly lower rank than actorRole.
 * OWNER (4) > MANAGER (3) > CASHIER (2) > WAITER (1) = KITCHEN (1)
 */
export function isStrictlyLowerRank(actorRole: string, targetRole: string): boolean {
  return getRoleRank(actorRole) > getRoleRank(targetRole);
}

/**
 * Checks whether an actor can manage (update/deactivate/reset credential) a target user
 * based on role hierarchy.
 *
 * Rule: Actor may manage only users of strictly lower rank.
 * (e.g. MANAGER cannot manage MANAGER or OWNER; CASHIER cannot manage CASHIER).
 */
export function canActorManageTargetRole(actorRole: string, targetRole: string): boolean {
  return isStrictlyLowerRank(actorRole, targetRole);
}

/**
 * Checks whether an actor can create a user with the specified role.
 *
 * Rules:
 * - Only OWNER may create an OWNER or MANAGER.
 * - Actor may create only users of strictly lower rank.
 */
export function canActorCreateRole(actorRole: string, newRole: string): boolean {
  if (newRole === Roles.OWNER || newRole === Roles.MANAGER) {
    return actorRole === Roles.OWNER;
  }
  return isStrictlyLowerRank(actorRole, newRole);
}

/**
 * Checks whether an actor can promote an existing user to a new role.
 *
 * Rules:
 * - Target's current role must be manageable by actor (strictly lower rank).
 * - Only OWNER may create or promote an OWNER or MANAGER.
 * - New role must be of strictly lower rank than actor (unless actor is OWNER).
 */
export function canActorPromoteRole(
  actorRole: string,
  targetCurrentRole: string,
  targetNewRole: string,
): boolean {
  // Actor must have authority over current role
  if (!isStrictlyLowerRank(actorRole, targetCurrentRole)) {
    return false;
  }

  // Only OWNER may promote to OWNER or MANAGER
  if (targetNewRole === Roles.OWNER || targetNewRole === Roles.MANAGER) {
    return actorRole === Roles.OWNER;
  }

  // Target new role must be strictly lower rank than actor
  return isStrictlyLowerRank(actorRole, targetNewRole);
}
