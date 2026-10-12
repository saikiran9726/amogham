import { eq, and, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  expenses,
  expenseCategories,
  dailySummaries,
  stockMovements,
  purchases,
  bills,
  monthlyEvaluations,
  users,
} from '../../db/schema/index.js';
import {
  calculateMonthlyProfitability,
  explainMonthComparison,
  type MonthlyReviewResponse,
  type MonthCompletenessChecklist,
  type ExpenseCategorySummary,
  type SaveMonthlySnapshotInput,
  type MonthlyEvaluationSnapshotOutput,
} from '@restaurant-os/shared';
import { ExpenseCategoryService } from './categories.js';

export class ExpenseReviewService {
  static async getMonthlyReview(
    restaurantId: string,
    monthStr: string, // YYYY-MM
  ): Promise<MonthlyReviewResponse> {
    const [yearStr, mNumStr] = monthStr.split('-');
    const year = parseInt(yearStr!, 10);
    const monthIndex = parseInt(mNumStr!, 10) - 1; // 0-indexed

    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

    // 1. Data Completeness Checklist
    const closedSummaries = await db
      .select()
      .from(dailySummaries)
      .where(
        and(
          eq(dailySummaries.restaurantId, restaurantId),
          gte(dailySummaries.businessDate, startDate),
          lte(dailySummaries.businessDate, endDate),
          eq(dailySummaries.status, 'closed'),
        ),
      );

    const closedDaysCount = closedSummaries.length;
    const unclosedDaysCount = Math.max(0, daysInMonth - closedDaysCount);

    const monthExpenses = await db
      .select({
        id: expenses.id,
        amountPaise: expenses.amountPaise,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        countsAsOperating: expenseCategories.countsAsOperating,
        paymentSource: expenses.paymentSource,
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(and(eq(expenses.restaurantId, restaurantId), eq(expenses.month, monthStr)));

    const hasRentExpense = monthExpenses.some((e) =>
      e.categoryName?.toLowerCase().includes('rent'),
    );
    const hasSalariesExpense = monthExpenses.some((e) =>
      e.categoryName?.toLowerCase().includes('salar'),
    );
    const hasUtilitiesExpense = monthExpenses.some(
      (e) =>
        e.categoryName?.toLowerCase().includes('electric') ||
        e.categoryName?.toLowerCase().includes('gas') ||
        e.categoryName?.toLowerCase().includes('water'),
    );

    const stockCounts = await db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.restaurantId, restaurantId),
          eq(stockMovements.type, 'stock_count'),
          gte(stockMovements.movementDate, startDate as unknown as string),
          lte(stockMovements.movementDate, endDate as unknown as string),
        ),
      );

    const hasOpeningStockCount = stockCounts.some(
      (s) => String(s.movementDate) <= `${monthStr}-05`,
    );
    const hasClosingStockCount = stockCounts.some(
      (s) => String(s.movementDate) >= `${monthStr}-${daysInMonth - 4}`,
    );

    const missingItems: string[] = [];
    if (closedDaysCount < daysInMonth)
      missingItems.push(`${unclosedDaysCount} unclosed business days`);
    if (!hasRentExpense) missingItems.push('Rent expense not logged');
    if (!hasSalariesExpense) missingItems.push('Salaries / wages expense not logged');
    if (!hasUtilitiesExpense) missingItems.push('Electricity / Gas utility bill not logged');
    if (!hasClosingStockCount)
      missingItems.push('Closing physical stock count missing (using purchase costing method)');

    let completenessScore = 0;
    if (daysInMonth > 0) completenessScore += (closedDaysCount / daysInMonth) * 40;
    if (hasRentExpense) completenessScore += 20;
    if (hasSalariesExpense) completenessScore += 20;
    if (hasUtilitiesExpense) completenessScore += 10;
    if (hasClosingStockCount) completenessScore += 10;
    const completenessPercent = Math.min(100, Math.round(completenessScore));

    const completeness: MonthCompletenessChecklist = {
      daysInMonth,
      closedDaysCount,
      unclosedDaysCount,
      isAllDaysClosed: closedDaysCount >= daysInMonth,
      hasRentExpense,
      hasSalariesExpense,
      hasUtilitiesExpense,
      hasOpeningStockCount,
      hasClosingStockCount,
      completenessPercent,
      missingItems,
    };

