import { eq, and, sql, type SQL, type Table } from 'drizzle-orm';
import type { PgColumn, SelectedFields } from 'drizzle-orm/pg-core';
import { db as defaultDb, checkDatabaseConnection } from './client.js';
import type { DbOrTx, Tx } from './types.js';
import { env } from '../config/env.js';
import { restaurants } from './schema/restaurants.js';

export { checkDatabaseConnection };

export interface HasRestaurantId {
  restaurantId: PgColumn | unknown;
}

export class TenantContext {
  public readonly restaurantId: string;
  public readonly db: DbOrTx;

  constructor(restaurantId: string, customExecutor?: DbOrTx) {
    this.restaurantId = restaurantId;
    this.db = customExecutor || defaultDb;
  }

  /**
   * Helper that produces an SQL condition scoped to this tenant:
   * (table.restaurant_id = restaurantId AND condition)
   */
  scopedWhere<T extends HasRestaurantId>(table: T, condition?: SQL | undefined): SQL {
    const col = table.restaurantId as PgColumn;
    if (condition) {
      return and(eq(col, this.restaurantId), condition)!;
    }
    return eq(col, this.restaurantId);
  }

  /**
   * Select all columns from a tenant-scoped table.
   */
  select<T extends HasRestaurantId>(table: T, condition?: SQL) {
    return this.db
      .select()
      .from(table as unknown as Table)
      .where(this.scopedWhere(table, condition));
  }

  /**
   * Select specific fields from a tenant-scoped table.
   */
  selectFields<T extends HasRestaurantId, TSelection extends SelectedFields>(
    table: T,
    fields: TSelection,
    condition?: SQL,
  ) {
    return this.db
      .select(fields)
      .from(table as unknown as Table)
      .where(this.scopedWhere(table, condition));
  }

  /**
   * Insert row(s) into a table, automatically injecting/verifying restaurant_id.
   */
  insert<T extends HasRestaurantId>(
    table: T,
    values: Record<string, unknown> | Record<string, unknown>[],
  ) {
    if (Array.isArray(values)) {
      const injected = values.map((v) => ({
        ...v,
        restaurantId: this.restaurantId,
      }));
      return this.db.insert(table as unknown as Table).values(injected);
    }
    const injected = {
      ...values,
      restaurantId: this.restaurantId,
    };
    return this.db.insert(table as unknown as Table).values(injected);
  }

  /**
   * Update row(s) in a tenant-scoped table with automatic tenant filter.
   */
  update<T extends HasRestaurantId>(table: T, values: Record<string, unknown>, condition?: SQL) {
    return this.db
      .update(table as unknown as Table)
      .set(values)
      .where(this.scopedWhere(table, condition));
  }

  /**
   * Delete row(s) from a tenant-scoped table with automatic tenant filter.
   */
  delete<T extends HasRestaurantId>(table: T, condition?: SQL) {
    return this.db.delete(table as unknown as Table).where(this.scopedWhere(table, condition));
  }

  /**
   * Run operations within a tenant-scoped database transaction.
   */
  async withTx<TResult>(
    fn: (tenantTx: TenantContext, tx: Tx) => Promise<TResult>,
  ): Promise<TResult> {
    return this.db.transaction(async (tx) => {
      const tenantTx = new TenantContext(this.restaurantId, tx);
      return fn(tenantTx, tx);
    });
  }
}

/**
 * Creates a tenant context bound to a specific restaurant.
 */
export function forTenant(restaurantId: string, customExecutor?: DbOrTx): TenantContext {
  if (!restaurantId) {
    throw new Error('forTenant requires a valid restaurantId');
  }
  return new TenantContext(restaurantId, customExecutor);
}

/**
 * Creates a system-level context without tenant scoping (for authentication lookups, health probes).
 */
export function forSystem(customExecutor?: DbOrTx) {
  const executor = customExecutor || defaultDb;
  return {
    db: executor,
    async withTx<TResult>(fn: (tx: Tx) => Promise<TResult>): Promise<TResult> {
      return executor.transaction(async (tx) => fn(tx));
    },
  };
}

/**
 * Startup validation guard enforcing tenancy architecture rules:
 * 1. If MULTI_TENANT=true is requested, halts execution unless verified database-level
 *    Row-Level Security (RLS) policies exist in PostgreSQL (pg_policy).
 * 2. If MULTI_TENANT=false in production, verifies that exactly one restaurant exists.
 */
export async function verifyTenancyStartupGuards(
  database: DbOrTx = defaultDb,
  logger?: { error: (obj: unknown, msg?: string) => void },
  configEnv: { MULTI_TENANT: boolean; NODE_ENV: string } = env,
): Promise<void> {
  // If MULTI_TENANT=true is requested, verify that database-level RLS policies exist in PostgreSQL
  if (configEnv.MULTI_TENANT) {
    const policyResult = await database.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM pg_policy;`,
    );
    const policyCount = Number(policyResult.rows[0]?.count ?? 0);
    if (policyCount === 0) {
      const errorMsg =
        'MULTI_TENANT=true requires verified database-level RLS policies in PostgreSQL, but 0 policies were found in pg_policy. Tenancy isolation is application-enforced and structured for single-tenant deployments. Halting startup to prevent cross-tenant data leakage.';
      logger?.error({ policyCount }, errorMsg);
      throw new Error(errorMsg);
    }
  }

  // Enforce single tenant per deployment when MULTI_TENANT=false in production
  if (!configEnv.MULTI_TENANT && configEnv.NODE_ENV === 'production') {
    const existingRestaurants = await database.select({ id: restaurants.id }).from(restaurants);
    if (existingRestaurants.length !== 1) {
      logger?.error(
        { count: existingRestaurants.length },
        'MULTI_TENANT=false requires exactly one restaurant in production database. Deployment halted.',
      );
      throw new Error(
        `MULTI_TENANT=false requires exactly one restaurant row in production, found ${existingRestaurants.length}`,
      );
    }
  }
}
