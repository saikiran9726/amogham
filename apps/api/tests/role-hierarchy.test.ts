import { describe, it, expect } from 'vitest';
import { Roles, type RoleName } from '@restaurant-os/shared';
import {
  ROLE_HIERARCHY,
  getRoleRank,
  isStrictlyLowerRank,
  canActorManageTargetRole,
  canActorCreateRole,
  canActorPromoteRole,
} from '../src/auth/role-hierarchy.js';

describe('Role Hierarchy & Matrix Enforcement', () => {
  const ALL_ROLES: RoleName[] = [
    Roles.OWNER,
    Roles.MANAGER,
    Roles.CASHIER,
    Roles.WAITER,
    Roles.KITCHEN,
  ];

  it('verifies numeric rank order OWNER > MANAGER > CASHIER > WAITER = KITCHEN', () => {
    expect(getRoleRank(Roles.OWNER)).toBe(4);
    expect(getRoleRank(Roles.MANAGER)).toBe(3);
    expect(getRoleRank(Roles.CASHIER)).toBe(2);
    expect(getRoleRank(Roles.WAITER)).toBe(1);
    expect(getRoleRank(Roles.KITCHEN)).toBe(1);

    expect(getRoleRank(Roles.OWNER)).toBeGreaterThan(getRoleRank(Roles.MANAGER));
    expect(getRoleRank(Roles.MANAGER)).toBeGreaterThan(getRoleRank(Roles.CASHIER));
    expect(getRoleRank(Roles.CASHIER)).toBeGreaterThan(getRoleRank(Roles.WAITER));
    expect(getRoleRank(Roles.WAITER)).toBe(getRoleRank(Roles.KITCHEN));
  });

  describe('Full 5x5 Actor-Role x Target-Role Matrix: canActorManageTargetRole', () => {
    // Expected management permissions: Actor may manage only users of strictly lower rank
    // Target:     OWNER   MANAGER CASHIER WAITER  KITCHEN
    // OWNER       false   true    true    true    true
    // MANAGER     false   false   true    true    true
    // CASHIER     false   false   false   true    true
    // WAITER      false   false   false   false   false
    // KITCHEN     false   false   false   false   false
    const expectedManageMatrix: Record<RoleName, Record<RoleName, boolean>> = {
      [Roles.OWNER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: true,
        [Roles.CASHIER]: true,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.MANAGER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: true,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.CASHIER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.WAITER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: false,
        [Roles.KITCHEN]: false,
      },
      [Roles.KITCHEN]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: false,
        [Roles.KITCHEN]: false,
      },
    };

    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        const expected = expectedManageMatrix[actor][target];
        it(`actor ${actor} -> target ${target} should be ${expected}`, () => {
          expect(canActorManageTargetRole(actor, target)).toBe(expected);
          expect(isStrictlyLowerRank(actor, target)).toBe(expected);
        });
      }
    }
  });

  describe('Full 5x5 Actor-Role x Target-Role Matrix: canActorCreateRole', () => {
    // Only OWNER can create OWNER or MANAGER; otherwise strictly lower rank
    // Target:     OWNER   MANAGER CASHIER WAITER  KITCHEN
    // OWNER       true    true    true    true    true
    // MANAGER     false   false   true    true    true
    // CASHIER     false   false   false   true    true
    // WAITER      false   false   false   false   false
    // KITCHEN     false   false   false   false   false
    const expectedCreateMatrix: Record<RoleName, Record<RoleName, boolean>> = {
      [Roles.OWNER]: {
        [Roles.OWNER]: true,
        [Roles.MANAGER]: true,
        [Roles.CASHIER]: true,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.MANAGER]: {
        [Roles.OWNER]: false, // GATE: manager cannot create OWNER
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: true,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.CASHIER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: true,
        [Roles.KITCHEN]: true,
      },
      [Roles.WAITER]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: false,
        [Roles.KITCHEN]: false,
      },
      [Roles.KITCHEN]: {
        [Roles.OWNER]: false,
        [Roles.MANAGER]: false,
        [Roles.CASHIER]: false,
        [Roles.WAITER]: false,
        [Roles.KITCHEN]: false,
      },
    };

    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        const expected = expectedCreateMatrix[actor][target];
        it(`actor ${actor} creating ${target} should be ${expected}`, () => {
          expect(canActorCreateRole(actor, target)).toBe(expected);
        });
      }
    }
  });

  describe('Role Promotions: canActorPromoteRole', () => {
    it('GATE: manager cannot promote a user to OWNER', () => {
      expect(canActorPromoteRole(Roles.MANAGER, Roles.CASHIER, Roles.OWNER)).toBe(false);
      expect(canActorPromoteRole(Roles.MANAGER, Roles.WAITER, Roles.OWNER)).toBe(false);
    });

    it('GATE: manager cannot promote a user to MANAGER', () => {
      expect(canActorPromoteRole(Roles.MANAGER, Roles.CASHIER, Roles.MANAGER)).toBe(false);
      expect(canActorPromoteRole(Roles.MANAGER, Roles.WAITER, Roles.MANAGER)).toBe(false);
    });

    it('owner can promote lower roles to MANAGER or OWNER', () => {
      expect(canActorPromoteRole(Roles.OWNER, Roles.CASHIER, Roles.MANAGER)).toBe(true);
      expect(canActorPromoteRole(Roles.OWNER, Roles.MANAGER, Roles.OWNER)).toBe(true);
      expect(canActorPromoteRole(Roles.OWNER, Roles.WAITER, Roles.CASHIER)).toBe(true);
    });

    it('manager can promote WAITER to CASHIER', () => {
      expect(canActorPromoteRole(Roles.MANAGER, Roles.WAITER, Roles.CASHIER)).toBe(true);
      expect(canActorPromoteRole(Roles.MANAGER, Roles.KITCHEN, Roles.CASHIER)).toBe(true);
    });

    it('cashier cannot promote WAITER to CASHIER or above', () => {
      expect(canActorPromoteRole(Roles.CASHIER, Roles.WAITER, Roles.CASHIER)).toBe(false);
      expect(canActorPromoteRole(Roles.CASHIER, Roles.WAITER, Roles.MANAGER)).toBe(false);
    });
  });
});
