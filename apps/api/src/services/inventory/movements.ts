import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { inventoryItems, stockMovements } from '../../db/schema/index.js';
import {
  calculateWasteCostPaise,
  calculateStockCountVariance,
  type RecordUsageInput,
  type RecordWasteInput,
  type RecordStockCountInput,
  type StockMovementOutput,
  type StockCountSummaryOutput,
  AppError,
} from '@restaurant-os/shared';

export class InventoryMovementService {
  static async recordUsage(
    restaurantId: string,
    userId: string,
    input: RecordUsageInput,
  ): Promise<StockMovementOutput> {
    return await db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, input.itemId), eq(inventoryItems.restaurantId, restaurantId)),
        )
        .for('update');

      if (!item) throw AppError.notFound('Inventory item not found');

      const currentStock = Number(item.currentStock);
      if (currentStock < input.quantity) {
        throw AppError.badRequest(
          `Usage quantity (${input.quantity} ${item.unit}) exceeds current stock (${currentStock} ${item.unit})`,
        );
      }

      const [updatedItem] = await tx
        .update(inventoryItems)
        .set({
          currentStock: sql`(${inventoryItems.currentStock} - ${input.quantity})::numeric(12,3)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryItems.id, item.id),
            sql`${inventoryItems.currentStock} >= ${input.quantity}`,
          ),
        )
        .returning();

      if (!updatedItem) {
        throw AppError.badRequest(
          `Usage quantity (${input.quantity} ${item.unit}) exceeds available stock`,
        );
      }

      const [movement] = await tx
        .insert(stockMovements)
        .values({
          restaurantId,
          itemId: item.id,
          type: 'usage',
          quantity: String((-input.quantity).toFixed(3)),
          reason: input.reason || 'Kitchen consumption',
          movementDate: input.movementDate || new Date().toISOString().split('T')[0],
          costSnapshotPaisePerUnit: item.avgCostPaisePerUnit,
          createdBy: userId,
        })
        .returning();

      return {
        id: movement!.id,
        restaurantId: movement!.restaurantId,
        itemId: movement!.itemId,
        itemName: item.name,
        itemUnit: item.unit,
        type: 'usage',
        quantity: -input.quantity,
        reason: movement!.reason,
        refPurchaseId: null,
        movementDate: String(movement!.movementDate),
        costSnapshotPaisePerUnit: movement!.costSnapshotPaisePerUnit,
        createdBy: userId,
        createdAt: movement!.createdAt.toISOString(),
      };
    });
  }

  static async recordWaste(
    restaurantId: string,
    userId: string,
    input: RecordWasteInput,
  ): Promise<StockMovementOutput> {
    return await db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, input.itemId), eq(inventoryItems.restaurantId, restaurantId)),
        )
        .for('update');

      if (!item) throw AppError.notFound('Inventory item not found');

      const currentStock = Number(item.currentStock);
      if (currentStock < input.quantity) {
        throw AppError.badRequest(
          `Waste quantity (${input.quantity} ${item.unit}) exceeds current stock (${currentStock} ${item.unit})`,
        );
      }

      calculateWasteCostPaise(input.quantity, item.avgCostPaisePerUnit);

      const [updatedItem] = await tx
        .update(inventoryItems)
        .set({
          currentStock: sql`(${inventoryItems.currentStock} - ${input.quantity})::numeric(12,3)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryItems.id, item.id),
            sql`${inventoryItems.currentStock} >= ${input.quantity}`,
          ),
        )
        .returning();

      if (!updatedItem) {
        throw AppError.badRequest(
          `Waste quantity (${input.quantity} ${item.unit}) exceeds available stock`,
        );
      }

      const reasonText = input.note
        ? `Waste (${input.reason}): ${input.note}`
        : `Waste (${input.reason})`;

      const [movement] = await tx
        .insert(stockMovements)
        .values({
          restaurantId,
          itemId: item.id,
          type: 'waste',
          quantity: String((-input.quantity).toFixed(3)),
          reason: reasonText,
          movementDate: input.movementDate || new Date().toISOString().split('T')[0],
          costSnapshotPaisePerUnit: item.avgCostPaisePerUnit,
          createdBy: userId,
        })
        .returning();

      return {
        id: movement!.id,
        restaurantId: movement!.restaurantId,
        itemId: movement!.itemId,
        itemName: item.name,
        itemUnit: item.unit,
        type: 'waste',
        quantity: -input.quantity,
        reason: movement!.reason,
        refPurchaseId: null,
        movementDate: String(movement!.movementDate),
        costSnapshotPaisePerUnit: movement!.costSnapshotPaisePerUnit,
        createdBy: userId,
        createdAt: movement!.createdAt.toISOString(),
      };
    });
  }

  static async recordStockCount(
    restaurantId: string,
    userId: string,
    input: RecordStockCountInput,
  ): Promise<StockCountSummaryOutput[]> {
    return await db.transaction(async (tx) => {
      const summaries: StockCountSummaryOutput[] = [];
      const mDate = input.movementDate || new Date().toISOString().split('T')[0];

      for (const countLine of input.counts) {
        const [item] = await tx
          .select()
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.id, countLine.itemId),
              eq(inventoryItems.restaurantId, restaurantId),
            ),
          )
          .for('update');

        if (!item) continue;

        const previousStock = Number(item.currentStock);
        const countedStock = Number(countLine.countedStock);
        const { variance } = calculateStockCountVariance({
          previousStock,
          countedStock,
        });

        // Set item stock directly to counted stock
        await tx
          .update(inventoryItems)
          .set({
            currentStock: String(countedStock.toFixed(3)),
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, item.id));

        // Record stock_count movement with the variance quantity
        await tx.insert(stockMovements).values({
          restaurantId,
          itemId: item.id,
          type: 'stock_count',
          quantity: String(variance.toFixed(3)),
          reason: input.note ? `Stock Count: ${input.note}` : 'Physical Stock Count',
          movementDate: mDate,
          costSnapshotPaisePerUnit: item.avgCostPaisePerUnit,
          createdBy: userId,
        });

        summaries.push({
          itemId: item.id,
          itemName: item.name,
          unit: item.unit,
          previousStock,
          countedStock,
          variance,
          impliedUsage: variance < 0 ? Math.abs(variance) : 0,
          costImpactPaise: Math.round(Math.abs(variance) * item.avgCostPaisePerUnit),
        });
      }

      return summaries;
    });
  }
}
