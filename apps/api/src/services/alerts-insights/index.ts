import { AlertSettingsService } from './settings.js';
import { AlertsService } from './alerts.js';
import { InsightsService } from './insights.js';

export { AlertSettingsService, AlertsService, InsightsService };

export class AlertsInsightsService {
  // Settings delegation
  static getSettings = AlertSettingsService.getSettings.bind(AlertSettingsService);
  static updateSettings = AlertSettingsService.updateSettings.bind(AlertSettingsService);

  // Alerts delegation
  static checkAndSyncAlerts = AlertsService.checkAndSyncAlerts.bind(AlertsService);
  static upsertAlert = AlertsService.upsertAlert.bind(AlertsService);
  static autoResolveAlert = AlertsService.autoResolveAlert.bind(AlertsService);
  static listAlerts = AlertsService.listAlerts.bind(AlertsService);
  static acknowledgeAlert = AlertsService.acknowledgeAlert.bind(AlertsService);
  static snoozeAlert = AlertsService.snoozeAlert.bind(AlertsService);
  static dismissAlert = AlertsService.dismissAlert.bind(AlertsService);

  // Insights delegation
  static generateInsights = InsightsService.generateInsights.bind(InsightsService);
  static listInsights = InsightsService.listInsights.bind(InsightsService);
  static dismissInsight = InsightsService.dismissInsight.bind(InsightsService);
}
