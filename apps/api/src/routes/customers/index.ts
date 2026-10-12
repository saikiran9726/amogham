import type { FastifyInstance } from 'fastify';
import { registerCustomerLookupRoutes } from './lookup.js';
import { registerCustomerManageRoutes } from './manage.js';

export async function registerCustomerRoutes(app: FastifyInstance): Promise<void> {
  await registerCustomerLookupRoutes(app);
  await registerCustomerManageRoutes(app);
}
