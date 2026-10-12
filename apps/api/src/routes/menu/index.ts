import type { FastifyInstance } from 'fastify';
import { registerMenuQueryRoutes } from './query.js';
import { registerMenuItemRoutes } from './items.js';
import { registerMenuBulkRoutes } from './bulk.js';
import { registerMenuSampleRoutes } from './sample.js';

export async function registerMenuRoutes(app: FastifyInstance): Promise<void> {
  await registerMenuQueryRoutes(app);
  await registerMenuItemRoutes(app);
  await registerMenuBulkRoutes(app);
  await registerMenuSampleRoutes(app);
}
