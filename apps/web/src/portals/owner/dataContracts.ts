import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPES,
  INSIGHT_KINDS,
  INSIGHT_PERIODS,
  type AlertSettingsOutput,
  type AlertOutput,
  type InsightOutput,
  type DeadLetterCommandItem,
  type ConflictReviewItem,
} from '@restaurant-os/shared';
import { isArrayOf } from '../../api/response.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

export function isAlertOutput(value: unknown): value is AlertOutput {
  if (!isObject(value) || !isObject(value.payload)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.restaurantId === 'string' &&
    isOneOf(ALERT_TYPES, value.type) &&
    isOneOf(ALERT_SEVERITIES, value.severity) &&
    isOneOf(ALERT_STATUSES, value.status) &&
    typeof value.dedupeKey === 'string' &&
    typeof value.payload.whatIsWrong === 'string' &&
    typeof value.payload.whyItMatters === 'string'
  );
}

export function isInsightOutput(value: unknown): value is InsightOutput {
  if (!isObject(value) || !isObject(value.evidence) || !isObject(value.evidence.details))
    return false;
  return (
    typeof value.id === 'string' &&
    typeof value.restaurantId === 'string' &&
    isOneOf(INSIGHT_PERIODS, value.period) &&
    isOneOf(INSIGHT_KINDS, value.kind) &&
    typeof value.text === 'string' &&
    typeof value.evidence.metricName === 'string' &&
    (typeof value.evidence.currentValue === 'string' ||
      typeof value.evidence.currentValue === 'number') &&
    typeof value.materialityScore === 'number' &&
    typeof value.createdAt === 'string' &&
    typeof value.dismissed === 'boolean'
  );
}

export const isAlertList = isArrayOf(isAlertOutput);
export const isInsightList = isArrayOf(isInsightOutput);

export function isAlertSettingsOutput(value: unknown): value is AlertSettingsOutput {
  if (!isObject(value) || !isObject(value.enabledAlerts) || !isObject(value.enabledInsights))
    return false;
  const enabledAlerts = value.enabledAlerts;
  const enabledInsights = value.enabledInsights;
  return (
    typeof value.id === 'string' &&
    typeof value.restaurantId === 'string' &&
    typeof value.cashMismatchTolerancePaise === 'number' &&
    typeof value.highExpenseMultiplier === 'number' &&
    typeof value.highExpenseMinAmountPaise === 'number' &&
    typeof value.upiPendingTimeoutHours === 'number' &&
    typeof value.profitDeclinePointsThreshold === 'number' &&
    typeof value.regularCustomerInactiveDays === 'number' &&
    typeof value.updatedAt === 'string' &&
    ALERT_TYPES.every((key) => typeof enabledAlerts[key] === 'boolean') &&
    INSIGHT_KINDS.every((key) => typeof enabledInsights[key] === 'boolean')
  );
}

export function isDeadLetterCommandItem(value: unknown): value is DeadLetterCommandItem {
  if (!isObject(value) || !isObject(value.payload)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.restaurantId === 'string' &&
    typeof value.commandId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.errorMessage === 'string' &&
    typeof value.attempts === 'number' &&
    ['dead_letter', 'replayed', 'discarded'].includes(String(value.status)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

export function isConflictReviewItem(value: unknown): value is ConflictReviewItem {
  if (!isObject(value) || !isObject(value.details)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.restaurantId === 'string' &&
    ['duplicate_payment', 'table_collision', 'order_concurrent_edit'].includes(
      String(value.type),
    ) &&
    typeof value.referenceId === 'string' &&
    ['warning', 'critical'].includes(String(value.severity)) &&
    ['pending', 'resolved', 'acknowledged'].includes(String(value.status)) &&
    typeof value.createdAt === 'string'
  );
}

export const isDeadLetterList = isArrayOf(isDeadLetterCommandItem);
export const isConflictList = isArrayOf(isConflictReviewItem);

export const ownerAlertQueryKey = (status: string = 'open') => ['owner-alerts', status] as const;
export const ownerInsightsQueryKey = ['owner-insights'] as const;
