import { eq, and, desc, sql } from 'drizzle-orm';
import { forTenant } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';

export async function getCustomerDiningMemory(restaurantId: string, customerId: string) {
  const tenant = forTenant(restaurantId);

  // 1. Top 3 favourite items by ordered quantity
  const favourites = await tenant.db
    .select({
      itemId: orderItems.itemId,
      name: orderItems.nameSnapshot,
      count: sql<number>`SUM(${orderItems.qty})::int`,
      pricePaise: orderItems.pricePaiseSnapshot,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.customerId, customerId),
        eq(orderItems.status, 'active'),
      ),
    )
    .groupBy(orderItems.itemId, orderItems.nameSnapshot, orderItems.pricePaiseSnapshot)
    .orderBy(desc(sql`SUM(${orderItems.qty})`))
    .limit(3);

  // 2. Last order items
  const [lastOrderRow] = await tenant.db
    .select({ id: orders.id, createdAt: orders.createdAt })
    .from(orders)
    .where(
      and(
        eq(orders.restaurantId, restaurantId),
        eq(orders.customerId, customerId),
        eq(orders.status, 'billed'),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(1);

  let lastOrderItems: Array<{
    itemId: string;
    name: string;
    qty: number;
    pricePaise: number;
    modifiers: unknown[];
    note?: string;
  }> | null = null;

  if (lastOrderRow) {
    const items = await tenant.db
      .select({
        itemId: orderItems.itemId,
        name: orderItems.nameSnapshot,
        qty: orderItems.qty,
        pricePaise: orderItems.pricePaiseSnapshot,
        modifiers: orderItems.modifiers,
        note: orderItems.note,
      })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, lastOrderRow.id), eq(orderItems.status, 'active')));
    lastOrderItems = items.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      qty: i.qty,
      pricePaise: i.pricePaise,
      modifiers: Array.isArray(i.modifiers) ? (i.modifiers as unknown[]) : [],
      note: i.note ?? undefined,
    }));
  }

  return {
    favouriteItems: favourites.map((f) => ({
      itemId: f.itemId,
      name: f.name,
      count: Number(f.count),
      pricePaise: f.pricePaise,
      isVeg: true,
    })),
    lastOrder: lastOrderItems,
  };
}
