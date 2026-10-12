import { create } from 'zustand';
import { localDb, type OutboxCommand } from '../db/dexie.js';
import { apiFetch } from '../stores/useAuthStore.js';

export type SyncState = 'online' | 'offline' | 'syncing' | 'complete' | 'problem';

interface OutboxState {
  syncState: SyncState;
  pendingCount: number;
  lastSyncError: string | null;
  isRunning: boolean;
  init: () => void;
  enqueue: (type: string, payload: Record<string, unknown>) => Promise<string>;
  triggerSync: () => Promise<void>;
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  syncState: navigator.onLine ? 'online' : 'offline',
  pendingCount: 0,
  lastSyncError: null,
  isRunning: false,

  init: () => {
    // Listen for online/offline events
    window.addEventListener('online', () => {
      set({ syncState: 'online' });
      void get().triggerSync();
    });
    window.addEventListener('offline', () => {
      set({ syncState: 'offline' });
    });

    // Initial check of pending outbox commands
    void localDb.outbox
      .where('status')
      .anyOf(['pending', 'failed'])
      .count()
      .then((count) => {
        set({ pendingCount: count });
        if (count > 0 && navigator.onLine) {
          void get().triggerSync();
        }
      });
  },

  enqueue: async (type: string, payload: Record<string, unknown>) => {
    const commandId = (payload.id as string | undefined) || crypto.randomUUID();
    const key = `cmd_${commandId}_${Date.now()}`;

    const command: OutboxCommand = {
      id: commandId,
      key,
      type,
      payload,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending',
    };

    await localDb.outbox.put(command);
    const count = await localDb.outbox.where('status').anyOf(['pending', 'failed']).count();
    set({ pendingCount: count });

    // Trigger immediate background sync if online
    if (navigator.onLine) {
      void get().triggerSync();
    }

    return key;
  },

  triggerSync: async () => {
    if (get().isRunning || !navigator.onLine) return;

    set({ isRunning: true, syncState: 'syncing', lastSyncError: null });

    let commandFailed = false;
    try {
      const pending = await localDb.outbox
        .where('status')
        .anyOf(['pending', 'failed'])
        .sortBy('createdAt');

      for (const cmd of pending) {
        try {
          await localDb.outbox.update(cmd.id, {
            status: 'syncing',
            attempts: cmd.attempts + 1,
            lastAttemptAt: Date.now(),
          });

          if (cmd.type === 'order.create') {
            await apiFetch('/orders', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify(cmd.payload),
            });
          } else if (cmd.type === 'order.update') {
            await apiFetch(`/orders/${cmd.payload.id}`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify(cmd.payload),
            });
          } else if (cmd.type === 'kot.send') {
            await apiFetch(`/orders/${cmd.payload.orderId}/kots`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify(cmd.payload),
            });
          } else if (cmd.type === 'order.served') {
            await apiFetch(`/orders/${cmd.payload.orderId}/served`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
            });
          } else if (cmd.type === 'kot.seen') {
            await apiFetch(`/kots/${cmd.payload.kotId}/seen`, {
              method: 'POST',
              headers: {
                'Idempotency-Key': cmd.key,
              },
            });
          } else if (cmd.type === 'kot.itemDone') {
            await apiFetch(`/kot-items/${cmd.payload.kotItemId}/done`, {
              method: 'PATCH',
              headers: {
                'Idempotency-Key': cmd.key,
              },
            });
          } else if (cmd.type === 'kot.status') {
            await apiFetch(`/kots/${cmd.payload.kotId}/status`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify({ status: cmd.payload.status }),
            });
          } else if (cmd.type === 'menu.oos') {
            if (cmd.payload.available === false) {
              await apiFetch(`/menu/${cmd.payload.itemId}/oos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: cmd.payload.reason }),
              });
            } else {
              await apiFetch(`/menu/${cmd.payload.itemId}/oos`, {
                method: 'DELETE',
              });
            }
          } else if (cmd.type === 'bill.create') {
            await apiFetch(`/orders/${cmd.payload.orderId}/bill`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify(cmd.payload),
            });
          } else if (cmd.type === 'bill.payment') {
            await apiFetch(`/bills/${cmd.payload.billId}/payments`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
              body: JSON.stringify(cmd.payload),
            });
          } else if (cmd.type === 'payment.confirm') {
            await apiFetch(`/payments/${cmd.payload.paymentId}/confirm`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': cmd.key,
              },
            });
          }

          // Mark command as synced
          await localDb.outbox.update(cmd.id, { status: 'synced' });

          // Update local order synced flag
          if (cmd.payload && typeof cmd.payload === 'object' && 'id' in cmd.payload && cmd.payload.id) {
            await localDb.openOrders.update(cmd.payload.id as string, { isSynced: true });
          }
        } catch (err: unknown) {
          console.warn(`Sync failed for command ${cmd.id}:`, err);
          const errMessage = err instanceof Error ? err.message : 'Network error';
          await localDb.outbox.update(cmd.id, {
            status: 'failed',
            error: errMessage,
          });
          set({
            syncState: 'problem',
            lastSyncError: errMessage,
          });
          commandFailed = true;
          break; // Back off on failure
        }
      }

      const remaining = await localDb.outbox.where('status').anyOf(['pending', 'failed']).count();
      set({
        pendingCount: remaining,
        isRunning: false,
        syncState: remaining === 0 ? 'complete' : 'problem',
      });

      // Clear 'complete' state after 2 seconds back to online
      if (remaining === 0) {
        setTimeout(() => {
          if (get().syncState === 'complete') {
            set({ syncState: 'online' });
          }
        }, 2000);
      } else if (!commandFailed && navigator.onLine) {
        // Commands can be added while this run is in progress. The initial
        // snapshot won't include them, so start another pass after unlocking.
        queueMicrotask(() => {
          void get().triggerSync();
        });
      }
    } catch (globalErr: unknown) {
      set({
        isRunning: false,
        syncState: 'problem',
        lastSyncError: globalErr instanceof Error ? globalErr.message : 'Sync failed',
      });
    }
  },
}));
