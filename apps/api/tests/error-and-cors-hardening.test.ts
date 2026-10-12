import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { registerCors } from '../src/plugins/cors.js';
import { AppError } from '@restaurant-os/shared';

describe('Error Handler & CORS Hardening Tests', () => {
  describe('5xx Error Masking Outside test Environment', () => {
    let prodApp: FastifyInstance;
    const originalEnv = process.env.NODE_ENV;

    beforeAll(async () => {
      // Set to production to verify masking
      process.env.NODE_ENV = 'production';

      prodApp = Fastify({ logger: false });
      registerErrorHandler(prodApp);

      // Endpoint throwing custom 500 AppError
      prodApp.get('/throw-app-error', async () => {
        throw AppError.internal('Sensitive internal database connection string leaked');
      });

      // Endpoint throwing unexpected 500 Error
      prodApp.get('/throw-generic-error', async () => {
        throw new Error('Secret AWS credentials or stack trace');
      });

      await prodApp.ready();
    });

    afterAll(async () => {
      process.env.NODE_ENV = originalEnv;
      await prodApp.close();
    });

    it('masks AppError 500 message to "Internal server error" outside test environment', async () => {
      const res = await prodApp.inject({
        method: 'GET',
        url: '/throw-app-error',
      });

      expect(res.statusCode).toBe(500);
      const json = res.json();
      expect(json.error.message).toBe('Internal server error');
      expect(json.error.message).not.toContain('Sensitive internal');
    });

    it('masks unexpected Error message to "Internal server error" outside test environment', async () => {
      const res = await prodApp.inject({
        method: 'GET',
        url: '/throw-generic-error',
      });

      expect(res.statusCode).toBe(500);
      const json = res.json();
      expect(json.error.message).toBe('Internal server error');
      expect(json.error.message).not.toContain('Secret AWS credentials');
    });
  });

  describe('CORS Denial Behavior: cb(null, false)', () => {
    let corsApp: FastifyInstance;

    beforeAll(async () => {
      corsApp = Fastify({ logger: false });
      await registerCors(corsApp);

      corsApp.get('/ping', async () => {
        return { ok: true };
      });

      await corsApp.ready();
    });

    afterAll(async () => {
      await corsApp.close();
    });

    it('does not send Access-Control-Allow-Origin header for disallowed origins and succeeds with 200 without throwing 403/500', async () => {
      const res = await corsApp.inject({
        method: 'GET',
        url: '/ping',
        headers: {
          origin: 'http://malicious-attacker.evil',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sends Access-Control-Allow-Origin header for allowed origins', async () => {
      const res = await corsApp.inject({
        method: 'GET',
        url: '/ping',
        headers: {
          origin: 'http://localhost:5173',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });
  });
});
