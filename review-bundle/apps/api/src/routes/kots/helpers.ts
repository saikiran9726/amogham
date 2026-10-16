import { eq, and, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/types.js';
import { orders } from '../../db/schema/orders.js';
import { kots, kotItems } from '../../db/schema/kots.js';
import { tables } from '../../db/schema/tables.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';

/**
 * Derives and updates order and table status based on all active KOT items for an order.
 */
export async function syncOrderAndTableStatus(orderId: string, restaurantId: string, tx: DbOrTx) {
  const allOrderKots = await tx
    .select()
    .from(kots)
    .where(and(eq(kots.orderId, orderId), eq(kots.restaurantId, restaurantId)));

  if (allOrderKots.length === 0) return;

  const kotIds = allOrderKots.map((k) => k.id);
  const allItems = await tx.select().from(kotItems).where(inArray(kotItems.kotId, kotIds));

  // Non-cancelled items
  const activeItems = allItems.filter((i) => i.action !== 'cancel' && i.status !== 'cancelled');

  let orderStatus: 'saved' | 'preparing' | 'ready' | 'served' = 'saved';
  let tableStatus: 'occupied' | 'preparing' | 'ready' = 'occupied';

  const allDone = activeItems.length > 0 && activeItems.every((i) => i.status === 'done');
  const allServed = allOrderKots.every((k) => k.status === 'served');

  if (allServed) {
    orderStatus = 'served';
    tableStatus = 'occupied';
  } else if (allDone) {
    orderStatus = 'ready';
    tableStatus = 'ready';
  } else if (
    activeItems.some(
      (i) => i.status === 'done' || allOrderKots.some((k) => k.status === 'preparing'),
    )
  ) {
    orderStatus = 'preparing';
    tableStatus = 'preparing';
  } else {
    orderStatus = 'saved';
    tableStatus = 'occupied';
  }

  const [order] = await tx
    .select({ tableId: orders.tableId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order || order.status === 'billed') return;

  await tx
    .update(orders)
    .set({ status: orderStatus, updatedAt: new Date() })
    .where(eq(orders.id, orderId));

  if (order?.tableId) {
    const [table] = await tx
      .select({ currentOrderId: tables.currentOrderId })
      .from(tables)
      .where(eq(tables.id, order.tableId))
      .limit(1);

    if (table?.currentOrderId === orderId) {
      await tx
        .update(tables)
        .set({ status: tableStatus, updatedAt: new Date() })
        .where(and(eq(tables.id, order.tableId), eq(tables.currentOrderId, orderId)));

      emitRealtimeEvent(
        restaurantId,
        'table.statusChanged',
        { tableId: order.tableId, status: tableStatus },
        'all',
      );
    }
  }

  if (orderStatus === 'ready') {
    emitRealtimeEvent(
      restaurantId,
      'order.ready',
      { orderId, tableId: order?.tableId || null },
      'floor',
    );
  }
}

/**
 * Allocates next sequential KOT number for today in the given restaurant.
 */
export async function allocateKotNumber(restaurantId: string, tx: DbOrTx): Promise<number> {
  const todayStr = new Date().toISOString().slice(0, 10);

  const result = await tx.execute<{ last_kot_number: number }>(
    sql`INSERT INTO kot_counters (restaurant_id, business_date, last_kot_number, created_at, updated_at)
        VALUES (${restaurantId}, ${todayStr}::date, 1, NOW(), NOW())
        ON CONFLICT (restaurant_id, business_date)
        DO UPDATE SET last_kot_number = kot_counters.last_kot_number + 1, updated_at = NOW()
        RETURNING last_kot_number;`,
  );

  return Number(result.rows[0]?.last_kot_number ?? 1);
}
