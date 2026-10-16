import client from 'prom-client';

const register = new client.Registry();

// Enable default process / Node.js metrics
client.collectDefaultMetrics({ register, prefix: 'restaurant_os_' });

export const httpRequestDurationHistogram = new client.Histogram({
  name: 'restaurant_os_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const syncLagGauge = new client.Gauge({
  name: 'restaurant_os_sync_lag_events',
  help: 'Number of events or sequence distance between local and remote hub sync',
  labelNames: ['restaurant_id'],
  registers: [register],
});

export const deadLetterGauge = new client.Gauge({
  name: 'restaurant_os_dead_letter_count',
  help: 'Current count of active dead-letter commands',
  labelNames: ['restaurant_id'],
  registers: [register],
});

export const userLockoutCounter = new client.Counter({
  name: 'restaurant_os_user_lockout_total',
  help: 'Total number of user account lockouts triggered due to failed attempts',
  labelNames: ['restaurant_id'],
  registers: [register],
});

export const hubPushCounter = new client.Counter({
  name: 'restaurant_os_hub_sync_push_total',
  help: 'Total number of hub sync push operations',
  labelNames: ['restaurant_id', 'status'],
  registers: [register],
});

export const hubPullCounter = new client.Counter({
  name: 'restaurant_os_hub_sync_pull_total',
  help: 'Total number of hub sync pull operations',
  labelNames: ['restaurant_id', 'status'],
  registers: [register],
});

export class MetricsService {
  static recordHttpDuration(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    httpRequestDurationHistogram.observe(
      {
        method: method.toUpperCase(),
        route: route || 'unmatched',
        status_code: String(statusCode),
      },
      durationSeconds,
    );
  }

  static setSyncLag(restaurantId: string, lag: number): void {
    syncLagGauge.set({ restaurant_id: restaurantId }, lag);
  }

  static setDeadLetterCount(restaurantId: string, count: number): void {
    deadLetterGauge.set({ restaurant_id: restaurantId }, count);
  }

  static incrementLockout(restaurantId: string): void {
    userLockoutCounter.inc({ restaurant_id: restaurantId });
  }

  static recordHubPush(restaurantId: string, status: 'success' | 'failure'): void {
    hubPushCounter.inc({ restaurant_id: restaurantId, status });
  }

  static recordHubPull(restaurantId: string, status: 'success' | 'failure'): void {
    hubPullCounter.inc({ restaurant_id: restaurantId, status });
  }

  static async getMetrics(restaurantId?: string): Promise<string> {
    const raw = await register.metrics();
    if (!restaurantId) return raw;

    // Restrict multi-tenant data access: omit metric lines that belong to other restaurants
    return raw
      .split('\n')
      .filter((line) => {
        const match = line.match(/restaurant_id="([^"]+)"/);
        if (match && match[1] !== restaurantId) {
          return false;
        }
        return true;
      })
      .join('\n');
  }

  static getContentType(): string {
    return register.contentType;
  }
}
