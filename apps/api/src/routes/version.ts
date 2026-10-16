import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { registerRouteGuard } from '../auth/middleware.js';

let pkg = { name: '@restaurant-os/api', version: '0.1.0' };
try {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));
} catch {
  // Fallback defaults if package.json cannot be read
}

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({ method: 'GET', url: '/version', isPublic: true });

  app.get('/version', async (_req, reply) => {
    const gitSha = process.env.GIT_SHA?.trim();
    return reply.status(200).send({
      name: pkg.name ?? '@restaurant-os/api',
      version: pkg.version ?? '0.1.0',
      ...(gitSha ? { gitSha, commit: gitSha } : {}),
    });
  });
}
