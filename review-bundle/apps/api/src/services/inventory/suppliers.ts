import { eq, and, sql, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { suppliers, purchases } from '../../db/schema/index.js';
import { type CreateSupplierInput, type SupplierOutput, AppError } from '@restaurant-os/shared';

export class InventorySupplierService {
  static async listSuppliers(restaurantId: string): Promise<SupplierOutput[]> {
    const list = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.restaurantId, restaurantId), eq(suppliers.active, true)))
      .orderBy(asc(suppliers.name));

    const results: SupplierOutput[] = [];
    for (const sup of list) {
      const stats = await db
        .select({
          count: sql<number>`count(${purchases.id})`,
          totalPaise: sql<number>`coalesce(sum(${purchases.totalPaise}), 0)`,
        })
        .from(purchases)
        .where(and(eq(purchases.supplierId, sup.id), eq(purchases.restaurantId, restaurantId)));

      results.push({
        id: sup.id,
        restaurantId: sup.restaurantId,
        name: sup.name,
        phone: sup.phone,
        notes: sup.notes,
        active: sup.active,
        totalPurchasesCount: Number(stats[0]?.count || 0),
        totalSpendPaise: Number(stats[0]?.totalPaise || 0),
        createdAt: sup.createdAt.toISOString(),
        updatedAt: sup.updatedAt.toISOString(),
      });
    }

    return results;
  }

  static async createSupplier(
    restaurantId: string,
    input: CreateSupplierInput,
  ): Promise<SupplierOutput> {
    const [existing] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(
        and(
          eq(suppliers.restaurantId, restaurantId),
          sql`lower(${suppliers.name}) = lower(${input.name})`,
        ),
      )
      .limit(1);

    if (existing) {
      throw AppError.badRequest(`Supplier "${input.name}" already exists`);
    }

    const [created] = await db
      .insert(suppliers)
      .values({
        restaurantId,
        name: input.name,
        phone: input.phone || null,
        notes: input.notes || null,
        active: input.active !== undefined ? input.active : true,
      })
      .returning();

    return {
      id: created!.id,
      restaurantId: created!.restaurantId,
      name: created!.name,
      phone: created!.phone,
      notes: created!.notes,
      active: created!.active,
      totalPurchasesCount: 0,
      totalSpendPaise: 0,
      createdAt: created!.createdAt.toISOString(),
      updatedAt: created!.updatedAt.toISOString(),
    };
  }
}
