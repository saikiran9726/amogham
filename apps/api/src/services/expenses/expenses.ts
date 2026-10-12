import { eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { expenses, expenseCategories, users } from '../../db/schema/index.js';
import {
  type CreateExpenseInput,
  type UpdateExpenseInput,
  type CopyRecurringExpensesInput,
  type ExpenseOutput,
  type PaymentSource,
  AppError,
} from '@restaurant-os/shared';

export class ExpenseCrudService {
  static async listExpenses(params: {
    restaurantId: string;
    month?: string; // YYYY-MM
    categoryId?: string;
    paymentSource?: string;
    limit?: number;
    offset?: number;
  }): Promise<ExpenseOutput[]> {
    const { restaurantId, month, categoryId, paymentSource, limit = 100, offset = 0 } = params;

    const query = db
      .select({
        id: expenses.id,
        restaurantId: expenses.restaurantId,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        countsAsOperating: expenseCategories.countsAsOperating,
        amountPaise: expenses.amountPaise,
        expenseDate: expenses.expenseDate,
        month: expenses.month,
        description: expenses.description,
        reference: expenses.reference,
        paymentSource: expenses.paymentSource,
        paidFromTill: expenses.paidFromTill,
        createdBy: expenses.createdBy,
        createdByName: users.name,
        createdAt: expenses.createdAt,
        updatedAt: expenses.updatedAt,
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .leftJoin(users, eq(expenses.createdBy, users.id))
      .where(
        and(
          eq(expenses.restaurantId, restaurantId),
          month ? eq(expenses.month, month) : undefined,
          categoryId ? eq(expenses.categoryId, categoryId) : undefined,
          paymentSource ? eq(expenses.paymentSource, paymentSource) : undefined,
        ),
      )
      .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
      .limit(limit)
      .offset(offset);

    const rows = await query;

    return rows.map((r) => ({
      id: r.id,
      restaurantId: r.restaurantId,
      categoryId: r.categoryId || '',
      categoryName: r.categoryName || 'General',
      countsAsOperating: r.countsAsOperating !== null ? r.countsAsOperating : true,
      amountPaise: r.amountPaise,
      expenseDate: String(r.expenseDate),
      month: r.month,
      description: r.description,
      reference: r.reference,
      paymentSource: r.paymentSource as PaymentSource,
      paidFromTill: r.paidFromTill,
      createdBy: r.createdBy,
      createdByName: r.createdByName,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  static async createExpense(
    restaurantId: string,
    userId: string,
    input: CreateExpenseInput,
  ): Promise<ExpenseOutput> {
    const month = input.expenseDate.slice(0, 7); // YYYY-MM

    const [category] = await db
      .select()
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.id, input.categoryId),
          eq(expenseCategories.restaurantId, restaurantId),
        ),
      )
      .limit(1);

    if (!category) {
      throw AppError.notFound('Expense category not found');
    }

    const [created] = await db
      .insert(expenses)
      .values({
        restaurantId,
        categoryId: input.categoryId,
        amountPaise: input.amountPaise,
        businessDate: input.expenseDate,
        expenseDate: input.expenseDate,
        month,
        description: input.description,
        reference: input.reference || null,
        paymentSource: input.paymentSource,
        paidFromTill: input.paymentSource === 'till',
        createdBy: userId,
      })
      .returning();

    return {
      id: created!.id,
      restaurantId: created!.restaurantId,
      categoryId: category.id,
      categoryName: category.name,
      countsAsOperating: category.countsAsOperating,
      amountPaise: created!.amountPaise,
      expenseDate: String(created!.expenseDate),
      month: created!.month,
      description: created!.description,
      reference: created!.reference,
      paymentSource: created!.paymentSource as PaymentSource,
      paidFromTill: created!.paidFromTill,
      createdBy: userId,
      createdAt: created!.createdAt.toISOString(),
      updatedAt: created!.updatedAt.toISOString(),
    };
  }

  static async updateExpense(
    restaurantId: string,
    expenseId: string,
    _userId: string,
    input: UpdateExpenseInput,
  ): Promise<ExpenseOutput> {
    const [existing] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Expense record not found');
    }

    const newDate = input.expenseDate ?? String(existing.expenseDate);
    const newMonth = newDate.slice(0, 7);

    const [updated] = await db
      .update(expenses)
      .set({
        categoryId: input.categoryId ?? existing.categoryId,
        amountPaise: input.amountPaise ?? existing.amountPaise,
        expenseDate: newDate,
        businessDate: newDate,
        month: newMonth,
        description: input.description ?? existing.description,
        reference: input.reference !== undefined ? input.reference : existing.reference,
        paymentSource: input.paymentSource ?? existing.paymentSource,
        paidFromTill: (input.paymentSource ?? existing.paymentSource) === 'till',
        edited: true,
        lastEditReason: input.editReason,
        updatedAt: new Date(),
      })
      .where(eq(expenses.id, expenseId))
      .returning();

    const [cat] = await db
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, updated!.categoryId!))
      .limit(1);

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      categoryId: cat?.id || '',
      categoryName: cat?.name || 'General',
      countsAsOperating: cat?.countsAsOperating ?? true,
      amountPaise: updated!.amountPaise,
      expenseDate: String(updated!.expenseDate),
      month: updated!.month,
      description: updated!.description,
      reference: updated!.reference,
      paymentSource: updated!.paymentSource as PaymentSource,
      paidFromTill: updated!.paidFromTill,
      createdBy: updated!.createdBy,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }

  static async deleteExpense(
    restaurantId: string,
    expenseId: string,
  ): Promise<{ success: boolean; deletedExpense: Record<string, unknown> }> {
    const [existing] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Expense record not found');
    }

    await db.delete(expenses).where(eq(expenses.id, expenseId));
    return { success: true, deletedExpense: existing as unknown as Record<string, unknown> };
  }

  static async copyRecurringExpenses(
    restaurantId: string,
    userId: string,
    input: CopyRecurringExpensesInput,
  ): Promise<{ copiedCount: number; newExpenses: ExpenseOutput[] }> {
    const sourceExpenses = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.restaurantId, restaurantId), inArray(expenses.id, input.expenseIds)));

    const createdList: ExpenseOutput[] = [];

    for (const item of sourceExpenses) {
      const created = await this.createExpense(restaurantId, userId, {
        categoryId: item.categoryId!,
        amountPaise: item.amountPaise,
        expenseDate: input.targetDate,
        description: item.description,
        reference: item.reference,
        paymentSource: item.paymentSource as PaymentSource,
      });
      createdList.push(created);
    }

    return {
      copiedCount: createdList.length,
      newExpenses: createdList,
    };
  }
}
