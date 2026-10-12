import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  inventoryItems,
  suppliers,
  purchases,
  purchaseLines,
  stockMovements,
} from '../../db/schema/index.js';
import {
  calculateWeightedAverageCostPaise,
  type CreatePurchaseInput,
  type UpdatePurchaseInput,
  type PurchaseOutput,
  AppError,
} from '@restaurant-os/shared';

export class InventoryPurchaseService {
  static async createPurchase(
    restaurantId: string,
    userId: string,
    input: CreatePurchaseInput,
  ): Promise<PurchaseOutput> {
    return await db.transaction(async (tx) => {
      let totalPurchasePaise = 0;
      for (const line of input.lines) {
        totalPurchasePaise += line.lineTotalPaise;
      }

      const [purchase] = await tx
        .insert(purchases)
        .values({
          restaurantId,
          supplierId: input.supplierId || null,
          purchaseDate: input.purchaseDate,
          invoiceRef: input.invoiceRef || null,
          totalPaise: totalPurchasePaise,
          paidStatus: input.paidStatus,
          note: input.note || null,
          createdBy: userId,
        })
        .returning();

      if (!purchase) {
        throw AppError.internal('Failed to create purchase header');
      }

      const lineOutputs = [];

      for (const line of input.lines) {
        const [item] = await tx
          .select()
          .from(inventoryItems)
          .where(
            and(eq(inventoryItems.id, line.itemId), eq(inventoryItems.restaurantId, restaurantId)),
          )
          .for('update');

        if (!item) {
          throw AppError.notFound(`Inventory item ${line.itemId} not found`);
        }

        const currentStock = Number(item.currentStock);
        const currentAvgCost = item.avgCostPaisePerUnit;
        const lineQty = Number(line.quantity);

        const newAvgCost = calculateWeightedAverageCostPaise({
          currentStock,
          currentAvgCostPaisePerUnit: currentAvgCost,
          purchaseQuantity: lineQty,
          purchaseTotalPaise: line.lineTotalPaise,
        });

        const newStock = Number((currentStock + lineQty).toFixed(3));

        await tx
          .update(inventoryItems)
          .set({
            currentStock: String(newStock.toFixed(3)),
            lastPurchasePricePaisePerUnit: line.unitPricePaise,
            avgCostPaisePerUnit: newAvgCost,
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, item.id));

        const [pLine] = await tx
          .insert(purchaseLines)
          .values({
            purchaseId: purchase.id,
            itemId: item.id,
            quantity: String(lineQty.toFixed(3)),
            unitPricePaise: line.unitPricePaise,
            lineTotalPaise: line.lineTotalPaise,
          })
          .returning();

        await tx.insert(stockMovements).values({
          restaurantId,
          itemId: item.id,
          type: 'purchase',
          quantity: String(lineQty.toFixed(3)),
          reason: `Purchase Invoice ${input.invoiceRef || `#${purchase.id.slice(0, 8)}`}`,
          refPurchaseId: purchase.id,
          movementDate: input.purchaseDate,
          costSnapshotPaisePerUnit: line.unitPricePaise,
          createdBy: userId,
        });

        lineOutputs.push({
          id: pLine!.id,
          purchaseId: purchase.id,
          itemId: item.id,
          itemName: item.name,
          itemUnit: item.unit,
          quantity: lineQty,
          unitPricePaise: line.unitPricePaise,
          lineTotalPaise: line.lineTotalPaise,
        });
      }

      let supplierName: string | null = null;
      if (purchase.supplierId) {
        const [sup] = await tx
          .select({ name: suppliers.name })
          .from(suppliers)
          .where(eq(suppliers.id, purchase.supplierId))
          .limit(1);
        supplierName = sup?.name || null;
      }

      return {
        id: purchase.id,
        restaurantId: purchase.restaurantId,
        supplierId: purchase.supplierId,
        supplierName,
        purchaseDate: String(purchase.purchaseDate),
        invoiceRef: purchase.invoiceRef,
        totalPaise: purchase.totalPaise,
        paidStatus: purchase.paidStatus as PurchaseOutput['paidStatus'],
        note: purchase.note,
        createdBy: purchase.createdBy,
        lines: lineOutputs,
        createdAt: purchase.createdAt.toISOString(),
        updatedAt: purchase.updatedAt.toISOString(),
      };
    });
  }

