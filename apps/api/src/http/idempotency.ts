import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { sql, eq, and } from 'drizzle-orm';
import { AppError } from '@restaurant-os/shared';
import type { db } from '../db/client.js';
import { syncCommands } from '../db/schema/orders.js';

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DatabaseOrTransaction = typeof db | Transaction;

export interface IdempotencyOptions {
  restaurantId: string;
  userId?: string | null;
  commandType: string;
  key?: string | null;
  requestBody: unknown;
}

export type IdempotencyExecutionResult<T> = {
  result: T;
  replayed: boolean;
} & (T extends object ? T : Record<string, unknown>);

/**
 * Deterministically serialize a JSON value with sorted object keys.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => JSON.stringify(key) + ':' + canonicalizeJson(obj[key]));
  return '{' + entries.join(',') + '}';
}

/**
 * Compute sha256 hash of the normalized request payload (ignoring client idempotency key).
 */
export function hashRequestBody(body: unknown): string {
  let normalized = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const copy = { ...(body as Record<string, unknown>) };
    delete copy.idempotencyKey;
    normalized = copy;
  }
  const canonical = canonicalizeJson(normalized ?? {});
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Hash restaurantId, commandType, and key into a 64-bit signed integer BigInt for pg_advisory_xact_lock.
 */
export function computeAdvisoryLockKey(str: string): bigint {
  const hash = createHash('sha256').update(str).digest();
  return hash.readBigInt64BE(0);
}

/**
 * Extracts the idempotency key from the Idempotency-Key request header (canonical)
 * or body.idempotencyKey (deprecated alias).
 */
export function extractIdempotencyKey(request: FastifyRequest, body?: unknown): string | undefined {
  const headerKey = request.headers['idempotency-key'];
  if (typeof headerKey === 'string' && headerKey.trim().length > 0) {
    return headerKey.trim();
  }
  if (Array.isArray(headerKey) && headerKey[0]?.trim()) {
    return headerKey[0].trim();
  }
  if (
    body &&
    typeof body === 'object' &&
    'idempotencyKey' in body &&
    typeof (body as { idempotencyKey: unknown }).idempotencyKey === 'string'
  ) {
    const raw = (body as { idempotencyKey: string }).idempotencyKey.trim();
    if (raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * Executes a domain operation with transaction-scoped idempotency and advisory locking.
 */
export async function withIdempotency<T>(
  tx: DatabaseOrTransaction,
  options: IdempotencyOptions,
  fn: (tx: DatabaseOrTransaction) => Promise<T>,
): Promise<IdempotencyExecutionResult<T>> {
  const { restaurantId, userId, commandType, key, requestBody } = options;

  if (!key || key.trim().length === 0) {
    const result = await fn(tx);
    const extra = typeof result === 'object' && result !== null ? result : {};
    return {
      ...extra,
      result,
      replayed: false,
    } as IdempotencyExecutionResult<T>;
  }

  const trimmedKey = key.trim();
  const lockKey = computeAdvisoryLockKey(`${restaurantId}:${commandType}:${trimmedKey}`);

  // Acquire transaction-scoped advisory lock on hash(restaurantId:commandType:key)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);

  const currentRequestHash = hashRequestBody(requestBody);

  // Look up existing command for this tenant, command type, and key
  const [existing] = await tx
    .select()
    .from(syncCommands)
    .where(
      and(
        eq(syncCommands.restaurantId, restaurantId),
        eq(syncCommands.commandType, commandType),
        eq(syncCommands.idempotencyKey, trimmedKey),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.requestHash && existing.requestHash !== currentRequestHash) {
      throw new AppError(
        'Idempotency key reused with different request payload',
        'IDEMPOTENCY_KEY_REUSED',
        422,
      );
    }

    const storedResult = existing.result as T;
    const extra = typeof storedResult === 'object' && storedResult !== null ? storedResult : {};
    return {
      ...extra,
      result: storedResult,
      replayed: true,
    } as IdempotencyExecutionResult<T>;
  }

  // Execute operation and persist result atomically in the same transaction
  const result = await fn(tx);

  await tx.insert(syncCommands).values({
    idempotencyKey: trimmedKey,
    restaurantId,
    userId: userId || null,
    commandType,
    requestHash: currentRequestHash,
    status: 'completed',
    result: result as unknown as Record<string, unknown>,
  });

  const extra = typeof result === 'object' && result !== null ? result : {};
  return {
    ...extra,
    result,
    replayed: false,
  } as IdempotencyExecutionResult<T>;
}
