import fs from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

const { Pool } = pg;

function buildSslConfig(): pg.PoolConfig['ssl'] {
  const caPath = env.DB_CA_CERT_PATH || process.env.DB_CA_CERT_PATH;
  if (caPath && fs.existsSync(caPath)) {
    return {
      ca: fs.readFileSync(caPath, 'utf8'),
      rejectUnauthorized: true,
    };
  }

  try {
    const u = new URL(env.DATABASE_URL);
    const host = u.hostname.toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'host.docker.internal' ||
      host === 'postgres' ||
      host === 'hub-db';

    const sslmode = u.searchParams.get('sslmode');
    if (sslmode === 'disable') {
      return false;
    }
    if (sslmode === 'verify-full' || sslmode === 'verify-ca') {
      return {
        rejectUnauthorized: true,
      };
    }
    if (sslmode === 'require') {
      return {
        rejectUnauthorized: env.NODE_ENV === 'production',
      };
    }

    if (env.NODE_ENV === 'production' && !isLocal) {
      return {
        rejectUnauthorized: true,
      };
    }
  } catch {
    // If DATABASE_URL is not a standard URL
  }

  return undefined;
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  ssl: buildSslConfig(),
});

export const db = drizzle(pool, { schema });

/**
 * Checks if PostgreSQL is reachable and executing queries.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

/**
 * Closes the database pool during graceful shutdown.
 */
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}
