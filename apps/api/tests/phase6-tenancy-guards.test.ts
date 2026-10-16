import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { forTenant, verifyTenancyStartupGuards } from '../src/db/tenant.js';
import { db } from '../src/db/client.js';

const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('Phase 6: Tenancy Architecture & Startup Guards', () => {
  describe('Cleanup Misleading Multi-Tenant Flags', () => {
    it('ensures ENABLE_RLS is completely removed from runtime env and schema', () => {
      expect((env as unknown as Record<string, unknown>).ENABLE_RLS).toBeUndefined();

      const envPath = path.join(ROOT_DIR, 'apps/api/src/config/env.ts');
      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).not.toContain('ENABLE_RLS');
    });

    it('ensures tenant.ts does not reference ENABLE_RLS or phantom SET LOCAL app.restaurant_id', () => {
      const tenantPath = path.join(ROOT_DIR, 'apps/api/src/db/tenant.ts');
      const tenantContent = fs.readFileSync(tenantPath, 'utf8');
      expect(tenantContent).not.toContain('ENABLE_RLS');
      expect(tenantContent).not.toContain('SET LOCAL app.restaurant_id');
    });

    it('verifies docs/tenancy.md documents application-enforced single-tenant isolation', () => {
      const tenancyDocPath = path.join(ROOT_DIR, 'docs/tenancy.md');
      const docContent = fs.readFileSync(tenancyDocPath, 'utf8');

      expect(docContent).toContain('Single-Tenant Strict Enforcement');
      expect(docContent).toContain('Application-Enforced Tenancy Scoping');
      expect(docContent).toContain('Removal of Misleading Database RLS Flags');
      expect(docContent).toContain('Startup Validation Guards');
      expect(docContent).toContain('MULTI_TENANT=false');
      expect(docContent).toContain('pg_policy');
    });

    it('executes withTx cleanly without dispatching phantom RLS session commands', async () => {
      const tenant = forTenant('018f9e1e-2895-7800-9831-294719283748', db);
      const result = await tenant.withTx(async (tenantTx, _tx) => {
        expect(tenantTx.restaurantId).toBe('018f9e1e-2895-7800-9831-294719283748');
        return 'success';
      });
      expect(result).toBe('success');
    });
  });

  describe('Startup Guard Implementation', () => {
    it('halts startup when MULTI_TENANT=true is invoked without verified RLS policies in Postgres', async () => {
      // Testing against the real PostgreSQL database where no RLS policies exist
      await expect(
        verifyTenancyStartupGuards(db, undefined, {
          MULTI_TENANT: true,
          NODE_ENV: 'production',
        }),
      ).rejects.toThrowError(/MULTI_TENANT=true requires verified database-level RLS policies/);
    });

    it('logs error and includes pg_policy count in failure when MULTI_TENANT=true has 0 policies', async () => {
      const errorLogger = vi.fn();
      const mockLogger = { error: errorLogger };

      const mockDb = {
        execute: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] }),
        select: vi.fn(),
      };

      await expect(
        verifyTenancyStartupGuards(mockDb as never, mockLogger, {
          MULTI_TENANT: true,
          NODE_ENV: 'test',
        }),
      ).rejects.toThrowError(
        'MULTI_TENANT=true requires verified database-level RLS policies in PostgreSQL, but 0 policies were found in pg_policy.',
      );

      expect(errorLogger).toHaveBeenCalledWith(
        { policyCount: 0 },
        expect.stringContaining('MULTI_TENANT=true requires verified database-level RLS policies'),
      );
    });

    it('permits startup when MULTI_TENANT=true and verified RLS policies exist in pg_policy', async () => {
      const mockDb = {
        execute: vi.fn().mockResolvedValue({ rows: [{ count: 12 }] }),
        select: vi.fn(),
      };

      await expect(
        verifyTenancyStartupGuards(mockDb as never, undefined, {
          MULTI_TENANT: true,
          NODE_ENV: 'production',
        }),
      ).resolves.toBeUndefined();

      expect(mockDb.execute).toHaveBeenCalled();
    });

    it('enforces single restaurant rule in production when MULTI_TENANT=false', async () => {
      const errorLogger = vi.fn();
      const mockLogger = { error: errorLogger };

      // 0 restaurants in production
      const mockDbEmpty = {
        execute: vi.fn(),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([]),
        }),
      };

      await expect(
        verifyTenancyStartupGuards(mockDbEmpty as never, mockLogger, {
          MULTI_TENANT: false,
          NODE_ENV: 'production',
        }),
      ).rejects.toThrowError(
        'MULTI_TENANT=false requires exactly one restaurant row in production, found 0',
      );

      // >1 restaurants in production
      const mockDbMultiple = {
        execute: vi.fn(),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]),
        }),
      };

      await expect(
        verifyTenancyStartupGuards(mockDbMultiple as never, mockLogger, {
          MULTI_TENANT: false,
          NODE_ENV: 'production',
        }),
      ).rejects.toThrowError(
        'MULTI_TENANT=false requires exactly one restaurant row in production, found 2',
      );

      // Exactly 1 restaurant in production
      const mockDbSingle = {
        execute: vi.fn(),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([{ id: '018f9e1e-2895-7800-9831-294719283748' }]),
        }),
      };

      await expect(
        verifyTenancyStartupGuards(mockDbSingle as never, mockLogger, {
          MULTI_TENANT: false,
          NODE_ENV: 'production',
        }),
      ).resolves.toBeUndefined();
    });

    it('passes safely in test/development when MULTI_TENANT=false against real database', async () => {
      await expect(
        verifyTenancyStartupGuards(db, undefined, {
          MULTI_TENANT: false,
          NODE_ENV: 'test',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
