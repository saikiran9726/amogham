import type { FastifyInstance } from 'fastify';
import { registerStaffCreateRoutes } from './create.js';
import { registerStaffUpdateRoutes } from './update.js';
import { registerStaffResetCredentialRoutes } from './reset-credential.js';

export async function registerStaffMutateRoutes(app: FastifyInstance): Promise<void> {
  await registerStaffCreateRoutes(app);
  await registerStaffUpdateRoutes(app);
  await registerStaffResetCredentialRoutes(app);
}
