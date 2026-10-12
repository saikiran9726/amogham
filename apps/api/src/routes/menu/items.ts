import type { FastifyInstance } from 'fastify';
import { registerMenuItemCrudRoutes } from './items-crud.js';
import { registerMenuItemOosRoutes } from './items-oos.js';

export async function registerMenuItemRoutes(app: FastifyInstance): Promise<void> {
  await registerMenuItemCrudRoutes(app);
  await registerMenuItemOosRoutes(app);
}
