import type { FastifyInstance } from 'fastify';
import { registerOrderMutateRoutes } from './mutate.js';
import { registerOrderQueryRoutes } from './query.js';
import { registerOrderRecentRoutes } from './recent.js';

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {
  await registerOrderMutateRoutes(app);
  await registerOrderQueryRoutes(app);
  await registerOrderRecentRoutes(app);
}
