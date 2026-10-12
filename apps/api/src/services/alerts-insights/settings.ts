import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { alertSettings } from '../../db/schema/index.js';
import {
  DEFAULT_ALERT_SETTINGS,
  type AlertSettingsOutput,
  type UpdateAlertSettingsInput,
} from '@restaurant-os/shared';

export class AlertSettingsService {
  static async getSettings(restaurantId: string): Promise<AlertSettingsOutput> {
    const [row] = await db
      .select()
      .from(alertSettings)
      .where(eq(alertSettings.restaurantId, restaurantId))
      .limit(1);

    if (row) {
      return {
        id: row.id,
        restaurantId: row.restaurantId,
        cashMismatchTolerancePaise: row.cashMismatchTolerancePaise,
        highExpenseMultiplier: Number(row.highExpenseMultiplier),
        highExpenseMinAmountPaise: row.highExpenseMinAmountPaise,
        upiPendingTimeoutHours: Number(row.upiPendingTimeoutHours),
        profitDeclinePointsThreshold: Number(row.profitDeclinePointsThreshold),
        regularCustomerInactiveDays: row.regularCustomerInactiveDays,
        enabledAlerts: row.enabledAlerts,
        enabledInsights: row.enabledInsights,
        updatedAt: row.updatedAt.toISOString(),
      };
    }

    const [created] = await db
      .insert(alertSettings)
      .values({
        restaurantId,
        cashMismatchTolerancePaise: DEFAULT_ALERT_SETTINGS.cashMismatchTolerancePaise,
        highExpenseMultiplier: DEFAULT_ALERT_SETTINGS.highExpenseMultiplier.toFixed(2),
        highExpenseMinAmountPaise: DEFAULT_ALERT_SETTINGS.highExpenseMinAmountPaise,
        upiPendingTimeoutHours: DEFAULT_ALERT_SETTINGS.upiPendingTimeoutHours.toFixed(1),
        profitDeclinePointsThreshold:
          DEFAULT_ALERT_SETTINGS.profitDeclinePointsThreshold.toFixed(1),
        regularCustomerInactiveDays: DEFAULT_ALERT_SETTINGS.regularCustomerInactiveDays,
        enabledAlerts: DEFAULT_ALERT_SETTINGS.enabledAlerts,
        enabledInsights: DEFAULT_ALERT_SETTINGS.enabledInsights,
      })
      .returning();

    return {
      id: created!.id,
      restaurantId: created!.restaurantId,
      cashMismatchTolerancePaise: created!.cashMismatchTolerancePaise,
      highExpenseMultiplier: Number(created!.highExpenseMultiplier),
      highExpenseMinAmountPaise: created!.highExpenseMinAmountPaise,
      upiPendingTimeoutHours: Number(created!.upiPendingTimeoutHours),
      profitDeclinePointsThreshold: Number(created!.profitDeclinePointsThreshold),
      regularCustomerInactiveDays: created!.regularCustomerInactiveDays,
      enabledAlerts: created!.enabledAlerts,
      enabledInsights: created!.enabledInsights,
      updatedAt: created!.updatedAt.toISOString(),
    };
  }

  static async updateSettings(
    restaurantId: string,
    input: UpdateAlertSettingsInput,
  ): Promise<AlertSettingsOutput> {
    const current = await this.getSettings(restaurantId);

    const updatePayload: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (input.cashMismatchTolerancePaise !== undefined) {
      updatePayload.cashMismatchTolerancePaise = input.cashMismatchTolerancePaise;
    }
    if (input.highExpenseMultiplier !== undefined) {
      updatePayload.highExpenseMultiplier = input.highExpenseMultiplier.toFixed(2);
    }
    if (input.highExpenseMinAmountPaise !== undefined) {
      updatePayload.highExpenseMinAmountPaise = input.highExpenseMinAmountPaise;
    }
    if (input.upiPendingTimeoutHours !== undefined) {
      updatePayload.upiPendingTimeoutHours = input.upiPendingTimeoutHours.toFixed(1);
    }
    if (input.profitDeclinePointsThreshold !== undefined) {
      updatePayload.profitDeclinePointsThreshold = input.profitDeclinePointsThreshold.toFixed(1);
    }
    if (input.regularCustomerInactiveDays !== undefined) {
      updatePayload.regularCustomerInactiveDays = input.regularCustomerInactiveDays;
    }
    if (input.enabledAlerts !== undefined) {
      updatePayload.enabledAlerts = {
        ...current.enabledAlerts,
        ...input.enabledAlerts,
      };
    }
    if (input.enabledInsights !== undefined) {
      updatePayload.enabledInsights = {
        ...current.enabledInsights,
        ...input.enabledInsights,
      };
    }

    const [updated] = await db
      .update(alertSettings)
      .set(updatePayload)
      .where(eq(alertSettings.restaurantId, restaurantId))
      .returning();

    return {
      id: updated!.id,
      restaurantId: updated!.restaurantId,
      cashMismatchTolerancePaise: updated!.cashMismatchTolerancePaise,
      highExpenseMultiplier: Number(updated!.highExpenseMultiplier),
      highExpenseMinAmountPaise: updated!.highExpenseMinAmountPaise,
      upiPendingTimeoutHours: Number(updated!.upiPendingTimeoutHours),
      profitDeclinePointsThreshold: Number(updated!.profitDeclinePointsThreshold),
      regularCustomerInactiveDays: updated!.regularCustomerInactiveDays,
      enabledAlerts: updated!.enabledAlerts,
      enabledInsights: updated!.enabledInsights,
      updatedAt: updated!.updatedAt.toISOString(),
    };
  }
}