  static async updatePurchase(
    restaurantId: string,
    purchaseId: string,
    userId: string,
    input: UpdatePurchaseInput,
  ): Promise<PurchaseOutput> {
    return await db.transaction(async (tx) => {
      const [existingPurchase] = await tx
        .select()
        .from(purchases)
        .where(and(eq(purchases.id, purchaseId), eq(purchases.restaurantId, restaurantId)))
        .for('update');

      if (!existingPurchase) {
        throw AppError.notFound('Purchase not found');
      }

      const existingLines = await tx
        .select()
        .from(purchaseLines)
        .where(eq(purchaseLines.purchaseId, purchaseId));

      let totalPurchasePaise = existingPurchase.totalPaise;

      if (input.lines) {
        for (const oldLine of existingLines) {
          const [item] = await tx
            .select()
            .from(inventoryItems)
            .where(
              and(
                eq(inventoryItems.id, oldLine.itemId),
                eq(inventoryItems.restaurantId, restaurantId),
              ),
            )
            .for('update');

          if (item) {
            const currentStock = Number(item.currentStock);
            const oldQty = Number(oldLine.quantity);
            const revertedStock = Number((currentStock - oldQty).toFixed(3));

            await tx
              .update(inventoryItems)
              .set({
                currentStock: String(revertedStock.toFixed(3)),
                updatedAt: new Date(),
              })
              .where(eq(inventoryItems.id, item.id));

            await tx.insert(stockMovements).values({
              restaurantId,
              itemId: item.id,
              type: 'adjustment',
              quantity: String((-oldQty).toFixed(3)),
              reason: `Compensating reversal for edit of Purchase #${purchaseId.slice(0, 8)}`,
              refPurchaseId: purchaseId,
              movementDate: existingPurchase.purchaseDate,
              costSnapshotPaisePerUnit: oldLine.unitPricePaise,
              createdBy: userId,
            });
          }
        }

        await tx.delete(purchaseLines).where(eq(purchaseLines.purchaseId, purchaseId));

        totalPurchasePaise = 0;
        for (const newLine of input.lines) {
          totalPurchasePaise += newLine.lineTotalPaise;

          const [item] = await tx
            .select()
            .from(inventoryItems)
            .where(
              and(
                eq(inventoryItems.id, newLine.itemId),
                eq(inventoryItems.restaurantId, restaurantId),
              ),
            )
            .for('update');

          if (!item) {
            throw AppError.notFound(`Inventory item ${newLine.itemId} not found`);
          }

          const currentStock = Number(item.currentStock);
          const currentAvgCost = item.avgCostPaisePerUnit;
          const newQty = Number(newLine.quantity);

          const newAvgCost = calculateWeightedAverageCostPaise({
            currentStock,
            currentAvgCostPaisePerUnit: currentAvgCost,
            purchaseQuantity: newQty,
            purchaseTotalPaise: newLine.lineTotalPaise,
          });

          const newStock = Number((currentStock + newQty).toFixed(3));

          await tx
            .update(inventoryItems)
            .set({
              currentStock: String(newStock.toFixed(3)),
              lastPurchasePricePaisePerUnit: newLine.unitPricePaise,
              avgCostPaisePerUnit: newAvgCost,
              updatedAt: new Date(),
            })
            .where(eq(inventoryItems.id, item.id));

          await tx.insert(purchaseLines).values({
            purchaseId,
            itemId: item.id,
            quantity: String(newQty.toFixed(3)),
            unitPricePaise: newLine.unitPricePaise,
            lineTotalPaise: newLine.lineTotalPaise,
          });

          await tx.insert(stockMovements).values({
            restaurantId,
            itemId: item.id,
            type: 'purchase',
            quantity: String(newQty.toFixed(3)),
            reason: `Purchase edit adjustment #${purchaseId.slice(0, 8)}`,
            refPurchaseId: purchaseId,
            movementDate: input.purchaseDate || existingPurchase.purchaseDate,
            costSnapshotPaisePerUnit: newLine.unitPricePaise,
            createdBy: userId,
          });
        }
      }

      const [updatedPurchase] = await tx
        .update(purchases)
        .set({
          supplierId:
            input.supplierId !== undefined ? input.supplierId : existingPurchase.supplierId,
          purchaseDate: input.purchaseDate ?? existingPurchase.purchaseDate,
          invoiceRef: input.invoiceRef !== undefined ? input.invoiceRef : existingPurchase.invoiceRef,
          totalPaise: totalPurchasePaise,
          paidStatus: input.paidStatus ?? existingPurchase.paidStatus,
          note: input.note !== undefined ? input.note : existingPurchase.note,
          updatedAt: new Date(),
        })
        .where(eq(purchases.id, purchaseId))
        .returning();

      const finalLines = await tx
        .select({
          id: purchaseLines.id,
          purchaseId: purchaseLines.purchaseId,
          itemId: purchaseLines.itemId,
          quantity: purchaseLines.quantity,
          unitPricePaise: purchaseLines.unitPricePaise,
          lineTotalPaise: purchaseLines.lineTotalPaise,
          itemName: inventoryItems.name,
          itemUnit: inventoryItems.unit,
        })
        .from(purchaseLines)
        .innerJoin(inventoryItems, eq(purchaseLines.itemId, inventoryItems.id))
        .where(eq(purchaseLines.purchaseId, purchaseId));

      let supplierName: string | null = null;
      if (updatedPurchase!.supplierId) {
        const [sup] = await tx
          .select({ name: suppliers.name })
          .from(suppliers)
          .where(eq(suppliers.id, updatedPurchase!.supplierId))
          .limit(1);
        supplierName = sup?.name || null;
      }

      return {
        id: updatedPurchase!.id,
        restaurantId: updatedPurchase!.restaurantId,
        supplierId: updatedPurchase!.supplierId,
        supplierName,
        purchaseDate: String(updatedPurchase!.purchaseDate),
        invoiceRef: updatedPurchase!.invoiceRef,
        totalPaise: updatedPurchase!.totalPaise,
        paidStatus: updatedPurchase!.paidStatus as PurchaseOutput['paidStatus'],
        note: updatedPurchase!.note,
        createdBy: updatedPurchase!.createdBy,
        lines: finalLines.map((l) => ({
          id: l.id,
          purchaseId: l.purchaseId,
          itemId: l.itemId,
          itemName: l.itemName,
          itemUnit: l.itemUnit,
          quantity: Number(l.quantity),
          unitPricePaise: l.unitPricePaise,
          lineTotalPaise: l.lineTotalPaise,
        })),
        createdAt: updatedPurchase!.createdAt.toISOString(),
        updatedAt: updatedPurchase!.updatedAt.toISOString(),
      };
    });
  }

