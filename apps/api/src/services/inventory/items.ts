import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  inventoryItems,
  suppliers,
  purchases,
  purchaseLines,
  stockMovements,
  users,
} from '../../db/schema/index.js';
import {
  type CreateInventoryItemInput,
  type UpdateInventoryItemInput,
  type InventoryCsvImportRow,
  type InventoryItemOutput,
  type StockMovementOutput,
  AppError,
} from '@restaurant-os/shared';

export class InventoryItemService {
  static async listInventoryItems(params: {
    restaurantId: string;
    lowStockOnly?: boolean;
    search?: string;
  }): Promise<InventoryItemOutput[]> {
    const { restaurantId, lowStockOnly, search } = params;

    const items = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.restaurantId, restaurantId), eq(inventoryItems.active, true)))
      .orderBy(asc(inventoryItems.name));

    const results: InventoryItemOutput[] = [];

    for (const item of items) {
      const stock = Number(item.currentStock);
      const reorder = Number(item.reorderLevel);

      let status: 'ok' | 'low' | 'out' = 'ok';
      if (stock <= 0) {
        status = 'out';
      } else if (stock <= reorder) {
        status = 'low';
      }

      if (lowStockOnly && status === 'ok') {
        continue;
      }

      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) {
        continue;
      }

      const lastLine = await db
        .select({
          purchaseDate: purchases.purchaseDate,
          supplierName: suppliers.name,
        })
        .from(purchaseLines)
        .innerJoin(purchases, eq(purchaseLines.purchaseId, purchases.id))
        .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
        .where(and(eq(purchaseLines.itemId, item.id), eq(purchases.restaurantId, restaurantId)))
        .orderBy(desc(purchases.purchaseDate), desc(purchaseLines.createdAt))
        .limit(1);

      results.push({
        id: item.id,
        restaurantId: item.restaurantId,
        name: item.name,
        unit: item.unit as InventoryItemOutput['unit'],
        category: item.category,
        currentStock: stock,
        reorderLevel: reorder,
        active: item.active,
        lastPurchasePricePaisePerUnit: item.lastPurchasePricePaisePerUnit,
        avgCostPaisePerUnit: item.avgCostPaisePerUnit,
        status,
        lastSupplierName: lastLine[0]?.supplierName || null,
        lastPurchaseDate: lastLine[0]?.purchaseDate ? String(lastLine[0].purchaseDate) : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      });
    }

    return results;
  }

  static async getInventoryItemDetail(
    restaurantId: string,
    itemId: string,
  ): Promise<{
    item: InventoryItemOutput;
    recentMovements: StockMovementOutput[];
    purchaseHistory: Array<{
      purchaseId: string;
      purchaseDate: string;
      supplierName: string | null;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
    }>;
  }> {
    const [item] = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.restaurantId, restaurantId)))
      .limit(1);

    if (!item) {
      throw AppError.notFound('Inventory item not found');
    }

    const stock = Number(item.currentStock);
    const reorder = Number(item.reorderLevel);
    const status = stock <= 0 ? 'out' : stock <= reorder ? 'low' : 'ok';

    const movements = await db
      .select({
        id: stockMovements.id,
        restaurantId: stockMovements.restaurantId,
        itemId: stockMovements.itemId,
        type: stockMovements.type,
        quantity: stockMovements.quantity,
        reason: stockMovements.reason,
        refPurchaseId: stockMovements.refPurchaseId,
        movementDate: stockMovements.movementDate,
        costSnapshotPaisePerUnit: stockMovements.costSnapshotPaisePerUnit,
        createdBy: stockMovements.createdBy,
        createdByName: users.name,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .leftJoin(users, eq(stockMovements.createdBy, users.id))
      .where(and(eq(stockMovements.itemId, itemId), eq(stockMovements.restaurantId, restaurantId)))
      .orderBy(desc(stockMovements.createdAt))
      .limit(20);

    const pHistory = await db
      .select({
        purchaseId: purchases.id,
        purchaseDate: purchases.purchaseDate,
        supplierName: suppliers.name,
        quantity: purchaseLines.quantity,
        unitPricePaise: purchaseLines.unitPricePaise,
        lineTotalPaise: purchaseLines.lineTotalPaise,
      })
      .from(purchaseLines)
      .innerJoin(purchases, eq(purchaseLines.purchaseId, purchases.id))
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(and(eq(purchaseLines.itemId, itemId), eq(purchases.restaurantId, restaurantId)))
      .orderBy(desc(purchases.purchaseDate), desc(purchaseLines.createdAt))
      .limit(10);

    return {
      item: {
        id: item.id,
        restaurantId: item.restaurantId,
        name: item.name,
        unit: item.unit as InventoryItemOutput['unit'],
        category: item.category,
        currentStock: stock,
        reorderLevel: reorder,
        active: item.active,
        lastPurchasePricePaisePerUnit: item.lastPurchasePricePaisePerUnit,
        avgCostPaisePerUnit: item.avgCostPaisePerUnit,
        status,
        lastSupplierName: pHistory[0]?.supplierName || null,
        lastPurchaseDate: pHistory[0]?.purchaseDate ? String(pHistory[0].purchaseDate) : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      },
      recentMovements: movements.map((m) => ({
        id: m.id,
        restaurantId: m.restaurantId,
        itemId: m.itemId,
        itemName: item.name,
        itemUnit: item.unit,
        type: m.type as StockMovementOutput['type'],
        quantity: Number(m.quantity),
        reason: m.reason,
        refPurchaseId: m.refPurchaseId,
        movementDate: String(m.movementDate),
        costSnapshotPaisePerUnit: m.costSnapshotPaisePerUnit,
        createdBy: m.createdBy,
        createdByName: m.createdByName || undefined,
        createdAt: m.createdAt.toISOString(),
      })),
      purchaseHistory: pHistory.map((p) => ({
        purchaseId: p.purchaseId,
        purchaseDate: String(p.purchaseDate),
        supplierName: p.supplierName,
        quantity: Number(p.quantity),
        unitPricePaise: p.unitPricePaise,
        lineTotalPaise: p.lineTotalPaise,
      })),
    };
  }

  static async createInventoryItem(
    restaurantId: string,
    userId: string,
    input: CreateInventoryItemInput,
  ): Promise<InventoryItemOutput> {
    const existing = await db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.restaurantId, restaurantId),
          sql`lower(${inventoryItems.name}) = lower(${input.name})`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw AppError.badRequest(`An item named "${input.name}" already exists`);
    }

    return await db.transaction(async (tx) => {
      const initialStock = Number(input.currentStock || 0);
      const initialCost = input.initialCostPaisePerUnit || 0;

      const [created] = await tx
        .insert(inventoryItems)
        .values({
          restaurantId,
          name: input.name,
          unit: input.unit,
          category: input.category,
          currentStock: String(initialStock.toFixed(3)),
          reorderLevel: String(Number(input.reorderLevel || 0).toFixed(3)),
          lastPurchasePricePaisePerUnit: initialCost,
          avgCostPaisePerUnit: initialCost,
        })
        .returning();

      if (!created) {
        throw AppError.internal('Failed to create inventory item');
      }

      if (initialStock > 0) {
        await tx.insert(stockMovements).values({
          restaurantId,
          itemId: created.id,
          type: 'adjustment',
          quantity: String(initialStock.toFixed(3)),
          reason: 'Initial opening stock',
          costSnapshotPaisePerUnit: initialCost,
          createdBy: userId,
        });
      }

      return {
        id: created.id,
        restaurantId: created.restaurantId,
        name: created.name,
        unit: created.unit as InventoryItemOutput['unit'],
        category: created.category,
        currentStock: initialStock,
        reorderLevel: Number(created.reorderLevel),
        active: created.active,
        lastPurchasePricePaisePerUnit: created.lastPurchasePricePaisePerUnit,
        avgCostPaisePerUnit: created.avgCostPaisePerUnit,
        status:
          initialStock <= 0 ? 'out' : initialStock <= Number(created.reorderLevel) ? 'low' : 'ok',
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      };
    });
  }

  static async updateInventoryItem(
    restaurantId: string,
    itemId: string,
    input: UpdateInventoryItemInput,
  ): Promise<InventoryItemOutput> {
    const [existing] = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Inventory item not found');
    }

    if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
      const dup = await db
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.restaurantId, restaurantId),
            sql`lower(${inventoryItems.name}) = lower(${input.name})`,
          ),
        )
        .limit(1);

      if (dup.length > 0) {
        throw AppError.badRequest(`An item named "${input.name}" already exists`);
      }
    }

    const [updated] = await db
      .update(inventoryItems)
      .set({
        name: input.name ?? existing.name,
        unit: input.unit ?? existing.unit,
        category: input.category ?? existing.category,
        reorderLevel:
          input.reorderLevel !== undefined
            ? String(input.reorderLevel.toFixed(3))
            : existing.reorderLevel,
        active: input.active !== undefined ? input.active : existing.active,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, itemId))
      .returning();

    const stock = Number(updated!.currentStock);
    const reorder = Number(updated!.reorderLevel);

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      name: updated!.name,
      unit: updated!.unit as InventoryItemOutput['unit'],
      category: updated!.category,
      currentStock: stock,
      reorderLevel: reorder,
      active: updated!.active,
      lastPurchasePricePaisePerUnit: updated!.lastPurchasePricePaisePerUnit,
      avgCostPaisePerUnit: updated!.avgCostPaisePerUnit,
      status: stock <= 0 ? 'out' : stock <= reorder ? 'low' : 'ok',
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  static async getReorderList(restaurantId: string): Promise<InventoryItemOutput[]> {
    return this.listInventoryItems({
      restaurantId,
      lowStockOnly: true,
    });
  }

  static async commitCsvImport(
    restaurantId: string,
    userId: string,
    rows: InventoryCsvImportRow[],
  ): Promise<{ importedCount: number; errors: string[] }> {
    let importedCount = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        await this.createInventoryItem(restaurantId, userId, {
          name: row.name,
          unit: row.unit,
          category: row.category,
          currentStock: row.currentStock,
          reorderLevel: row.reorderLevel,
          initialCostPaisePerUnit: Math.round(row.costPricePerUnit * 100),
        });
        importedCount++;
      } catch (err: unknown) {
        errors.push(`Row "${row.name}": ${(err as Error).message}`);
      }
    }

    return { importedCount, errors };
  }

  static async verifyStockConsistency(restaurantId: string): Promise<{
    isConsistent: boolean;
    mismatches: Array<{ itemId: string; name: string; currentStock: number; movementSum: number }>;
  }> {
    const items = await db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        currentStock: inventoryItems.currentStock,
      })
      .from(inventoryItems)
      .where(eq(inventoryItems.restaurantId, restaurantId));

    const mismatches = [];

    for (const item of items) {
      const sumResult = await db
        .select({
          total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
        })
        .from(stockMovements)
        .where(eq(stockMovements.itemId, item.id));

      const currentStock = Number(Number(item.currentStock).toFixed(3));
      const movementSum = Number(Number(sumResult[0]?.total || 0).toFixed(3));

      if (Math.abs(currentStock - movementSum) > 0.001) {
        mismatches.push({
          itemId: item.id,
          name: item.name,
          currentStock,
          movementSum,
        });
      }
    }

    return {
      isConsistent: mismatches.length === 0,
      mismatches,
    };
  }
}
