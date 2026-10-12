import type { FastifyInstance } from 'fastify';
import { registerKotSendRoutes } from './send.js';
import { registerKotStatusRoutes } from './status.js';
import { registerKotListRoutes } from './list.js';

export async function registerKotRoutes(app: FastifyInstance): Promise<void> {
  await registerKotSendRoutes(app);
  await registerKotStatusRoutes(app);
  await registerKotListRoutes(app);
}