  static async listPurchases(params: {
    restaurantId: string;
    supplierId?: string;
    paidStatus?: 'paid' | 'unpaid' | 'partial';
  }): Promise<PurchaseOutput[]> {
    const { restaurantId, supplierId, paidStatus } = params;

    const conditions = [eq(purchases.restaurantId, restaurantId)];
    if (supplierId) {
      conditions.push(eq(purchases.supplierId, supplierId));
    }
    if (paidStatus) {
      conditions.push(eq(purchases.paidStatus, paidStatus));
    }

    const list = await db
      .select({
        purchase: purchases,
        supplierName: suppliers.name,
      })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .where(and(...conditions))
      .orderBy(desc(purchases.purchaseDate), desc(purchases.createdAt));

    const results: PurchaseOutput[] = [];

    for (const row of list) {
      const p = row.purchase;
      const lines = await db
        .select({
          id: purchaseLines.id,
          purchaseId: purchaseLines.purchaseId,
          itemId: purchaseLines.itemId,
          quantity: purchaseLines.quantity,
          unitPricePaise: purchaseLines.unitPricePaise,
          lineTotalPaise: purchaseLines.lineTotalPaise,
          itemName: inventoryItems.name,
          itemUnit: inventoryItems.unit,
        })
        .from(purchaseLines)
        .innerJoin(inventoryItems, eq(purchaseLines.itemId, inventoryItems.id))
        .where(eq(purchaseLines.purchaseId, p.id));

      results.push({
        id: p.id,
        restaurantId: p.restaurantId,
        supplierId: p.supplierId,
        supplierName: row.supplierName || null,
        purchaseDate: String(p.purchaseDate),
        invoiceRef: p.invoiceRef,
        totalPaise: p.totalPaise,
        paidStatus: p.paidStatus as PurchaseOutput['paidStatus'],
        note: p.note,
        createdBy: p.createdBy,
        lines: lines.map((l) => ({
          id: l.id,
          purchaseId: l.purchaseId,
          itemId: l.itemId,
          itemName: l.itemName,
          itemUnit: l.itemUnit,
          quantity: Number(l.quantity),
          unitPricePaise: l.unitPricePaise,
          lineTotalPaise: l.lineTotalPaise,
        })),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      });
    }

    return results;
  }
}
