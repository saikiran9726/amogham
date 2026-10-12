import type { FastifyInstance } from 'fastify';
import { registerStaffListRoutes } from './list.js';
import { registerStaffMutateRoutes } from './mutate.js';

export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  await registerStaffListRoutes(app);
  await registerStaffMutateRoutes(app);
}
