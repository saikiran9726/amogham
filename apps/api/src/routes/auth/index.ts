import type { FastifyInstance } from 'fastify';
import { registerAuthLoginRoutes } from './login.js';
import { registerAuthRefreshRoutes } from './refresh.js';
import { registerAuthSessionRoutes } from './session.js';
import { getUserPermissions } from './permissions.js';

export { getUserPermissions };

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  await registerAuthLoginRoutes(app);
  await registerAuthRefreshRoutes(app);
  await registerAuthSessionRoutes(app);
}
