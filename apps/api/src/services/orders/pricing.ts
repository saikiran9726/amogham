import { eq, and, inArray } from 'drizzle-orm';
import { AppError } from '@restaurant-os/shared';
import { db } from '../../db/client.js';
import { menuItems } from '../../db/schema/menu-items.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { tables } from '../../db/schema/tables.js';

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrderModifierInput {
  id?: string;
  name: string;
  priceDeltaPaise?: number;
}

export interface OrderItemPricingInput {
  itemId: string;
  qty: number;
  modifiers?: OrderModifierInput[];
  note?: string | null;
}

export interface ProcessedOrderItem {
  itemId: string;
  nameSnapshot: string;
  pricePaiseSnapshot: number;
  taxRateBpSnapshot: number;
  qty: number;
  modifiers: OrderModifierInput[];
  note: string | null;
  lineNo: number;
}

export interface ComputedOrderTotals {
  processedItems: ProcessedOrderItem[];
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

/**
 * Validates order item prices and calculates subtotal and tax according to tax mode.
 * Verifies all itemIds belong to the given restaurant and are active/available.
 */
export async function computeOrderTotals(
  restaurantId: string,
  rawItems: OrderItemPricingInput[],
  executor: DbOrTx = db,
): Promise<ComputedOrderTotals> {
  const itemIds = rawItems.map((i) => i.itemId);
  if (itemIds.length === 0) {
    return {
      processedItems: [],
      subtotalPaise: 0,
      taxPaise: 0,
      totalPaise: 0,
    };
  }

  const dbItems = await executor
    .select({
      id: menuItems.id,
      name: menuItems.name,
      pricePaise: menuItems.pricePaise,
      taxRateBp: menuItems.taxRateBp,
      available: menuItems.available,
      active: menuItems.active,
    })
    .from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), inArray(menuItems.id, itemIds)));

  const dbItemMap = new Map(dbItems.map((i) => [i.id, i]));

  // Verify availability, active status, and tenant boundary
  for (const raw of rawItems) {
    const found = dbItemMap.get(raw.itemId);
    if (!found || !found.active) {
      throw AppError.badRequest(
        `Item '${raw.itemId}' is no longer active or does not belong to this restaurant.`,
      );
    }
    if (!found.available) {
      throw AppError.badRequest(
        `Item '${found.name}' is currently Out of Stock and cannot be ordered.`,
        { unavailableItemId: found.id, itemName: found.name },
      );
    }
  }

  // Fetch restaurant tax settings
  const [settings] = await executor
    .select({
      taxMode: restaurantSettings.taxMode,
      defaultGstRateBp: restaurantSettings.defaultGstRateBp,
    })
    .from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, restaurantId))
    .limit(1);

  const taxMode = settings?.taxMode || 'exclusive';

  let subtotalPaise = 0;
  let taxPaise = 0;

  const processedItems: ProcessedOrderItem[] = rawItems.map((raw, idx) => {
    const item = dbItemMap.get(raw.itemId)!;
    // Calculate unit price including modifier price deltas
    const modTotalDelta = (raw.modifiers || []).reduce(
      (sum, m) => sum + (m.priceDeltaPaise || 0),
      0,
    );
    const unitPricePaise = item.pricePaise + modTotalDelta;
    const lineSubtotal = unitPricePaise * raw.qty;
    const taxRateBp = item.taxRateBp || settings?.defaultGstRateBp || 500;

    let lineTax = 0;
    if (taxMode === 'inclusive') {
      // Inclusive: lineTax = lineSubtotal - (lineSubtotal / (1 + rate))
      lineTax = Math.round(lineSubtotal - (lineSubtotal * 10000) / (10000 + taxRateBp));
      subtotalPaise += lineSubtotal - lineTax;
    } else {
      // Exclusive: lineTax = lineSubtotal * (rate / 10000)
      lineTax = Math.round((lineSubtotal * taxRateBp) / 10000);
      subtotalPaise += lineSubtotal;
    }
    taxPaise += lineTax;

    return {
      itemId: item.id,
      nameSnapshot: item.name,
      pricePaiseSnapshot: unitPricePaise,
      taxRateBpSnapshot: taxRateBp,
      qty: raw.qty,
      modifiers: raw.modifiers || [],
      note: raw.note || null,
      lineNo: idx + 1,
    };
  });

  const totalPaise = subtotalPaise + taxPaise;

  return {
    processedItems,
    subtotalPaise,
    taxPaise,
    totalPaise,
  };
}

/**
 * Verifies that a table belongs to the given restaurant.
 */
export async function verifyTableBelongsToRestaurant(
  restaurantId: string,
  tableId: string,
  executor: DbOrTx = db,
): Promise<void> {
  const [table] = await executor
    .select({ id: tables.id })
    .from(tables)
    .where(and(eq(tables.id, tableId), eq(tables.restaurantId, restaurantId)))
    .limit(1);

  if (!table) {
    throw AppError.badRequest(`Table '${tableId}' does not belong to this restaurant.`);
  }
}
