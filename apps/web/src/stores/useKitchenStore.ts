import { create } from 'zustand';
import { apiFetch } from './useAuthStore.js';
import { localDb, type KitchenItem, type KitchenKot } from '../db/dexie.js';
import { useOutboxStore } from './useOutboxStore.js';
import { useToastStore } from './useToastStore.js';

export type { KitchenItem, KitchenKot };

export type TextSize = 'M' | 'L' | 'XL';

interface KitchenState {
  kots: KitchenKot[];
  recentlyServed: KitchenKot[];
  rushMode: boolean;
  textSize: TextSize;
  soundEnabled: boolean;
  wakeLockActive: boolean;
  warnThresholdMinutes: number; // default 10 min
  criticalThresholdMinutes: number; // default 15 min
  isLoading: boolean;
  lastFetchedAt: number | null;
  isOosOpen: boolean;
  isRecentlyServedOpen: boolean;

  // Actions
  fetchKitchenState: () => Promise<void>;
  toggleRushMode: () => void;
  setTextSize: (size: TextSize) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setOosOpen: (open: boolean) => void;
  setRecentlyServedOpen: (open: boolean) => void;
  markKotSeen: (kotId: string) => Promise<void>;
  toggleItemDone: (kotId: string, itemId: string) => Promise<void>;
  setKotStatus: (kotId: string, status: 'new' | 'preparing' | 'ready' | 'served') => Promise<void>;
  requestWakeLock: () => Promise<void>;
  releaseWakeLock: () => void;
  toggleWakeLock: () => Promise<void>;
  playNotificationSound: () => void;
  applyRealtimeKotEvent: (event: string, data?: unknown) => void;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
}

let wakeLockSentinel: WakeLockSentinelLike | null = null;

