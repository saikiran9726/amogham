import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from './useAuthStore.js';
import { useToastStore } from './useToastStore.js';
import { useKitchenStore } from './useKitchenStore.js';
import { localDb } from '../db/dexie.js';
import { useConnectionStore } from './useConnectionStore.js';
import { Roles } from '@restaurant-os/shared';

interface SocketState {
  socket: Socket | null;
  isConnected: boolean;
  isPaused: boolean;
  waiterSoundEnabled: boolean;
  lastEventTimestamp: number;
  kotStatusEventVersion: number;
  init: () => void;
  disconnect: () => void;
  refreshAuth: () => Promise<boolean>;
  setWaiterSoundEnabled: (enabled: boolean) => void;
}

const notifiedReadyKots = new Set<string>();

interface IncomingSocketEvent {
  event: string;
  data: unknown;
  timestamp?: number;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  isConnected: false,
  isPaused: false,
  waiterSoundEnabled: localStorage.getItem('waiter_ready_sound') === 'true',
  lastEventTimestamp: Date.now(),
  kotStatusEventVersion: 0,

  setWaiterSoundEnabled: (waiterSoundEnabled) => {
    localStorage.setItem('waiter_ready_sound', String(waiterSoundEnabled));
    set({ waiterSoundEnabled });
  },

  refreshAuth: async () => {
    const s = get().socket;
    const refreshed = await useAuthStore.getState().refresh();
    if (!refreshed) {
      useAuthStore.getState().setSessionExpiredModalOpen(true);
      return false;
    }

    const freshToken = useAuthStore.getState().accessToken;
    if (!freshToken) return false;

    if (s && s.connected) {
      return new Promise<boolean>((resolve) => {
        s.emit('auth:refresh', { token: freshToken }, (res?: { ok: boolean }) => {
          if (res?.ok) {
            resolve(true);
          } else {
            s.disconnect();
            s.connect();
            resolve(true);
          }
        });
      });
    } else if (s) {
      s.connect();
      return true;
    }
    return true;
  },

  init: () => {
    const existing = get().socket;
    if (existing) return;

    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    // Dynamic token retrieval for automatic reconnect handshakes
    const s = io(useConnectionStore.getState().getBaseUrl(), {
      auth: (cb) => {
        cb({ token: useAuthStore.getState().accessToken });
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    s.on('connect', () => {
      set({ isConnected: true, isPaused: false });
      // Catch up on reconnect: server returns tenant-scoped missed events
      s.emit(
        'catch_up',
        { since: get().lastEventTimestamp },
        (events: IncomingSocketEvent[] = []) => {
          if (Array.isArray(events)) {
            for (const ev of events) {
              if (ev.event === 'kot.statusChanged') {
                set((state) => ({
                  kotStatusEventVersion: state.kotStatusEventVersion + 1,
                  lastEventTimestamp: ev.timestamp || Date.now(),
                }));
              }
              handleIncomingRealtimeEvent(ev.event, ev.data);
            }
          }
        },
      );
    });

    s.on('disconnect', () => {
      set({ isConnected: false, isPaused: true });
    });

    // Handle token expiry signaled by server
    s.on('auth:expired', async () => {
      await get().refreshAuth();
    });

    s.on('connect_error', async (err: Error) => {
      if (err.message && /auth|token|expired/i.test(err.message)) {
        await get().refreshAuth();
      }
    });

    // Realtime events
    s.on('kot.created', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('kot.created', payload.data);
    });

    s.on('kot.updated', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('kot.updated', payload.data);
    });

    s.on('kot.itemDone', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('kot.itemDone', payload.data);
    });

    s.on('kot.statusChanged', (payload: { timestamp?: number; data: unknown }) => {
      set((state) => ({
        lastEventTimestamp: payload.timestamp || Date.now(),
        kotStatusEventVersion: state.kotStatusEventVersion + 1,
      }));
      handleIncomingRealtimeEvent('kot.statusChanged', payload.data);
    });

    s.on('order.ready', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('order.ready', payload.data);
    });

    s.on('table.statusChanged', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('table.statusChanged', payload.data);
    });

    s.on('menu.availabilityChanged', (payload: { timestamp?: number; data: unknown }) => {
      set({ lastEventTimestamp: payload.timestamp || Date.now() });
      handleIncomingRealtimeEvent('menu.availabilityChanged', payload.data);
    });

    set({ socket: s });
  },

  disconnect: () => {
    const s = get().socket;
    if (s) {
      s.disconnect();
      set({ socket: null, isConnected: false });
    }
  },
}));

function handleIncomingRealtimeEvent(event: string, data: unknown) {
  const { addToast } = useToastStore.getState();

  // Forward to kitchen store if active
  useKitchenStore.getState().applyRealtimeKotEvent(event, data);

  switch (event) {
    case 'order.ready': {
      // Per-KOT readiness is announced by kot.statusChanged to avoid duplicate
      // order-level alerts when the final item and KOT events arrive together.
      break;
    }
    case 'kot.statusChanged': {
      notifyWaiterKotReady(
        data as {
          kotId?: string;
          status?: string;
          tableLabel?: string | null;
          kotNumber?: number;
        },
      );
      break;
    }
    case 'table.statusChanged': {
      const tableData = data as { tableId?: string; status?: string };
      if (tableData?.tableId && tableData?.status) {
        localDb.floorTables.update(tableData.tableId, { status: tableData.status }).catch(() => {});
      }
      break;
    }
    case 'menu.availabilityChanged': {
      const menuData = data as { itemId?: string; available?: boolean; oosReason?: string | null };
      if (menuData?.itemId !== undefined && menuData?.available !== undefined) {
        localDb.menu
          .update(menuData.itemId, {
            available: menuData.available,
            oosReason: menuData.oosReason || null,
          } as { available: boolean; oosReason: string | null })
          .catch(() => {});

        if (!menuData.available) {
          addToast({
            type: 'warning',
            message: `Menu item was marked OUT OF STOCK: ${menuData.oosReason || ''}`,
          });
        }
      }
      break;
    }
  }
}

/** Shared by Socket.IO and the waiter's polling fallback so one KOT yields one toast. */
export function notifyWaiterKotReady(data: {
  kotId?: string;
  status?: string;
  tableLabel?: string | null;
  kotNumber?: number;
}): boolean {
  if (
    useAuthStore.getState().user?.role !== Roles.WAITER ||
    data.status !== 'ready' ||
    !data.kotId ||
    notifiedReadyKots.has(data.kotId)
  ) {
    return false;
  }

  if (notifiedReadyKots.size >= 300) {
    const oldestKotId = notifiedReadyKots.values().next().value;
    if (oldestKotId) notifiedReadyKots.delete(oldestKotId);
  }
  notifiedReadyKots.add(data.kotId);
  useToastStore.getState().addToast({
    type: 'success',
    message: `${data.tableLabel ? `Table ${data.tableLabel}` : 'Order'} · KOT #${data.kotNumber || data.kotId.slice(0, 6)} is ready to serve.`,
  });
  if (useSocketStore.getState().waiterSoundEnabled) playWaiterReadySound();
  return true;
}

function playWaiterReadySound() {
  try {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    void context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    gain.gain.setValueAtTime(0.16, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
    oscillator.onended = () => void context.close();
  } catch {
    // Audio may be unavailable until a user gesture; the visual toast remains.
  }
}
