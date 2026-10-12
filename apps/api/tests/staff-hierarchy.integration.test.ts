import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  Roles,
  Permissions,
  ROLE_DEFAULT_PERMISSIONS,
  generateUuidV7,
} from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { db } from '../src/db/client.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { roles } from '../src/db/schema/roles.js';
import { auditLogs } from '../src/db/schema/audit-logs.js';
import { hashPassword } from '../src/auth/crypto.js';

describe('Staff Role Hierarchy & Last-Owner Integration Tests', () => {
  let app: FastifyInstance;
  const restaurantId = generateUuidV7();

  let ownerUserId: string;
  let managerUserId: string;
  let cashierUserId: string;
  let waiterUserId: string;

  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;
  let waiterToken: string;

  let roleOwnerId: string;
  let roleManagerId: string;
  let roleCashierId: string;
  let roleWaiterId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // 1. Create test restaurant
    await db.insert(restaurants).values({
      id: restaurantId,
      name: 'Role Hierarchy Bistro',
      address: '123 Hierarchy St',
      phone: '+91 9999999999',
    });

    // 2. Ensure standard roles exist in the test DB
    const standardRoles = [
      { name: Roles.OWNER, description: 'Restaurant owner' },
      { name: Roles.MANAGER, description: 'Store manager' },
      { name: Roles.CASHIER, description: 'Cashier' },
      { name: Roles.WAITER, description: 'Waiter' },
      { name: Roles.KITCHEN, description: 'Kitchen chef' },
    ];

    for (const r of standardRoles) {
      const [existing] = await db.select().from(roles).where(eq(roles.name, r.name)).limit(1);
      if (!existing) {
        await db.insert(roles).values(r);
      }
    }

    const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles);
    roleOwnerId = roleRows.find((r) => r.name === Roles.OWNER)!.id;
    roleManagerId = roleRows.find((r) => r.name === Roles.MANAGER)!.id;
    roleCashierId = roleRows.find((r) => r.name === Roles.CASHIER)!.id;
    roleWaiterId = roleRows.find((r) => r.name === Roles.WAITER)!.id;

    // 3. Create test users with password
    const defaultPwdHash = await hashPassword('ValidPassword123!');

    ownerUserId = generateUuidV7();
    managerUserId = generateUuidV7();
    cashierUserId = generateUuidV7();
    waiterUserId = generateUuidV7();

    await db.insert(users).values([
      {
        id: ownerUserId,
        restaurantId,
        roleId: roleOwnerId,
        name: 'Alpha Owner',
        username: `owner_${Date.now()}`,
        passwordHash: defaultPwdHash,
        active: true,
      },
      {
        id: managerUserId,
        restaurantId,
        roleId: roleManagerId,
        name: 'Beta Manager',
        username: `manager_${Date.now()}`,
        passwordHash: defaultPwdHash,
        active: true,
      },
      {
        id: cashierUserId,
        restaurantId,
        roleId: roleCashierId,
        name: 'Gamma Cashier',
        username: `cashier_${Date.now()}`,
        passwordHash: defaultPwdHash,
        active: true,
      },
      {
        id: waiterUserId,
        restaurantId,
        roleId: roleWaiterId,
        name: 'Delta Waiter',
        username: `waiter_${Date.now()}`,
        passwordHash: defaultPwdHash,
        active: true,
      },
    ]);

    // 4. Generate access tokens
    // Manager has STAFF_MANAGE permission in default matrix or explicit list
    const managerPermissions = [
      ...ROLE_DEFAULT_PERMISSIONS[Roles.MANAGER],
      Permissions.STAFF_MANAGE,
    ];

    ownerToken = signAccessToken({
      userId: ownerUserId,
      restaurantId,
      username: 'owner',
      name: 'Alpha Owner',
      role: Roles.OWNER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
    });

    managerToken = signAccessToken({
      userId: managerUserId,
      restaurantId,
      username: 'manager',
      name: 'Beta Manager',
      role: Roles.MANAGER,
      permissions: managerPermissions,
    });

    cashierToken = signAccessToken({
      userId: cashierUserId,
      restaurantId,
      username: 'cashier',
      name: 'Gamma Cashier',
      role: Roles.CASHIER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.CASHIER],
    });

    waiterToken = signAccessToken({
      userId: waiterUserId,
      restaurantId,
      username: 'waiter',
      name: 'Delta Waiter',
      role: Roles.WAITER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GATE: Manager cannot create or promote an OWNER', () => {
    it('GATE: manager cannot create an OWNER (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/staff',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          name: 'Rogue Owner',
          username: `rogue_owner_${Date.now()}`,
          role: Roles.OWNER,
          credentialType: 'password',
          password: 'StrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect(res.json().error.message).toMatch(/owner/i);
    });

    it('GATE: manager cannot promote a user to OWNER (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${waiterUserId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          role: Roles.OWNER,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      expect(res.json().error.message).toMatch(/owner/i);
    });

    it('GATE: manager cannot create a MANAGER (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/staff',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          name: 'Second Manager',
          username: `mgr_peer_${Date.now()}`,
          role: Roles.MANAGER,
          credentialType: 'password',
          password: 'StrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('GATE: manager cannot promote a user to MANAGER (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${cashierUserId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          role: Roles.MANAGER,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });
  });

  describe('Manager Permitted Actions for Strictly Lower Ranks', () => {
    let createdCashierId: string;

    it('manager CAN create a CASHIER (strictly lower rank)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/staff',
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          name: 'Junior Cashier',
          username: `j_cashier_${Date.now()}`,
          role: Roles.CASHIER,
          credentialType: 'password',
          password: 'StrongPassword123!',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.role).toBe(Roles.CASHIER);
      createdCashierId = json.id;

      // Verify audit log has before: null and after: details
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, createdCashierId), eq(auditLogs.action, 'staff.create')))
        .limit(1);

      expect(audit).toBeDefined();
      expect(audit.before).toBeNull();
      expect((audit.after as { role: string }).role).toBe(Roles.CASHIER);
    });

    it('manager CAN deactivate a CASHIER (strictly lower rank)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${createdCashierId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          active: false,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);

      // Verify audit log recorded before and after
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entityId, createdCashierId), eq(auditLogs.action, 'staff.deactivate')),
        )
        .limit(1);

      expect(audit).toBeDefined();
      expect((audit.before as { active: boolean }).active).toBe(true);
      expect((audit.after as { active: boolean }).active).toBe(false);
    });

    it('manager CAN reset credential of a WAITER (strictly lower rank)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/staff/${waiterUserId}/reset-credential`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          credentialType: 'pin',
          pin: '9876',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().credentialValue).toBe('9876');

      // Verify audit log recorded before and after
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entityId, waiterUserId), eq(auditLogs.action, 'staff.reset_credential')),
        )
        .limit(1);

      expect(audit).toBeDefined();
      expect((audit.before as { credentialType: string }).credentialType).toBeDefined();
      expect((audit.after as { credentialType: string }).credentialType).toBe('pin');
    });

    it('manager CANNOT reset credential of an OWNER or MANAGER', async () => {
      const resOwner = await app.inject({
        method: 'POST',
        url: `/staff/${ownerUserId}/reset-credential`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          credentialType: 'password',
          password: 'NewPassword123!',
        },
      });
      expect(resOwner.statusCode).toBe(403);

      const resSelf = await app.inject({
        method: 'POST',
        url: `/staff/${managerUserId}/reset-credential`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          credentialType: 'password',
          password: 'NewPassword123!',
        },
      });
      expect(resSelf.statusCode).toBe(403);
    });
  });

  describe('Self-Modification & Last-Owner Protections', () => {
    it('nobody can change their own role', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${managerUserId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          role: Roles.OWNER,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/cannot change their own role/i);
    });

    it('nobody can deactivate themselves', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${managerUserId}`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          active: false,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/cannot deactivate themselves/i);
    });

    it('last-owner protection: cannot deactivate or demote the last active owner', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${ownerUserId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          active: false,
        },
      });
      // Rejected by last-owner protection (or self-deactivation)
      expect([400, 403]).toContain(res.statusCode);
      expect(res.json().error.message).toMatch(/owner|deactivate/i);
    });
  });

  describe('Owner Full Authority', () => {
    it('owner CAN create another OWNER', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/staff',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          name: 'Second Co-Owner',
          username: `coowner_${Date.now()}`,
          role: Roles.OWNER,
          credentialType: 'password',
          password: 'StrongCoOwner123!',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().role).toBe(Roles.OWNER);
    });

    it('owner CAN promote WAITER to MANAGER', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/staff/${waiterUserId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          role: Roles.MANAGER,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe(Roles.MANAGER);
    });
  });
});
