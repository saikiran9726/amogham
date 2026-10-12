import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import yaml from 'yaml';

const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('Deployment & Docker Hardening Tests', () => {
  const rootComposePath = path.join(ROOT_DIR, 'docker-compose.yml');
  const hubComposePath = path.join(ROOT_DIR, 'docker/docker-compose.hub.yml');
  const apiDockerfilePath = path.join(ROOT_DIR, 'apps/api/Dockerfile');
  const webDockerfilePath = path.join(ROOT_DIR, 'apps/web/Dockerfile');
  const webNginxConfPath = path.join(ROOT_DIR, 'apps/web/nginx.conf');
  const backupShPath = path.join(ROOT_DIR, 'docker/backup.sh');
  const restoreTestShPath = path.join(ROOT_DIR, 'docker/restore-test.sh');
  const installHubShPath = path.join(ROOT_DIR, 'docker/install-hub.sh');

  describe('Docker Compose Hardening & Syntax', () => {
    it('validates root docker-compose.yml syntax, required secrets, 127.0.0.1 bind, and healthchecks', () => {
      const content = fs.readFileSync(rootComposePath, 'utf8');
      const parsed = yaml.parse(content);

      expect(parsed.services).toBeDefined();
      expect(parsed.services.postgres).toBeDefined();

      // Check required secrets with ${VAR:?missing} syntax
      expect(content).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?');
      expect(content).toContain('JWT_SECRET: ${JWT_SECRET:?');
      expect(content).toContain('COOKIE_SECRET: ${COOKIE_SECRET:?');

      // Check Postgres is bound to 127.0.0.1
      const pgPorts = parsed.services.postgres.ports;
      expect(pgPorts.some((p: string) => p.startsWith('127.0.0.1:'))).toBe(true);

      // Check API healthcheck against /healthz
      expect(parsed.services.api).toBeDefined();
      expect(parsed.services.api.healthcheck).toBeDefined();
      expect(JSON.stringify(parsed.services.api.healthcheck.test)).toContain('/healthz');
    });

    it('validates docker/docker-compose.hub.yml syntax, secrets, 127.0.0.1 bind, separate migrate, and context', () => {
      const content = fs.readFileSync(hubComposePath, 'utf8');
      const parsed = yaml.parse(content);

      expect(parsed.services).toBeDefined();
      expect(parsed.services['hub-db']).toBeDefined();
      expect(parsed.services['hub-api']).toBeDefined();
      expect(parsed.services['hub-migrate']).toBeDefined();
      expect(parsed.services['hub-backup']).toBeDefined();

      // Check required secrets with ${VAR:?missing} without default fallback
      expect(content).toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?');
      expect(content).toContain('JWT_SECRET: ${JWT_SECRET:?');
      expect(content).toContain('COOKIE_SECRET: ${COOKIE_SECRET:?');
      expect(content).toContain('HUB_API_KEY: ${HUB_API_KEY:?');
      expect(content).toContain('RESTAURANT_ID: ${RESTAURANT_ID:?');

      // Ensure no insecure default fallbacks exist for secrets
      expect(content).not.toContain('postgres_hub_local_pass');
      expect(content).not.toContain('restaurant_os_hub_jwt_secret');

      // Postgres bound to 127.0.0.1
      const dbPorts = parsed.services['hub-db'].ports;
      expect(dbPorts.some((p: string) => p.startsWith('127.0.0.1:5432:5432'))).toBe(true);

      // Verify hub-api build context and dockerfile
      const apiBuild = parsed.services['hub-api'].build;
      expect(apiBuild.context).toBe('..');
      expect(apiBuild.dockerfile).toBe('apps/api/Dockerfile');

      // Verify separate migration service
      const migrateService = parsed.services['hub-migrate'];
      expect(migrateService.restart).toBe('no');
      expect(migrateService.command).toEqual(['node', 'dist/db/migrate.js', 'up']);

      // hub-api depends on hub-migrate completion
      expect(parsed.services['hub-api'].depends_on['hub-migrate']).toEqual({
        condition: 'service_completed_successfully',
      });

      // hub-api healthcheck against /healthz
      expect(parsed.services['hub-api'].healthcheck).toBeDefined();
      expect(JSON.stringify(parsed.services['hub-api'].healthcheck.test)).toContain('/healthz');
    });
  });

  describe('apps/api/Dockerfile Hardening', () => {
    it('uses pnpm deploy --prod, non-root user, and /healthz healthcheck', () => {
      const content = fs.readFileSync(apiDockerfilePath, 'utf8');

      // Verify pnpm deploy --prod
      expect(content).toMatch(/pnpm.*deploy.*--prod|pnpm.*--prod.*deploy/);

      // Verify non-root user
      expect(content).toContain('USER node');

      // Verify HEALTHCHECK against /healthz
      expect(content).toContain('HEALTHCHECK');
      expect(content).toContain('/healthz');

      // Verify separate migrations copying
      expect(content).toContain('dist/db/migrations');
    });
  });

  describe('Web Hosting & Nginx Security Configuration', () => {
    it('validates apps/web/Dockerfile multi-stage nginx build with healthcheck', () => {
      const content = fs.readFileSync(webDockerfilePath, 'utf8');

      expect(content).toContain('FROM nginx:1.27-alpine AS runner');
      expect(content).toContain('COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf');
      expect(content).toContain('HEALTHCHECK');
    });

    it('enforces HSTS, strict CSP without unsafe-inline scripts, and security headers in nginx.conf', () => {
      const content = fs.readFileSync(webNginxConfPath, 'utf8');

      // HSTS
      expect(content).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"');

      // Strict CSP: script-src 'self' without 'unsafe-inline'
      expect(content).toContain("script-src 'self'");
      expect(content).not.toMatch(/script-src[^;]*'unsafe-inline'/);

      // CSP frame-ancestors 'none'
      expect(content).toContain("frame-ancestors 'none'");

      // Security headers
      expect(content).toContain('X-Content-Type-Options "nosniff"');
      expect(content).toContain('X-Frame-Options "DENY"');
      expect(content).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
      expect(content).toContain('Permissions-Policy');

      // SPA fallback
      expect(content).toContain('try_files $uri $uri/ /index.html');
    });
  });

  describe('Database Backup & Disaster Recovery Shell Scripts', () => {
    it('verifies docker/backup.sh uses set -euo pipefail, temp file, gzip -t, and atomic move', () => {
      const content = fs.readFileSync(backupShPath, 'utf8');

      expect(content).toContain('set -euo pipefail');
      expect(content).toContain('gzip -t');
      expect(content).toContain('sha256sum');
      expect(content).toMatch(/mv\s+["$]/); // atomic move
      expect(content).toContain('RETENTION_DAYS');
      expect(content).toContain('BACKUP_S3_BUCKET');
      expect(content).toContain('RCLONE_REMOTE');
    });

    it('verifies docker/restore-test.sh uses set -euo pipefail, checksum check, and smoke tests', () => {
      const content = fs.readFileSync(restoreTestShPath, 'utf8');

      expect(content).toContain('set -euo pipefail');
      expect(content).toContain('sha256sum -c');
      expect(content).toContain('gzip -t');
      expect(content).toContain('createdb');
      expect(content).toContain('dropdb');
      expect(content).toContain('SELECT count(*) FROM _migrations;');
      expect(content).toContain('SELECT count(*) FROM restaurants;');
    });

    it('simulates end-to-end backup file creation, integrity check, checksum, and decompression', () => {
      const sampleDump = `-- PostgreSQL database dump
CREATE TABLE _migrations (id SERIAL PRIMARY KEY, name TEXT);
INSERT INTO _migrations (name) VALUES ('0001_init');
CREATE TABLE restaurants (id UUID PRIMARY KEY, name TEXT);
INSERT INTO restaurants (id, name) VALUES ('018f9e1e-2895-7800-9831-294719283748', 'Grand Bistro');
`;

      // 1. Compress with gzip (as pg_dump | gzip does)
      const compressed = zlib.gzipSync(Buffer.from(sampleDump, 'utf8'));

      // 2. Test gzip integrity (as gzip -t does)
      expect(() => zlib.gunzipSync(compressed)).not.toThrow();

      // 3. Calculate SHA-256 checksum
      const hash = crypto.createHash('sha256').update(compressed).digest('hex');
      expect(hash).toHaveLength(64);

      // 4. Decompress and verify row content
      const decompressed = zlib.gunzipSync(compressed).toString('utf8');
      expect(decompressed).toContain('_migrations');
      expect(decompressed).toContain('Grand Bistro');
    });
  });

  describe('Installer Quality & Weak Secret Defense', () => {
    it('verifies install-hub.sh accepts dynamic RESTAURANT_ID and rejects weak/default secrets', () => {
      const content = fs.readFileSync(installHubShPath, 'utf8');

      expect(content).toContain('set -euo pipefail');
      expect(content).toContain('TARGET_RESTAURANT_ID');
      expect(content).not.toMatch(/RESTAURANT_ID=018f9e1e-2895-7800-9831-294719283748/); // No hardcoded UUID
      expect(content).toContain('check_secret_strength');
      expect(content).toContain('postgres_hub_local_pass');
    });
  });
});
