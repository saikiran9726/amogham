import type { FastifyInstance } from 'fastify';
import { registerInventoryItemRoutes } from './items.js';
import { registerInventoryPurchaseRoutes } from './purchases.js';

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  await registerInventoryItemRoutes(app);
  await registerInventoryPurchaseRoutes(app);
}
