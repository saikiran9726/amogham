import { eq } from 'drizzle-orm';
import { forSystem } from '../../db/tenant.js';
import { rolePermissions } from '../../db/schema/role-permissions.js';
import { permissions } from '../../db/schema/permissions.js';

export async function getUserPermissions(roleId: string | null): Promise<string[]> {
  if (!roleId) return [];

  const system = forSystem();
  const rows = await system.db
    .select({ name: permissions.name })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  return rows.map((r) => r.name);
}
