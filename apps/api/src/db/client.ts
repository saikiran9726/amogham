import fs from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

const { Pool } = pg;

const caPath = process.env.DB_CA_CERT_PATH;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(caPath
    ? {
        ssl: {
          ca: fs.readFileSync(caPath, 'utf8'),
          rejectUnauthorized: true,
        },
      }
    : {}),
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
