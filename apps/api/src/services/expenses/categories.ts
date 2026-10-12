import { eq, and, sql, asc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { expenseCategories } from '../../db/schema/index.js';
import {
  type CreateExpenseCategoryInput,
  type UpdateExpenseCategoryInput,
  type ExpenseCategoryOutput,
  AppError,
} from '@restaurant-os/shared';

export class ExpenseCategoryService {
  static async listCategories(restaurantId: string): Promise<ExpenseCategoryOutput[]> {
    const list = await db
      .select()
      .from(expenseCategories)
      .where(
        and(eq(expenseCategories.restaurantId, restaurantId), eq(expenseCategories.active, true)),
      )
      .orderBy(asc(expenseCategories.name));

    return list.map((c) => ({
      id: c.id,
      restaurantId: c.restaurantId,
      name: c.name,
      description: c.description,
      countsAsOperating: c.countsAsOperating,
      active: c.active,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  static async createCategory(
    restaurantId: string,
    input: CreateExpenseCategoryInput,
  ): Promise<ExpenseCategoryOutput> {
    const [existing] = await db
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.restaurantId, restaurantId),
          sql`lower(${expenseCategories.name}) = lower(${input.name})`,
        ),
      )
      .limit(1);

    if (existing) {
      throw AppError.badRequest(`Category "${input.name}" already exists`);
    }

    const [created] = await db
      .insert(expenseCategories)
      .values({
        restaurantId,
        name: input.name,
        description: input.description || null,
        countsAsOperating: input.countsAsOperating !== undefined ? input.countsAsOperating : true,
      })
      .returning();

    return {
      id: created!.id,
      restaurantId: created!.restaurantId,
      name: created!.name,
      description: created!.description,
      countsAsOperating: created!.countsAsOperating,
      active: created!.active,
      createdAt: created!.createdAt.toISOString(),
      updatedAt: created!.updatedAt.toISOString(),
    };
  }

  static async updateCategory(
    restaurantId: string,
    categoryId: string,
    input: UpdateExpenseCategoryInput,
  ): Promise<ExpenseCategoryOutput> {
    const [existing] = await db
      .select()
      .from(expenseCategories)
      .where(
        and(eq(expenseCategories.id, categoryId), eq(expenseCategories.restaurantId, restaurantId)),
      )
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Expense category not found');
    }

    const [updated] = await db
      .update(expenseCategories)
      .set({
        name: input.name ?? existing.name,
        description: input.description !== undefined ? input.description : existing.description,
        countsAsOperating:
          input.countsAsOperating !== undefined
            ? input.countsAsOperating
            : existing.countsAsOperating,
        active: input.active !== undefined ? input.active : existing.active,
        updatedAt: new Date(),
      })
      .where(eq(expenseCategories.id, categoryId))
      .returning();

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      name: updated!.name,
      description: updated!.description,
      countsAsOperating: updated!.countsAsOperating,
      active: updated!.active,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }
}
