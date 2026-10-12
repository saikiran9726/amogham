import { lt, or, and, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { syncCommands } from '../db/schema/orders.js';
import { refreshTokens } from '../db/schema/refresh-tokens.js';

export interface CleanupJobOptions {
  intervalMs?: number;
  retentionDays?: number;
  targetDb?: typeof db;
}

export class IdempotencyCleanupService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly targetDb: typeof db = db,
    private readonly retentionDays: number = 30,
    private readonly intervalMs: number = 24 * 60 * 60 * 1000,
  ) {}

  /**
   * Run a single pruning pass:
   * - Deletes sync_commands older than retentionDays
   * - Deletes expired or revoked refresh_tokens older than retentionDays
   * Returns the count of deleted records.
   */
  async runCleanupOnce(retentionDaysOverride?: number): Promise<number> {
    const days = retentionDaysOverride ?? this.retentionDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const deletedSync = await this.targetDb
      .delete(syncCommands)
      .where(lt(syncCommands.createdAt, cutoff))
      .returning({ id: syncCommands.id });

    const deletedTokens = await this.targetDb
      .delete(refreshTokens)
      .where(
        or(
          and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, cutoff)),
          lt(refreshTokens.expiresAt, cutoff),
        ),
      )
      .returning({ id: refreshTokens.id });

    return deletedSync.length + deletedTokens.length;
  }

  /**
   * Purge expired/revoked refresh tokens older than the specified retention days.
   */
  async purgeRefreshTokensOnce(retentionDaysOverride?: number): Promise<number> {
    const days = retentionDaysOverride ?? this.retentionDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const deletedTokens = await this.targetDb
      .delete(refreshTokens)
      .where(
        or(
          and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, cutoff)),
          lt(refreshTokens.expiresAt, cutoff),
        ),
      )
      .returning({ id: refreshTokens.id });

    return deletedTokens.length;
  }

  /**
   * Start recurring background cleanup.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run first iteration in background without blocking startup
    void this.runCleanupOnce().catch((err) => {
      console.error('[CleanupJob] Error during initial prune:', err);
    });

    this.timer = setInterval(() => {
      void this.runCleanupOnce().catch((err) => {
        console.error('[CleanupJob] Error during periodic prune:', err);
      });
    }, this.intervalMs);

    // Unref timer so it does not block process exit
    this.timer.unref();
  }

  /**
   * Stop recurring cleanup.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }
}

let activeCleanupService: IdempotencyCleanupService | null = null;

/**
 * Registers the idempotency and refresh token cleanup job on Fastify startup and wires up graceful shutdown.
 */
export function registerCleanupJob(
  app: FastifyInstance,
  options?: CleanupJobOptions,
): IdempotencyCleanupService {
  const service = new IdempotencyCleanupService(
    options?.targetDb ?? db,
    options?.retentionDays ?? 30,
    options?.intervalMs ?? (process.env.NODE_ENV === 'test' ? 60_000 : 24 * 60 * 60 * 1000),
  );

  activeCleanupService = service;
  service.start();

  app.addHook('onClose', async () => {
    service.stop();
  });

  return service;
}

export function getActiveCleanupService(): IdempotencyCleanupService | null {
  return activeCleanupService;
}
