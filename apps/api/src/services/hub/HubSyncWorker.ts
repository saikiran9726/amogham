import crypto from 'node:crypto';
import { eq, and, gt, desc, sql, count } from 'drizzle-orm';
import { forTenant } from '../../db/tenant.js';
import { syncEvents, syncCursors, deadLetterCommands } from '../../db/schema/sync.js';
import { MetricsService } from '../metrics.js';
import { generateUuidV7, type SyncPushBatchInput, type SyncEventItem } from '@restaurant-os/shared';

export interface HubSyncWorkerOptions {
  restaurantId: string;
  cloudSyncUrl: string;
  hubApiKey: string;
  deviceId?: string;
  syncIntervalMs?: number;
  maxRetries?: number;
}

export class HubSyncWorker {
  public readonly restaurantId: string;
  public readonly cloudSyncUrl: string;
  public readonly hubApiKey: string;
  public readonly deviceId: string;
  public readonly syncIntervalMs: number;
  public readonly maxRetries: number;

  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private readonly baseBackoffMs = 1000;
  private readonly maxBackoffMs = 30000;

  constructor(options: HubSyncWorkerOptions) {
    this.restaurantId = options.restaurantId;
    this.cloudSyncUrl = options.cloudSyncUrl.replace(/\/+$/, '');
    this.hubApiKey = options.hubApiKey;
    this.deviceId = options.deviceId || 'hub-local-primary';
    this.syncIntervalMs = options.syncIntervalMs || 5000;
    this.maxRetries = options.maxRetries || 5;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextCycle(100);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextCycle(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      void this.executeCycle().finally(() => {
        if (!this.isRunning) return;
        let nextDelay = this.syncIntervalMs;
        if (this.consecutiveErrors > 0) {
          // Exponential backoff with jitter
          const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.consecutiveErrors - 1));
          const jitter = Math.floor(Math.random() * 500);
          nextDelay = exp + jitter;
        }
        this.scheduleNextCycle(nextDelay);
      });
    }, delayMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Executes a single sync cycle:
   * 1. Push unsynced local events to cloud
   * 2. Pull latest cloud events from cloud cursor
   * 3. Update sync lag & dead letter metrics
   */
  public async executeCycle(): Promise<{ pushedCount: number; pulledCount: number }> {
    let pushedCount = 0;
    let pulledCount = 0;

    try {
      pushedCount = await this.pushUnsyncedEvents();
      pulledCount = await this.pullCloudEvents();
      await this.updateMetrics();
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      await this.updateMetrics().catch(() => {});
      throw err;
    }

    return { pushedCount, pulledCount };
  }

  /**
   * Push unsynced local events to Cloud endpoint.
   */
  private async pushUnsyncedEvents(): Promise<number> {
    const tenant = forTenant(this.restaurantId);

    // 1. Get current push cursor
    const [cursorRow] = await tenant.select(
      syncCursors,
      eq(syncCursors.peerId, 'cloud_push'),
    );
    const lastPushedSeq = cursorRow?.lastSeq ?? 0;

    // 2. Fetch batch of unsynced events
    const unsynced = await tenant.db
      .select()
      .from(syncEvents)
      .where(and(eq(syncEvents.restaurantId, this.restaurantId), gt(syncEvents.seq, lastPushedSeq)))
      .orderBy(syncEvents.seq)
      .limit(50);

    if (unsynced.length === 0) {
      return 0;
    }

    const batchPayload: SyncPushBatchInput = {
      deviceId: this.deviceId,
      batchId: generateUuidV7(),
      commands: unsynced.map((e) => ({
        id: e.commandId,
        idempotencyKey: e.idempotencyKey,
        deviceId: e.deviceId || this.deviceId,
        type: e.type,
        payload: (e.payload as Record<string, unknown>) || {},
        claimedAt: e.claimedAt ? e.claimedAt.toISOString() : null,
      })),
    };

    try {
      const response = await fetch(`${this.cloudSyncUrl}/sync/hub/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Key': this.hubApiKey,
          'X-Restaurant-Id': this.restaurantId,
          'X-Hub-Device-Id': this.deviceId,
        },
        body: JSON.stringify(batchPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud hub push failed with status ${response.status}: ${errorText}`);
      }

      const resJson = (await response.json()) as {
        success: boolean;
        results?: Array<{ commandId: string; status: string; errorMessage?: string }>;
        latestSeq?: number;
      };

      // Advance push cursor to the highest processed local sequence number
      const newSeq = unsynced[unsynced.length - 1]!.seq;
      await tenant.db
        .insert(syncCursors)
        .values({
          restaurantId: this.restaurantId,
          peerId: 'cloud_push',
          lastSeq: newSeq,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [syncCursors.restaurantId, syncCursors.peerId],
          set: {
            lastSeq: newSeq,
            updatedAt: new Date(),
          },
        });

      MetricsService.recordHubPush(this.restaurantId, 'success');
      return unsynced.length;
    } catch (err) {
      MetricsService.recordHubPush(this.restaurantId, 'failure');

      // Check if attempts exceeded maxRetries, move commands to dead-letter queue
      if (this.consecutiveErrors + 1 >= this.maxRetries) {
        for (const item of unsynced) {
          await tenant.db
            .insert(deadLetterCommands)
            .values({
              restaurantId: this.restaurantId,
              commandId: item.commandId,
              idempotencyKey: item.idempotencyKey,
              deviceId: item.deviceId,
              type: item.type,
              payload: item.payload,
              errorMessage: `HubSyncWorker push failed after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
              attempts: this.consecutiveErrors + 1,
              status: 'dead_letter',
            })
            .onConflictDoNothing();
        }
      }
      throw err;
    }
  }

  /**
   * Pull cloud events from Cloud cursor.
   */
  private async pullCloudEvents(): Promise<number> {
    const tenant = forTenant(this.restaurantId);

    // 1. Get current pull cursor
    const [cursorRow] = await tenant.select(
      syncCursors,
      eq(syncCursors.peerId, 'cloud_pull'),
    );
    const lastPulledSeq = cursorRow?.lastSeq ?? 0;

    try {
      const response = await fetch(
        `${this.cloudSyncUrl}/sync/hub/pull?since=${lastPulledSeq}&limit=50`,
        {
          method: 'GET',
          headers: {
            'X-Hub-Key': this.hubApiKey,
            'X-Restaurant-Id': this.restaurantId,
            'X-Hub-Device-Id': this.deviceId,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloud hub pull failed with status ${response.status}: ${errorText}`);
      }

      const resJson = (await response.json()) as {
        success: boolean;
        lastSeq: number;
        events: SyncEventItem[];
      };

      if (resJson.events && resJson.events.length > 0) {
        // Advance cursor
        await tenant.db
          .insert(syncCursors)
          .values({
            restaurantId: this.restaurantId,
            peerId: 'cloud_pull',
            lastSeq: resJson.lastSeq,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [syncCursors.restaurantId, syncCursors.peerId],
            set: {
              lastSeq: resJson.lastSeq,
              updatedAt: new Date(),
            },
          });
      }

      MetricsService.recordHubPull(this.restaurantId, 'success');
      return resJson.events ? resJson.events.length : 0;
    } catch (err) {
      MetricsService.recordHubPull(this.restaurantId, 'failure');
      throw err;
    }
  }

  /**
   * Update observability gauges for sync lag and dead-letter count.
   */
  private async updateMetrics(): Promise<void> {
    const tenant = forTenant(this.restaurantId);

    // 1. Calculate sync lag: (max local seq) - (last pushed seq)
    const [maxEvent] = await tenant.db
      .select({ maxSeq: sql<number>`coalesce(max(${syncEvents.seq}), 0)` })
      .from(syncEvents)
      .where(eq(syncEvents.restaurantId, this.restaurantId));

    const [pushCursor] = await tenant.select(
      syncCursors,
      eq(syncCursors.peerId, 'cloud_push'),
    );

    const maxSeq = Number(maxEvent?.maxSeq ?? 0);
    const pushedSeq = Number(pushCursor?.lastSeq ?? 0);
    const lag = Math.max(0, maxSeq - pushedSeq);
    MetricsService.setSyncLag(this.restaurantId, lag);

    // 2. Count active dead-letters
    const [dlCount] = await tenant.db
      .select({ val: count() })
      .from(deadLetterCommands)
      .where(
        and(
          eq(deadLetterCommands.restaurantId, this.restaurantId),
          eq(deadLetterCommands.status, 'dead_letter'),
        ),
      );

    MetricsService.setDeadLetterCount(this.restaurantId, Number(dlCount?.val ?? 0));
  }
}

/**
 * Constant-time comparison between incoming hub API key and stored SHA-256 hash.
 */
export function verifyHubApiKeyConstantTime(incomingKey: string, storedHash: string): boolean {
  if (!incomingKey || !storedHash) return false;
  const computedHash = crypto.createHash('sha256').update(incomingKey).digest('hex');
  const computedBuf = Buffer.from(computedHash, 'utf8');
  const storedBuf = Buffer.from(storedHash, 'utf8');

  if (computedBuf.length !== storedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(computedBuf, storedBuf);
}