    // 2. Revenue (Net sales excluding GST/taxes, net of discounts and refunds)
    const monthBills = await db
      .select({
        subtotalPaise: bills.subtotalPaise,
        discountPaise: bills.discountPaise,
        refundsPaise: sql<number>`coalesce((select sum(amount_paise) from refunds where refunds.bill_id = bills.id), 0)`,
        status: bills.status,
      })
      .from(bills)
      .where(
        and(
          eq(bills.restaurantId, restaurantId),
          gte(bills.businessDate, startDate),
          lte(bills.businessDate, endDate),
          inArray(bills.status, ['paid', 'partially_paid']),
        ),
      );

    let revenuePaise = 0;
    for (const b of monthBills) {
      const netForBill = Math.max(0, b.subtotalPaise - b.discountPaise - b.refundsPaise);
      revenuePaise += netForBill;
    }

    // 3. Purchases in month
    const monthPurchasesList = await db
      .select({ totalPaise: purchases.totalPaise })
      .from(purchases)
      .where(
        and(
          eq(purchases.restaurantId, restaurantId),
          gte(purchases.purchaseDate, startDate as unknown as string),
          lte(purchases.purchaseDate, endDate as unknown as string),
        ),
      );

    const monthPurchasesPaise = monthPurchasesList.reduce((sum, p) => sum + p.totalPaise, 0);

