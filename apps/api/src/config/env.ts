import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { z } from 'zod';

// Load .env file
dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

// Strict boolean transform: accepts true, false, 'true', 'false', '1', '0'
export const strictBoolean = (defaultValue = false) =>
  z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return defaultValue;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
      return val;
    }
    return val;
  }, z.boolean());

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    // Auth & Security
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
    COOKIE_SECURE: strictBoolean(false),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    MAX_FAILED_LOGIN_ATTEMPTS: z.coerce.number().default(5),
    LOCKOUT_DURATION_MINUTES: z.coerce.number().default(10),
    REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().default(7),
    TRUST_PROXY: z.string().optional(),

    // Tenancy & Row-Level Security
    MULTI_TENANT: strictBoolean(false),
    ENABLE_RLS: strictBoolean(false),

    // Seed credentials (initial owner setup)
    SEED_OWNER_USERNAME: z.string().default('owner'),
    SEED_OWNER_PASSWORD: z.string().optional(),
    SEED_RESTAURANT_NAME: z.string().default('The Grand Bistro'),

    // Hub Mode & Sync
    HUB_ROLE: z.enum(['cloud', 'local_hub', 'standalone']).default('standalone'),
    CLOUD_SYNC_URL: z.string().optional(),
    RESTAURANT_ID: z.string().optional(),
    HUB_DEVICE_ID: z.string().default('hub-primary'),
    HUB_API_KEY: z.string().optional(),
    HUB_SYNC_INTERVAL_MS: z.coerce.number().default(5000),

    // Observability
    METRICS_TOKEN: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    // Validate CORS origins list
    const origins = config.CORS_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (origins.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'At least one CORS origin must be specified.',
      });
    }

    for (const origin of origins) {
      try {
        const u = new URL(origin);
        if (!['http:', 'https:'].includes(u.protocol)) {
          ctx.addIssue({
            code: 'custom',
            path: ['CORS_ORIGIN'],
            message: `Invalid protocol in CORS origin: ${origin}`,
          });
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGIN'],
          message: `Invalid URL format in CORS origin: ${origin}`,
        });
      }
    }

    // COOKIE_SAMESITE=none requires secure cookies
    if (config.COOKIE_SAMESITE === 'none' && !config.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SAMESITE'],
        message: 'COOKIE_SAMESITE=none requires COOKIE_SECURE to be true.',
      });
    }

    if (config.NODE_ENV !== 'production') return;

    // Production environment checks
    if (!config.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'Secure cookies are required in production.',
      });
    }

    if (config.CORS_ORIGIN.includes('*') || config.CORS_ORIGIN.includes('localhost')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'Configure explicit production web origins without localhost or wildcard.',
      });
    }

    if (config.HUB_ROLE === 'local_hub') {
      if (!config.CLOUD_SYNC_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['CLOUD_SYNC_URL'],
          message: 'CLOUD_SYNC_URL is required when HUB_ROLE=local_hub in production.',
        });
      }
      if (!config.RESTAURANT_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['RESTAURANT_ID'],
          message: 'RESTAURANT_ID is required when HUB_ROLE=local_hub in production.',
        });
      }
      if (!config.HUB_API_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['HUB_API_KEY'],
          message: 'HUB_API_KEY is required when HUB_ROLE=local_hub in production.',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnvConfig(rawEnv: Record<string, string | undefined>): Env {
  const nodeEnv = rawEnv.NODE_ENV || 'production';
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';
  const effectiveEnv = { ...rawEnv };

  if (isDevOrTest) {
    if (!effectiveEnv.DATABASE_URL) {
      effectiveEnv.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/restaurant_os';
    }
    if (!effectiveEnv.JWT_SECRET) {
      console.warn('[SECURITY WARNING] Generating ephemeral JWT_SECRET for development/test');
      effectiveEnv.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    }
    if (!effectiveEnv.COOKIE_SECRET) {
      console.warn('[SECURITY WARNING] Generating ephemeral COOKIE_SECRET for development/test');
      effectiveEnv.COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
    }
  }

  const parsed = envSchema.safeParse(effectiveEnv);
  if (!parsed.success) {
    const issues = parsed.error.format();
    const error = new Error(`Invalid environment configuration: ${JSON.stringify(issues)}`);
    Object.assign(error, { details: issues });
    throw error;
  }
  return parsed.data;
}

// In development/test, provide ephemeral secrets in process.env if missing
const initialNodeEnv = process.env.NODE_ENV || 'production';
if (initialNodeEnv === 'development' || initialNodeEnv === 'test') {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/restaurant_os';
  }
  if (!process.env.JWT_SECRET) {
    console.warn('[SECURITY WARNING] Generating ephemeral JWT_SECRET for development/test');
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  }
  if (!process.env.COOKIE_SECRET) {
    console.warn('[SECURITY WARNING] Generating ephemeral COOKIE_SECRET for development/test');
    process.env.COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  }
}

export const env = parseEnvConfig(process.env);
