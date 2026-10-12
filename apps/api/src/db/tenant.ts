import { eq, and, type SQL, type Table } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PgColumn, SelectedFields } from 'drizzle-orm/pg-core';
import { db as defaultDb, checkDatabaseConnection } from './client.js';
import type { DbOrTx, Tx } from './types.js';
import { env } from '../config/env.js';

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
  update<T extends HasRestaurantId>(
    table: T,
    values: Record<string, unknown>,
    condition?: SQL,
  ) {
    return this.db
      .update(table as unknown as Table)
      .set(values)
      .where(this.scopedWhere(table, condition));
  }

  /**
   * Delete row(s) from a tenant-scoped table with automatic tenant filter.
   */
  delete<T extends HasRestaurantId>(table: T, condition?: SQL) {
    return this.db
      .delete(table as unknown as Table)
      .where(this.scopedWhere(table, condition));
  }

  /**
   * Run operations within a tenant-scoped database transaction.
   * If RLS is enabled, applies SET LOCAL app.restaurant_id within the transaction.
   */
  async withTx<TResult>(
    fn: (tenantTx: TenantContext, tx: Tx) => Promise<TResult>,
  ): Promise<TResult> {
    return this.db.transaction(async (tx) => {
      if (env.ENABLE_RLS) {
        await tx.execute(sql`SET LOCAL app.restaurant_id = ${this.restaurantId}`);
      }
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
