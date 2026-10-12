import { env } from './env.js';

/**
 * Returns the parsed list of allowed CORS origins from configuration.
 */
export function getAllowedCorsOrigins(): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Evaluates whether a given origin header is permitted.
 * Requests without an origin (e.g. mobile apps, server-to-server, curl) are permitted.
 */
export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) {
    return true;
  }
  const allowed = getAllowedCorsOrigins();
  return allowed.includes('*') || allowed.includes(origin);
}
