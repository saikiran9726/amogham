import { randomUUID } from 'node:crypto';

export interface RealtimeEvent<T = unknown> {
  id: string; // crypto.randomUUID()
  event: string;
  data: T;
  timestamp: number;
}

export type RealtimeTarget = 'all' | 'kitchen' | 'floor' | 'owner';

export interface RealtimePublishPayload<T = unknown> {
  restaurantId: string;
  event: string;
  data: T;
  target?: RealtimeTarget;
}

export type RealtimeSubscriber = (
  restaurantId: string,
  event: string,
  payload: RealtimeEvent,
  target: RealtimeTarget,
) => void;

/**
 * Common bus interface allowing decoupled in-memory or Redis-based event distribution.
 */
export interface RealtimeBus {
  publish<T = unknown>(
    payload: RealtimePublishPayload<T>,
  ): Promise<RealtimeEvent<T>> | RealtimeEvent<T>;
  getHistory(restaurantId: string, since: number): Promise<RealtimeEvent[]> | RealtimeEvent[];
  subscribe(subscriber: RealtimeSubscriber): () => void;
  sweep(): void;
  destroy(): void;
}

/**
 * In-memory implementation of RealtimeBus with bounded per-tenant history (max 500, TTL 10m).
 */
export class InMemoryRealtimeBus implements RealtimeBus {
  public static readonly MAX_EVENT_LOG = 500;
  public static readonly EVENT_TTL_MS = 10 * 60 * 1000; // 10 minutes
  public static readonly SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

  private readonly eventLog = new Map<string, RealtimeEvent[]>();
  private readonly subscribers = new Set<RealtimeSubscriber>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, InMemoryRealtimeBus.SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  publish<T = unknown>(payload: RealtimePublishPayload<T>): RealtimeEvent<T> {
    const { restaurantId, event, data, target = 'all' } = payload;
    const eventPayload: RealtimeEvent<T> = {
      id: randomUUID(),
      event,
      data,
      timestamp: Date.now(),
    };

    let history = this.eventLog.get(restaurantId);
    if (!history) {
      history = [];
      this.eventLog.set(restaurantId, history);
    }

    history.push(eventPayload as RealtimeEvent);
    if (history.length > InMemoryRealtimeBus.MAX_EVENT_LOG) {
      history.shift();
    }

    for (const sub of this.subscribers) {
      try {
        sub(restaurantId, event, eventPayload as RealtimeEvent, target);
      } catch (err) {
        console.error('[RealtimeBus] Error in subscriber:', err);
      }
    }

    return eventPayload;
  }

  getHistory(restaurantId: string, since: number): RealtimeEvent[] {
    const history = this.eventLog.get(restaurantId) || [];
    const now = Date.now();
    const cutoff = now - InMemoryRealtimeBus.EVENT_TTL_MS;

    return history.filter((e) => e.timestamp > since && e.timestamp >= cutoff);
  }

  subscribe(subscriber: RealtimeSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  sweep(): void {
    const now = Date.now();
    const cutoff = now - InMemoryRealtimeBus.EVENT_TTL_MS;

    for (const [restaurantId, history] of this.eventLog.entries()) {
      const active = history.filter((e) => e.timestamp >= cutoff);
      if (active.length === 0) {
        this.eventLog.delete(restaurantId);
      } else {
        if (active.length > InMemoryRealtimeBus.MAX_EVENT_LOG) {
          active.splice(0, active.length - InMemoryRealtimeBus.MAX_EVENT_LOG);
        }
        this.eventLog.set(restaurantId, active);
      }
    }
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.subscribers.clear();
    this.eventLog.clear();
  }
}
