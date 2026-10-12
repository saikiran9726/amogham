import { eq, and, desc, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { insights } from '../../db/schema/alerts-insights.js';
import { dailySummaries } from '../../db/schema/daily-summaries.js';
import { monthlyEvaluations } from '../../db/schema/expenses.js';
import { customers } from '../../db/schema/customers.js';
import {
  decomposeSalesChange,
  type InsightOutput,
  type DismissInsightInput,
  type InsightEvidence,
  AppError,
} from '@restaurant-os/shared';
import { AlertSettingsService } from './settings.js';

export class InsightsService {
  /**
   * Generate deterministic plain-English business insights.
   * Ranks by materiality, max 6 per day, avoids repeating text within 7 days.
   */
  static async generateInsights(restaurantId: string): Promise<InsightOutput[]> {
    const settings = await AlertSettingsService.getSettings(restaurantId);
    const candidateInsights: Array<{
      kind: 'sales_change' | 'unreturned_regulars' | 'margin_change';
      period: 'daily' | 'weekly' | 'monthly';
      text: string;
      evidence: InsightEvidence;
      materialityScore: number;
    }> = [];

    // 1. Sales Change (3-factor additive decomposition: Sales = Orders + AOV + Mix)
    if (settings.enabledInsights.sales_change) {
      const summaries = await db
        .select()
        .from(dailySummaries)
        .where(eq(dailySummaries.restaurantId, restaurantId))
        .orderBy(desc(dailySummaries.businessDate))
        .limit(2);

      if (summaries.length >= 2) {
        const curr = summaries[0]!;
        const prev = summaries[1]!;

        const decomp = decomposeSalesChange({
          currentSalesPaise: curr.netSalesPaise,
          currentOrdersCount: curr.ordersCount,
          baselineSalesPaise: prev.netSalesPaise,
          baselineOrdersCount: prev.ordersCount,
        });

        const materiality = Math.min(
          100,
          Math.round(Math.abs(decomp.totalChangePaise) / 50000) + 40,
        );

        candidateInsights.push({
          kind: 'sales_change',
          period: 'daily',
          text: decomp.plainEnglishExplanation,
          evidence: {
            metricName: 'Net Sales Change',
            currentValue: `₹${(curr.netSalesPaise / 100).toFixed(0)}`,
            previousValue: `₹${(prev.netSalesPaise / 100).toFixed(0)}`,
            difference: `${decomp.totalChangePaise >= 0 ? '+' : ''}₹${(decomp.totalChangePaise / 100).toFixed(0)}`,
            details: {
              ordersEffectPaise: decomp.ordersContributionPaise,
              ordersEffectPercent: decomp.ordersContributionPercent,
              aovEffectPaise: decomp.aovContributionPaise,
              aovEffectPercent: decomp.aovContributionPercent,
              mixEffectPaise: decomp.mixContributionPaise,
              mixEffectPercent: decomp.mixContributionPercent,
            },
          },
          materialityScore: materiality,
        });
      }
    }

    // 2. Regular customers who haven't returned in 30+ days
    if (settings.enabledInsights.unreturned_regulars) {
      const inactiveThreshold = new Date(
        Date.now() - settings.regularCustomerInactiveDays * 86400 * 1000,
      );

      const allCustomers = await db
        .select()
        .from(customers)
        .where(eq(customers.restaurantId, restaurantId));

      // Regulars who have visitCount >= 3 and lastVisitAt < threshold
      const inactiveRegulars = allCustomers.filter((c) => {
        if ((c.visitCount ?? 0) < 3) return false;
        if (!c.lastVisitAt) return true;
        return new Date(c.lastVisitAt) <= inactiveThreshold;
      });

      if (inactiveRegulars.length > 0) {
        candidateInsights.push({
          kind: 'unreturned_regulars',
          period: 'weekly',
          text: `${inactiveRegulars.length} regular guests haven't visited in over ${settings.regularCustomerInactiveDays} days. Consider offering an incentive or loyalty reminder.`,
          evidence: {
            metricName: 'Lapsed Regular Customers',
            currentValue: `${inactiveRegulars.length} guests`,
            details: {
              guestCount: inactiveRegulars.length,
              inactiveThresholdDays: settings.regularCustomerInactiveDays,
              names: inactiveRegulars.slice(0, 5).map((c) => c.name || c.phone),
            },
          },
          materialityScore: 65,
        });
      }
    }

    // 3. Operating Margin Change
    if (settings.enabledInsights.margin_change) {
      const evals = await db
        .select()
        .from(monthlyEvaluations)
        .where(eq(monthlyEvaluations.restaurantId, restaurantId))
        .orderBy(desc(monthlyEvaluations.month))
        .limit(2);

      if (evals.length >= 2) {
        const curr = evals[0]!;
        const prev = evals[1]!;
        const currMargin = Number(curr.profitMarginPercent || 0);
        const prevMargin = Number(prev.profitMarginPercent || 0);
        const diff = currMargin - prevMargin;

        const direction = diff >= 0 ? 'increased' : 'decreased';
        const sign = diff >= 0 ? '+' : '';

        candidateInsights.push({
          kind: 'margin_change',
          period: 'monthly',
          text: `Operating margin ${direction} by ${Math.abs(diff).toFixed(1)} percentage points from ${prevMargin.toFixed(1)}% in ${prev.month} to ${currMargin.toFixed(1)}% in ${curr.month}.`,
          evidence: {
            metricName: 'Monthly Operating Margin',
            currentValue: `${currMargin.toFixed(1)}%`,
            previousValue: `${prevMargin.toFixed(1)}%`,
            difference: `${sign}${diff.toFixed(1)} pts`,
            details: {
              currentMonth: curr.month,
              previousMonth: prev.month,
              currentNetProfitPaise: curr.estimatedProfitPaise,
              previousNetProfitPaise: prev.estimatedProfitPaise,
            },
          },
          materialityScore: Math.min(100, Math.round(Math.abs(diff) * 10) + 50),
        });
      }
    }

    // Filter out texts generated in the last 7 days to avoid repeated insights
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000);
    const recentInsights = await db
      .select()
      .from(insights)
      .where(and(eq(insights.restaurantId, restaurantId), gte(insights.createdAt, sevenDaysAgo)));

    const recentTexts = new Set(recentInsights.map((i) => i.text));

    // Filter out repeats and sort by materialityScore descending
    const novelInsights = candidateInsights.filter((c) => !recentTexts.has(c.text));
    novelInsights.sort((a, b) => b.materialityScore - a.materialityScore);

    // Save up to 6 top novel insights
    const toInsert = novelInsights.slice(0, 6);
    for (const item of toInsert) {
      await db.insert(insights).values({
        restaurantId,
        period: item.period,
        kind: item.kind,
        text: item.text,
        evidence: item.evidence,
        materialityScore: item.materialityScore,
      });
    }

    // Return the latest active non-dismissed insights (max 6)
    return this.listInsights(restaurantId);
  }

  /**
   * List non-dismissed insights.
   */
  static async listInsights(restaurantId: string): Promise<InsightOutput[]> {
    const rows = await db
      .select()
      .from(insights)
      .where(and(eq(insights.restaurantId, restaurantId), eq(insights.dismissed, false)))
      .orderBy(desc(insights.createdAt))
      .limit(6);

    return rows.map((r) => ({
      id: r.id,
      restaurantId: r.restaurantId,
      period: r.period,
      kind: r.kind,
      text: r.text,
      evidence: r.evidence,
      materialityScore: r.materialityScore,
      dismissed: r.dismissed,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Dismiss an insight.
   */
  static async dismissInsight(
    restaurantId: string,
    insightId: string,
    _input: DismissInsightInput,
  ): Promise<InsightOutput> {
    const [existing] = await db
      .select()
      .from(insights)
      .where(and(eq(insights.id, insightId), eq(insights.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Insight not found');
    }

    const [updated] = await db
      .update(insights)
      .set({ dismissed: true })
      .where(eq(insights.id, insightId))
      .returning();

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      period: updated!.period,
      kind: updated!.kind,
      text: updated!.text,
      evidence: updated!.evidence,
      materialityScore: updated!.materialityScore,
      dismissed: updated!.dismissed,
      createdAt: updated!.createdAt.toISOString(),
    };
  }
}
