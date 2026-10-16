import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { alerts } from '../../db/schema/alerts-insights.js';
import { dailySummaries } from '../../db/schema/daily-summaries.js';
import { inventoryItems } from '../../db/schema/inventory.js';
import { expenses } from '../../db/schema/expenses.js';
import { bills } from '../../db/schema/bills.js';
import { paymentRequests } from '../../db/schema/payment-requests.js';
import { monthlyEvaluations } from '../../db/schema/expenses.js';
import { emitRealtimeEvent } from '../../realtime/socket.js';
import {
  type AlertOutput,
  type AcknowledgeAlertInput,
  type SnoozeAlertInput,
  type DismissAlertInput,
  type AlertItemPayload,
  AppError,
} from '@restaurant-os/shared';
import { AlertSettingsService } from './settings.js';

export class AlertsService {
  /**
   * Check and synchronize all 5 alert rules deterministically.
   * Auto-resolves alerts whose trigger conditions no longer apply.
   */
  static async checkAndSyncAlerts(restaurantId: string): Promise<AlertOutput[]> {
    const settings = await AlertSettingsService.getSettings(restaurantId);
    const now = new Date();

    // Expire snoozed alerts whose snoozedUntil has passed
    await db
      .update(alerts)
      .set({ status: 'open', snoozedUntil: null })
      .where(
        and(
          eq(alerts.restaurantId, restaurantId),
          eq(alerts.status, 'snoozed'),
          lte(alerts.snoozedUntil, now),
        ),
      );

    // Rule 1: cash_mismatch
    if (settings.enabledAlerts.cash_mismatch) {
      // Find closed days where |cashDifferencePaise| > tolerance
      const summaries = await db
        .select()
        .from(dailySummaries)
        .where(
          and(eq(dailySummaries.restaurantId, restaurantId), eq(dailySummaries.status, 'closed')),
        );

      const mismatchedSummaries = summaries.filter(
        (s) => Math.abs(s.cashDifferencePaise) > settings.cashMismatchTolerancePaise,
      );

      const currentMismatchedDates = new Set(mismatchedSummaries.map((s) => s.businessDate));

      for (const summary of mismatchedSummaries) {
        const dedupeKey = `alert:cash_mismatch:${summary.businessDate}`;
        const diffRupees = (Math.abs(summary.cashDifferencePaise) / 100).toFixed(2);
        const direction = summary.cashDifferencePaise < 0 ? 'short' : 'over';

        await this.upsertAlert({
          restaurantId,
          type: 'cash_mismatch',
          severity: 'critical',
          dedupeKey,
          payload: {
            title: `Cash mismatch on ${summary.businessDate}`,
            whatIsWrong: `Physical cash is ₹${diffRupees} ${direction} compared to expected drawer balance (tolerance is ₹${(settings.cashMismatchTolerancePaise / 100).toFixed(0)}).`,
            whyItMatters:
              'Unreconciled drawer gaps can indicate theft, billing discrepancies, or missed change returns.',
            actionLabel: 'Review Day Close',
            actionUrl: `/owner/eod?date=${summary.businessDate}`,
            context: {
              businessDate: summary.businessDate,
              expectedPaise: summary.expectedCashPaise,
              actualPaise: summary.actualCashPaise,
              differencePaise: summary.cashDifferencePaise,
            },
          },
        });
      }

      // Auto-resolve any cash_mismatch alerts where difference is now within tolerance
      const openCashAlerts = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.restaurantId, restaurantId),
            eq(alerts.type, 'cash_mismatch'),
            eq(alerts.status, 'open'),
          ),
        );

      for (const a of openCashAlerts) {
        const payloadObj = a.payload as { context?: { businessDate?: string } } | null;
        const date = payloadObj?.context?.businessDate;
        if (date && !currentMismatchedDates.has(date)) {
          await this.autoResolveAlert(a.id, 'Cash difference is now reconciled within tolerance.');
        }
      }
    }

    // Rule 2: low_stock (Grouped into ONE alert card)
    if (settings.enabledAlerts.low_stock) {
      const items = await db
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.restaurantId, restaurantId), eq(inventoryItems.active, true)));

      const lowStockItems = items.filter(
        (item) => Number(item.currentStock) <= Number(item.reorderLevel),
      );

      const dedupeKey = 'alert:low_stock';

      if (lowStockItems.length > 0) {
        const topNames = lowStockItems
          .slice(0, 3)
          .map((i) => i.name)
          .join(', ');
        const andMore = lowStockItems.length > 3 ? ` and ${lowStockItems.length - 3} more` : '';
        const itemList = lowStockItems.map((i) => ({
          id: i.id,
          name: i.name,
          currentStock: Number(i.currentStock),
          reorderLevel: Number(i.reorderLevel),
          unit: i.unit,
        }));

        await this.upsertAlert({
          restaurantId,
          type: 'low_stock',
          severity: 'warning',
          dedupeKey,
          payload: {
            title: `${lowStockItems.length} items at or below reorder level`,
            whatIsWrong: `${lowStockItems.length} ingredients are running low: ${topNames}${andMore}.`,
            whyItMatters:
              'Running out of key ingredients causes delayed orders, kitchen disruption, and lost revenue.',
            actionLabel: 'Manage Inventory',
            actionUrl: '/owner/inventory',
            items: itemList,
            context: { count: lowStockItems.length },
          },
        });
      } else {
        // Auto-resolve open low_stock alert if no items are low
        const [openLowStock] = await db
          .select()
          .from(alerts)
          .where(
            and(
              eq(alerts.restaurantId, restaurantId),
              eq(alerts.type, 'low_stock'),
              eq(alerts.status, 'open'),
            ),
          )
          .limit(1);

        if (openLowStock) {
          await this.autoResolveAlert(
            openLowStock.id,
            'All inventory items are above reorder level.',
          );
        }
      }
    }

    // Rule 3: high_expense
    if (settings.enabledAlerts.high_expense) {
      // Look at expenses in the last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString().split('T')[0]!;
      const recentExpenses = await db
        .select()
        .from(expenses)
        .where(
          and(eq(expenses.restaurantId, restaurantId), gte(expenses.expenseDate, sevenDaysAgo)),
        );

      // Trailing 3-month category averages
      const threeMonthsAgo = new Date(Date.now() - 90 * 86400 * 1000).toISOString().split('T')[0]!;
      const historicalExpenses = await db
        .select()
        .from(expenses)
        .where(
          and(eq(expenses.restaurantId, restaurantId), gte(expenses.expenseDate, threeMonthsAgo)),
        );

      // Group historical expenses by categoryId (sum / 3 months)
      const categoryTotals: Record<string, number> = {};
      for (const h of historicalExpenses) {
        if (h.categoryId) {
          categoryTotals[h.categoryId] =
            (categoryTotals[h.categoryId] || 0) + Number(h.amountPaise);
        }
      }

      for (const exp of recentExpenses) {
        if (!exp.categoryId) continue;
        const totalPaise = categoryTotals[exp.categoryId] || 0;
        const monthlyAvgPaise = totalPaise / 3;

        const isAboveMin = exp.amountPaise >= settings.highExpenseMinAmountPaise;
        const isAboveMultiplier =
          monthlyAvgPaise > 0 && exp.amountPaise > monthlyAvgPaise * settings.highExpenseMultiplier;

        if (isAboveMin && isAboveMultiplier) {
          const dedupeKey = `alert:high_expense:${exp.id}`;
          const amountRupees = (exp.amountPaise / 100).toFixed(0);
          const avgRupees = (monthlyAvgPaise / 100).toFixed(0);

          await this.upsertAlert({
            restaurantId,
            type: 'high_expense',
            severity: 'warning',
            dedupeKey,
            payload: {
              title: `Unusually high expense: ₹${amountRupees}`,
              whatIsWrong: `Expense of ₹${amountRupees} for "${exp.description}" exceeds 1.5x the trailing 3-month category average of ₹${avgRupees}.`,
              whyItMatters: 'Unexpected operational expense spikes erode monthly net margins.',
              actionLabel: 'Review Expenses',
              actionUrl: `/owner/expenses?highlight=${exp.id}`,
              context: {
                expenseId: exp.id,
                amountPaise: exp.amountPaise,
                monthlyAvgPaise: Math.round(monthlyAvgPaise),
                multiplier: (exp.amountPaise / monthlyAvgPaise).toFixed(1),
              },
            },
          });
        }
      }
    }

    // Rule 4: payment_reconciliation
    if (settings.enabledAlerts.payment_reconciliation) {
      const timeoutMs = settings.upiPendingTimeoutHours * 3600 * 1000;
      const timeoutThreshold = new Date(Date.now() - timeoutMs);

      // 1. Pending payment requests older than timeout
      const staleRequests = await db
        .select()
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.restaurantId, restaurantId),
            eq(paymentRequests.status, 'pending'),
            lte(paymentRequests.createdAt, timeoutThreshold),
          ),
        );

      // 2. Bills partially paid at day close or unresolved
      const partiallyPaidBills = await db
        .select()
        .from(bills)
        .where(and(eq(bills.restaurantId, restaurantId), eq(bills.status, 'partially_paid')));

      const totalIssues = staleRequests.length + partiallyPaidBills.length;
      const dedupeKey = 'alert:payment_reconciliation';

      if (totalIssues > 0) {
        await this.upsertAlert({
          restaurantId,
          type: 'payment_reconciliation',
          severity: 'critical',
          dedupeKey,
          payload: {
            title: `${totalIssues} payment reconciliation issues`,
            whatIsWrong: `${staleRequests.length} UPI payment requests pending confirmation > ${settings.upiPendingTimeoutHours}h and ${partiallyPaidBills.length} partially paid bills require verification.`,
            whyItMatters:
              'Unconfirmed electronic payments lead to uncollected revenue and inaccurate revenue reporting.',
            actionLabel: 'Reconcile Payments',
            actionUrl: '/owner/eod',
            context: {
              stalePaymentRequestsCount: staleRequests.length,
              partiallyPaidBillsCount: partiallyPaidBills.length,
            },
          },
        });
      } else {
        // Auto resolve if no stale requests or partial bills
        const [openPayAlert] = await db
          .select()
          .from(alerts)
          .where(
            and(
              eq(alerts.restaurantId, restaurantId),
              eq(alerts.type, 'payment_reconciliation'),
              eq(alerts.status, 'open'),
            ),
          )
          .limit(1);

        if (openPayAlert) {
          await this.autoResolveAlert(
            openPayAlert.id,
            'All electronic payments and bill settlements are reconciled.',
          );
        }
      }
    }

    // Rule 5: profit_decline
    if (settings.enabledAlerts.profit_decline) {
      // Get the latest 2 monthly evaluations
      const evals = await db
        .select()
        .from(monthlyEvaluations)
        .where(eq(monthlyEvaluations.restaurantId, restaurantId))
        .orderBy(desc(monthlyEvaluations.month))
        .limit(2);

      if (evals.length >= 2) {
        const latest = evals[0]!;
        const previous = evals[1]!;

        const marginDiff =
          Number(latest.profitMarginPercent || 0) - Number(previous.profitMarginPercent || 0);
        if (marginDiff < -settings.profitDeclinePointsThreshold) {
          const dedupeKey = `alert:profit_decline:${latest.month}`;
          const dropPoints = Math.abs(marginDiff).toFixed(1);

          await this.upsertAlert({
            restaurantId,
            type: 'profit_decline',
            severity: 'critical',
            dedupeKey,
            payload: {
              title: `Operating margin fell by ${dropPoints} percentage points`,
              whatIsWrong: `Operating margin declined from ${Number(previous.profitMarginPercent || 0).toFixed(1)}% in ${previous.month} to ${Number(latest.profitMarginPercent || 0).toFixed(1)}% in ${latest.month}.`,
              whyItMatters:
                'Significant margin contraction threatens business sustainability and cash flow.',
              actionLabel: 'Inspect Profitability',
              actionUrl: `/owner/profitability?month=${latest.month}`,
              context: {
                previousMonth: previous.month,
                previousMargin: Number(previous.profitMarginPercent || 0),
                currentMonth: latest.month,
                currentMargin: Number(latest.profitMarginPercent || 0),
                dropPoints: Number(dropPoints),
              },
            },
          });
        }
      }
    }

    return this.listAlerts(restaurantId);
  }

  /**
   * Helper to upsert an alert:
   * If open alert exists with same dedupeKey, update lastSeen and payload.
   * If snoozed or dismissed exists, do not recreate unless condition is new.
   * Otherwise insert new open alert.
   */
  static async upsertAlert(params: {
    restaurantId: string;
    type:
      'cash_mismatch' | 'low_stock' | 'high_expense' | 'payment_reconciliation' | 'profit_decline';
    severity: 'info' | 'warning' | 'critical';
    dedupeKey: string;
    payload: AlertItemPayload;
  }): Promise<void> {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(
        and(eq(alerts.restaurantId, params.restaurantId), eq(alerts.dedupeKey, params.dedupeKey)),
      )
      .orderBy(desc(alerts.createdAt))
      .limit(1);

    if (existing) {
      if (existing.status === 'open') {
        // Update payload & lastSeen
        await db
          .update(alerts)
          .set({
            payload: params.payload,
            severity: params.severity,
            lastSeen: new Date(),
          })
          .where(eq(alerts.id, existing.id));
        return;
      }

      if (existing.status === 'snoozed') {
        // Keep snoozed, just update lastSeen
        await db.update(alerts).set({ lastSeen: new Date() }).where(eq(alerts.id, existing.id));
        return;
      }

      if (existing.status === 'dismissed') {
        // Remain dismissed unless resolved
        return;
      }
    }

    // Insert new alert
    const [inserted] = await db
      .insert(alerts)
      .values({
        restaurantId: params.restaurantId,
        type: params.type,
        severity: params.severity,
        dedupeKey: params.dedupeKey,
        payload: params.payload,
        status: 'open',
      })
      .returning();

    // Realtime notification to owner room
    emitRealtimeEvent(params.restaurantId, 'alert:new', inserted, 'owner');
  }

  /**
   * Auto-resolve an open alert when condition clears.
   */
  static async autoResolveAlert(alertId: string, note: string): Promise<void> {
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        note: `[Auto-resolved] ${note}`,
      })
      .where(eq(alerts.id, alertId))
      .returning();

    if (updated) {
      emitRealtimeEvent(updated.restaurantId, 'alert:resolved', updated, 'owner');
    }
  }

  /**
   * List alerts with optional filtering by status.
   */
  static async listAlerts(
    restaurantId: string,
    status?: 'open' | 'resolved' | 'snoozed' | 'dismissed',
  ): Promise<AlertOutput[]> {
    const conditions = [eq(alerts.restaurantId, restaurantId)];
    if (status) {
      conditions.push(eq(alerts.status, status));
    }

    const rows = await db
      .select()
      .from(alerts)
      .where(and(...conditions))
      .orderBy(desc(alerts.createdAt));

    // Sort order: critical first, then warning, then info; then lastSeen desc
    const severityRank: Record<string, number> = { critical: 3, warning: 2, info: 1 };

    const formatted: AlertOutput[] = rows.map((r) => ({
      id: r.id,
      restaurantId: r.restaurantId,
      type: r.type,
      severity: r.severity,
      dedupeKey: r.dedupeKey,
      payload: r.payload,
      firstSeen: r.firstSeen.toISOString(),
      lastSeen: r.lastSeen.toISOString(),
      status: r.status,
      snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      resolvedBy: r.resolvedBy,
      note: r.note,
      dismissReason: r.dismissReason,
      createdAt: r.createdAt.toISOString(),
    }));

    return formatted.sort((a, b) => {
      const diff = (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0);
      if (diff !== 0) return diff;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
  }

  /**
   * Acknowledge cash mismatch or general alert with resolution note.
   */
  static async acknowledgeAlert(
    restaurantId: string,
    alertId: string,
    userId: string,
    input: AcknowledgeAlertInput,
  ): Promise<AlertOutput> {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Alert not found');
    }

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: userId,
        note: input.note,
      })
      .where(eq(alerts.id, alertId))
      .returning();

    emitRealtimeEvent(restaurantId, 'alert:acknowledged', updated, 'owner');

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      type: updated!.type,
      severity: updated!.severity,
      dedupeKey: updated!.dedupeKey,
      payload: updated!.payload,
      firstSeen: updated!.firstSeen.toISOString(),
      lastSeen: updated!.lastSeen.toISOString(),
      status: updated!.status,
      snoozedUntil: updated!.snoozedUntil ? updated!.snoozedUntil.toISOString() : null,
      resolvedAt: updated!.resolvedAt ? updated!.resolvedAt.toISOString() : null,
      resolvedBy: updated!.resolvedBy,
      note: updated!.note,
      dismissReason: updated!.dismissReason,
      createdAt: updated!.createdAt.toISOString(),
    };
  }

  /**
   * Snooze alert for 1 day or 7 days.
   */
  static async snoozeAlert(
    restaurantId: string,
    alertId: string,
    input: SnoozeAlertInput,
  ): Promise<AlertOutput> {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Alert not found');
    }

    const days =
      input.duration === '7d' ? 7 : (input as { durationDays?: number }).durationDays || 1;
    const ms = days * 86400 * 1000;
    const snoozedUntil = new Date(Date.now() + ms);

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'snoozed',
        snoozedUntil,
      })
      .where(eq(alerts.id, alertId))
      .returning();

    emitRealtimeEvent(restaurantId, 'alert:snoozed', updated, 'owner');

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      type: updated!.type,
      severity: updated!.severity,
      dedupeKey: updated!.dedupeKey,
      payload: updated!.payload,
      firstSeen: updated!.firstSeen.toISOString(),
      lastSeen: updated!.lastSeen.toISOString(),
      status: updated!.status,
      snoozedUntil: updated!.snoozedUntil ? updated!.snoozedUntil.toISOString() : null,
      resolvedAt: updated!.resolvedAt ? updated!.resolvedAt.toISOString() : null,
      resolvedBy: updated!.resolvedBy,
      note: updated!.note,
      dismissReason: updated!.dismissReason,
      createdAt: updated!.createdAt.toISOString(),
    };
  }

  /**
   * Dismiss alert with reason (disallowed for cash_mismatch).
   */
  static async dismissAlert(
    restaurantId: string,
    alertId: string,
    input: DismissAlertInput,
  ): Promise<AlertOutput> {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.restaurantId, restaurantId)))
      .limit(1);

    if (!existing) {
      throw AppError.notFound('Alert not found');
    }

    if (existing.type === 'cash_mismatch') {
      throw AppError.badRequest(
        'Cash mismatch alerts cannot be dismissed without an acknowledgement note. Please acknowledge the gap.',
      );
    }

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'dismissed',
        dismissReason: input.reason,
      })
      .where(eq(alerts.id, alertId))
      .returning();

    emitRealtimeEvent(restaurantId, 'alert:dismissed', updated, 'owner');

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      type: updated!.type,
      severity: updated!.severity,
      dedupeKey: updated!.dedupeKey,
      payload: updated!.payload,
      firstSeen: updated!.firstSeen.toISOString(),
      lastSeen: updated!.lastSeen.toISOString(),
      status: updated!.status,
      snoozedUntil: updated!.snoozedUntil ? updated!.snoozedUntil.toISOString() : null,
      resolvedAt: updated!.resolvedAt ? updated!.resolvedAt.toISOString() : null,
      resolvedBy: updated!.resolvedBy,
      note: updated!.note,
      dismissReason: updated!.dismissReason,
      createdAt: updated!.createdAt.toISOString(),
    };
  }
}