    // 4. Waste cost from waste movements
    const wasteList = await db
      .select({
        quantity: stockMovements.quantity,
        costSnapshot: stockMovements.costSnapshotPaisePerUnit,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.restaurantId, restaurantId),
          eq(stockMovements.type, 'waste'),
          gte(stockMovements.movementDate, startDate as unknown as string),
          lte(stockMovements.movementDate, endDate as unknown as string),
        ),
      );

    const wasteCostPaise = wasteList.reduce((sum, w) => {
      const qty = Math.abs(Number(w.quantity));
      return sum + Math.round(qty * w.costSnapshot);
    }, 0);

    // 5. Operating Expenses
    const operatingExpensesList = monthExpenses.filter((e) => e.countsAsOperating);
    const operatingExpensesPaise = operatingExpensesList.reduce((sum, e) => sum + e.amountPaise, 0);

    // 6. Profitability Math
    const profitability = calculateMonthlyProfitability({
      netSalesPaise: revenuePaise,
      operatingExpensesPaise,
      monthPurchasesPaise,
      hasOpeningAndClosingCounts: hasOpeningStockCount && hasClosingStockCount,
      wasteCostPaise,
    });

    // 7. Payment Method Mix from payments
    const paymentsSummary = await db
      .select({
        cashPaise: sql<number>`coalesce(sum(case when method = 'cash' then amount_paise else 0 end), 0)`,
        upiPaise: sql<number>`coalesce(sum(case when method = 'upi' then amount_paise else 0 end), 0)`,
        cardPaise: sql<number>`coalesce(sum(case when method = 'card' then amount_paise else 0 end), 0)`,
      })
      .from(bills)
      .innerJoin(sql`payments`, sql`payments.bill_id = bills.id`)
      .where(
        and(
          eq(bills.restaurantId, restaurantId),
          gte(bills.businessDate, startDate),
          lte(bills.businessDate, endDate),
        ),
      );

    const paymentMethodMix = {
      cashPaise: Number(paymentsSummary[0]?.cashPaise || 0),
      upiPaise: Number(paymentsSummary[0]?.upiPaise || 0),
      cardPaise: Number(paymentsSummary[0]?.cardPaise || 0),
    };

    // 8. Previous Month Comparison
    const prevMonthDate = new Date(year, monthIndex - 1, 1);
    const prevMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
    const prevDays = new Date(
      prevMonthDate.getFullYear(),
      prevMonthDate.getMonth() + 1,
      0,
    ).getDate();
    const prevStart = `${prevMonthStr}-01`;
    const prevEnd = `${prevMonthStr}-${String(prevDays).padStart(2, '0')}`;

    const prevBills = await db
      .select({
        subtotalPaise: bills.subtotalPaise,
        discountPaise: bills.discountPaise,
      })
      .from(bills)
      .where(
        and(
          eq(bills.restaurantId, restaurantId),
          gte(bills.businessDate, prevStart),
          lte(bills.businessDate, prevEnd),
          inArray(bills.status, ['paid', 'partially_paid']),
        ),
      );

    const prevRevenuePaise = prevBills.reduce(
      (s, b) => s + Math.max(0, b.subtotalPaise - b.discountPaise),
      0,
    );

    const prevPurchases = await db
      .select({ totalPaise: purchases.totalPaise })
      .from(purchases)
      .where(
        and(
          eq(purchases.restaurantId, restaurantId),
          gte(purchases.purchaseDate, prevStart as unknown as string),
          lte(purchases.purchaseDate, prevEnd as unknown as string),
        ),
      );
    const prevSuppliesCostPaise = prevPurchases.reduce((s, p) => s + p.totalPaise, 0);

    const prevExp = await db
      .select({ amountPaise: expenses.amountPaise })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(
        and(
          eq(expenses.restaurantId, restaurantId),
          eq(expenses.month, prevMonthStr),
          eq(expenseCategories.countsAsOperating, true),
        ),
      );
    const prevOperatingExpensesPaise = prevExp.reduce((s, e) => s + e.amountPaise, 0);

    const prevProfitPaise = prevRevenuePaise - prevSuppliesCostPaise - prevOperatingExpensesPaise;
    const prevMarginPercent =
      prevRevenuePaise > 0 ? Number(((prevProfitPaise / prevRevenuePaise) * 100).toFixed(1)) : null;
    const prevSuppliesPercent =
      prevRevenuePaise > 0
        ? Number(((prevSuppliesCostPaise / prevRevenuePaise) * 100).toFixed(1))
        : null;

    const explanation = explainMonthComparison({
      currentProfitPaise: profitability.estimatedProfitPaise,
      currentMarginPercent: profitability.profitMarginPercent,
      currentSuppliesPercent: profitability.suppliesPercentOfRevenue,
      currentExpensesPercent: profitability.expensesPercentOfRevenue,
      prevProfitPaise,
      prevMarginPercent,
      prevSuppliesPercent,
      prevExpensesPercent:
        prevRevenuePaise > 0
          ? Number(((prevOperatingExpensesPaise / prevRevenuePaise) * 100).toFixed(1))
          : null,
    });

    const previousMonthComparison =
      prevRevenuePaise > 0
        ? {
            prevMonth: prevMonthStr,
            prevRevenuePaise,
            prevSuppliesCostPaise,
            prevOperatingExpensesPaise,
            prevProfitPaise,
            prevMarginPercent,
            explanation,
          }
        : null;

    // 9. Category Totals Breakdown
    const categories = await ExpenseCategoryService.listCategories(restaurantId);
    const categoryTotals: ExpenseCategorySummary[] = categories.map((cat) => {
      const curSum = monthExpenses
        .filter((e) => e.categoryId === cat.id)
        .reduce((sum, e) => sum + e.amountPaise, 0);
      const curCount = monthExpenses.filter((e) => e.categoryId === cat.id).length;

      return {
        categoryId: cat.id,
        categoryName: cat.name,
        countsAsOperating: cat.countsAsOperating,
        currentMonthPaise: curSum,
        previousMonthPaise: 0,
        changePercent: null,
        count: curCount,
      };
    });

    const [savedSnap] = await db
      .select({ createdAt: monthlyEvaluations.createdAt })
      .from(monthlyEvaluations)
      .where(
        and(
          eq(monthlyEvaluations.restaurantId, restaurantId),
          eq(monthlyEvaluations.month, monthStr),
        ),
      )
      .orderBy(desc(monthlyEvaluations.version))
      .limit(1);

    const isCurrentMonth = monthStr === new Date().toISOString().slice(0, 7);

    return {
      month: monthStr,
      isCurrentMonth,
      completeness,
      revenuePaise: profitability.revenuePaise,
      suppliesCostPaise: profitability.suppliesCostPaise,
      suppliesMethod: profitability.suppliesMethod,
      suppliesMethodReason: profitability.suppliesMethodReason,
      wasteCostPaise: profitability.wasteCostPaise,
      operatingExpensesPaise: profitability.operatingExpensesPaise,
      estimatedProfitPaise: profitability.estimatedProfitPaise,
      profitMarginPercent: profitability.profitMarginPercent,
      suppliesPercentOfRevenue: profitability.suppliesPercentOfRevenue,
      expensesPercentOfRevenue: profitability.expensesPercentOfRevenue,
      paymentMethodMix,
      previousMonthComparison,
      categoryTotals,
      savedSnapshotAt: savedSnap?.createdAt ? savedSnap.createdAt.toISOString() : null,
    };
  }

  static async saveMonthlySnapshot(
    restaurantId: string,
    userId: string,
    input: SaveMonthlySnapshotInput,
  ): Promise<MonthlyEvaluationSnapshotOutput> {
    const review = await this.getMonthlyReview(restaurantId, input.month);

    const existingSnaps = await db
      .select({ version: monthlyEvaluations.version })
      .from(monthlyEvaluations)
      .where(
        and(
          eq(monthlyEvaluations.restaurantId, restaurantId),
          eq(monthlyEvaluations.month, input.month),
        ),
      )
      .orderBy(desc(monthlyEvaluations.version))
      .limit(1);

    const nextVersion = (existingSnaps[0]?.version || 0) + 1;

    const [saved] = await db
      .insert(monthlyEvaluations)
      .values({
        restaurantId,
        month: input.month,
        version: nextVersion,
        revenuePaise: review.revenuePaise,
        suppliesCostPaise: review.suppliesCostPaise,
        suppliesMethod: review.suppliesMethod,
        operatingExpensesPaise: review.operatingExpensesPaise,
        estimatedProfitPaise: review.estimatedProfitPaise,
        profitMarginPercent:
          review.profitMarginPercent !== null ? String(review.profitMarginPercent) : null,
        completenessPercent: review.completeness.completenessPercent,
        inputs: {
          daysInMonth: review.completeness.daysInMonth,
          closedDaysCount: review.completeness.closedDaysCount,
          wasteCostPaise: review.wasteCostPaise,
          paymentMethodMix: review.paymentMethodMix,
        },
        outputs: {
          profitMarginPercent: review.profitMarginPercent,
          suppliesPercentOfRevenue: review.suppliesPercentOfRevenue,
          expensesPercentOfRevenue: review.expensesPercentOfRevenue,
        },
        note: input.note || null,
        createdBy: userId,
      })
      .returning();

    return {
      id: saved!.id,
      restaurantId: saved!.restaurantId,
      month: saved!.month,
      version: saved!.version,
      revenuePaise: saved!.revenuePaise,
      suppliesCostPaise: saved!.suppliesCostPaise,
      suppliesMethod: saved!.suppliesMethod,
      operatingExpensesPaise: saved!.operatingExpensesPaise,
      estimatedProfitPaise: saved!.estimatedProfitPaise,
      profitMarginPercent: saved!.profitMarginPercent ? Number(saved!.profitMarginPercent) : null,
      completenessPercent: saved!.completenessPercent,
      inputs: saved!.inputs as unknown as MonthlyEvaluationSnapshotOutput['inputs'],
      outputs: saved!.outputs as unknown as MonthlyEvaluationSnapshotOutput['outputs'],
      note: saved!.note,
      createdBy: saved!.createdBy,
      createdAt: saved!.createdAt.toISOString(),
    };
  }

  static async listSnapshots(restaurantId: string): Promise<MonthlyEvaluationSnapshotOutput[]> {
    const list = await db
      .select({
        id: monthlyEvaluations.id,
        restaurantId: monthlyEvaluations.restaurantId,
        month: monthlyEvaluations.month,
        version: monthlyEvaluations.version,
        revenuePaise: monthlyEvaluations.revenuePaise,
        suppliesCostPaise: monthlyEvaluations.suppliesCostPaise,
        suppliesMethod: monthlyEvaluations.suppliesMethod,
        operatingExpensesPaise: monthlyEvaluations.operatingExpensesPaise,
        estimatedProfitPaise: monthlyEvaluations.estimatedProfitPaise,
        profitMarginPercent: monthlyEvaluations.profitMarginPercent,
        completenessPercent: monthlyEvaluations.completenessPercent,
        inputs: monthlyEvaluations.inputs,
        outputs: monthlyEvaluations.outputs,
        note: monthlyEvaluations.note,
        createdBy: monthlyEvaluations.createdBy,
        createdByName: users.name,
        createdAt: monthlyEvaluations.createdAt,
      })
      .from(monthlyEvaluations)
      .leftJoin(users, eq(monthlyEvaluations.createdBy, users.id))
      .where(eq(monthlyEvaluations.restaurantId, restaurantId))
      .orderBy(desc(monthlyEvaluations.month), desc(monthlyEvaluations.version));

    return list.map((s) => ({
      id: s.id,
      restaurantId: s.restaurantId,
      month: s.month,
      version: s.version,
      revenuePaise: s.revenuePaise,
      suppliesCostPaise: s.suppliesCostPaise,
      suppliesMethod: s.suppliesMethod,
      operatingExpensesPaise: s.operatingExpensesPaise,
      estimatedProfitPaise: s.estimatedProfitPaise,
      profitMarginPercent: s.profitMarginPercent ? Number(s.profitMarginPercent) : null,
      completenessPercent: s.completenessPercent,
      inputs: s.inputs as unknown as MonthlyEvaluationSnapshotOutput['inputs'],
      outputs: s.outputs as unknown as MonthlyEvaluationSnapshotOutput['outputs'],
      note: s.note,
      createdBy: s.createdBy,
      createdByName: s.createdByName,
      createdAt: s.createdAt.toISOString(),
    }));
  }
}