export const useKitchenStore = create<KitchenState>((set, get) => ({
  kots: [],
  recentlyServed: [],
  rushMode: localStorage.getItem('kds_rush_mode') === 'true',
  textSize: (localStorage.getItem('kds_text_size') as TextSize) || 'L',
  soundEnabled: localStorage.getItem('kds_sound') !== 'false',
  wakeLockActive: false,
  warnThresholdMinutes: 10,
  criticalThresholdMinutes: 15,
  isLoading: true,
  lastFetchedAt: null,
  isOosOpen: false,
  isRecentlyServedOpen: false,

  setOosOpen: (isOosOpen) => set({ isOosOpen }),
  setRecentlyServedOpen: (isRecentlyServedOpen) => set({ isRecentlyServedOpen }),

  fetchKitchenState: async () => {
    set({ isLoading: true });
    try {
      if (navigator.onLine) {
        const data = await apiFetch<{ activeKots?: KitchenKot[] }>('/kitchen/state');
        const activeKots: KitchenKot[] = data.activeKots || [];
        set({
          kots: activeKots,
          lastFetchedAt: Date.now(),
          isLoading: false,
        });
        // Cache to local Dexie
        await localDb.activeKots.clear();
        await localDb.activeKots.bulkPut(activeKots);
      } else {
        // Fallback to local Dexie
        const cached = await localDb.activeKots.toArray();
        set({ kots: cached, isLoading: false });
      }
    } catch (err) {
      console.warn('Failed to fetch kitchen state from API, reading local cache:', err);
      const cached = await localDb.activeKots.toArray();
      set({ kots: cached, isLoading: false });
    }
  },

  toggleRushMode: () => {
    const next = !get().rushMode;
    localStorage.setItem('kds_rush_mode', String(next));
    set({ rushMode: next });
  },

  setTextSize: (textSize) => {
    localStorage.setItem('kds_text_size', textSize);
    set({ textSize });
  },

  setSoundEnabled: (soundEnabled) => {
    localStorage.setItem('kds_sound', String(soundEnabled));
    set({ soundEnabled });
  },

  markKotSeen: async (kotId) => {
    // Optimistic local update
    const nextKots = get().kots.map((k) =>
      k.id === kotId
        ? {
            ...k,
            seenAt: new Date().toISOString(),
            status: k.status === 'new' ? ('preparing' as const) : k.status,
          }
        : k,
    );
    set({ kots: nextKots });
    await localDb.activeKots.bulkPut(nextKots);

    // Queue in outbox
    await useOutboxStore.getState().enqueue('kot.seen', { kotId });
  },

  toggleItemDone: async (kotId, itemId) => {
    const currentKots = get().kots;
    const targetKot = currentKots.find((k) => k.id === kotId);
    if (!targetKot) return;

    const item = targetKot.items.find((i) => i.id === itemId);
    if (!item) return;

    const newStatus = item.status === 'done' ? 'pending' : 'done';

    // Optimistic update
    const updatedItems = targetKot.items.map((i) =>
      i.id === itemId
        ? {
            ...i,
            status: newStatus as 'pending' | 'done',
            doneAt: newStatus === 'done' ? new Date().toISOString() : null,
          }
        : i,
    );

    const allDone = updatedItems
      .filter((i) => i.action !== 'cancel' && i.status !== 'cancelled')
      .every((i) => i.status === 'done');

    const updatedKot: KitchenKot = {
      ...targetKot,
      status: allDone ? 'ready' : targetKot.status === 'new' ? 'preparing' : targetKot.status,
      readyAt: allDone ? new Date().toISOString() : targetKot.readyAt,
      items: updatedItems,
    };

    const nextKots = currentKots.map((k) => (k.id === kotId ? updatedKot : k));
    set({ kots: nextKots });
    await localDb.activeKots.bulkPut(nextKots);

    // Queue in outbox
    await useOutboxStore.getState().enqueue('kot.itemDone', { kotItemId: itemId });

    // Show undo toast within 5 seconds
    useToastStore.getState().addToast({
      type: 'info',
      message: `${item.name} marked ${newStatus.toUpperCase()}`,
      durationMs: 4000,
    });
  },

  setKotStatus: async (kotId, status) => {
    const currentKots = get().kots;
    const target = currentKots.find((k) => k.id === kotId);
    if (!target) return;

    if (status === 'served') {
      // Remove from active kots and push to recentlyServed
      const nextActive = currentKots.filter((k) => k.id !== kotId);
      const updatedTarget = {
        ...target,
        status,
        readyAt: target.readyAt || new Date().toISOString(),
      };
      set({
        kots: nextActive,
        recentlyServed: [updatedTarget, ...get().recentlyServed].slice(0, 30),
      });
      await localDb.activeKots.bulkPut(nextActive);
    } else {
      const nextKots = currentKots.map((k) => (k.id === kotId ? { ...k, status } : k));
      set({ kots: nextKots });
      await localDb.activeKots.bulkPut(nextKots);
    }

    await useOutboxStore.getState().enqueue('kot.status', { kotId, status });
  },

  requestWakeLock: async () => {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        const nav = navigator as unknown as {
          wakeLock?: { request: (type: string) => Promise<WakeLockSentinelLike> };
        };
        if (nav.wakeLock) {
          wakeLockSentinel = await nav.wakeLock.request('screen');
          set({ wakeLockActive: true });
          wakeLockSentinel.addEventListener('release', () => {
            set({ wakeLockActive: false });
          });
        }
      } catch (err) {
        console.warn('Screen wake lock request failed:', err);
      }
    }
  },

  releaseWakeLock: () => {
    if (wakeLockSentinel) {
      void wakeLockSentinel.release();
      wakeLockSentinel = null;
      set({ wakeLockActive: false });
    }
  },

  toggleWakeLock: async () => {
    if (get().wakeLockActive) {
      get().releaseWakeLock();
    } else {
      await get().requestWakeLock();
    }
  },

  playNotificationSound: () => {
    if (!get().soundEnabled) return;
    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5 tone
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15); // A5 tone

      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch {
      // Fallback
    }
  },

  applyRealtimeKotEvent: (event, _data) => {
    const store = get();

    if (event === 'kot.created') {
      store.playNotificationSound();
      void store.fetchKitchenState();
    } else if (
      event === 'kot.updated' ||
      event === 'kot.itemDone' ||
      event === 'kot.statusChanged'
    ) {
      void store.fetchKitchenState();
    }
  },
}));
