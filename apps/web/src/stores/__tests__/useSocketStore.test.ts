import { beforeEach, describe, expect, it, vi } from 'vitest';

const { socketHandlers, socket, addToast, applyRealtimeKotEvent, refreshMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const fakeSocket = {
    connected: true,
    auth: {} as Record<string, unknown>,
    connect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return fakeSocket;
    }),
    emit: vi.fn((event: string, _payload: unknown, ack?: (events: unknown) => void) => {
      if (event === 'catch_up') (ack as (events: unknown[]) => void)?.([]);
      if (event === 'auth:refresh') (ack as (res: { ok: boolean }) => void)?.({ ok: true });
    }),
    disconnect: vi.fn(),
  };
  return {
    socketHandlers: handlers,
    socket: fakeSocket,
    addToast: vi.fn(),
    applyRealtimeKotEvent: vi.fn(),
    refreshMock: vi.fn(async () => true),
  };
});

vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('../useAuthStore.js', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'test-token',
      user: { role: 'WAITER' },
      refresh: refreshMock,
      setSessionExpiredModalOpen: vi.fn(),
    }),
  },
}));
vi.mock('../useToastStore.js', () => ({ useToastStore: { getState: () => ({ addToast }) } }));
vi.mock('../useKitchenStore.js', () => ({
  useKitchenStore: { getState: () => ({ applyRealtimeKotEvent }) },
}));
vi.mock('../useConnectionStore.js', () => ({
  useConnectionStore: { getState: () => ({ getBaseUrl: () => 'http://localhost:4000' }) },
}));
vi.mock('../../db/dexie.js', () => ({
  localDb: { floorTables: { update: vi.fn() }, menu: { update: vi.fn() } },
}));

import { useSocketStore } from '../useSocketStore.js';

describe('waiter KOT ready notifications & socket auth refresh', () => {
  beforeEach(() => {
    socketHandlers.clear();
    vi.clearAllMocks();
    useSocketStore.setState({
      socket: null,
      isConnected: false,
      isPaused: false,
      kotStatusEventVersion: 0,
      waiterSoundEnabled: false,
    });
  });

  it('shows a visible deduplicated notification for a ready KOT without requiring sound', () => {
    useSocketStore.getState().init();
    socketHandlers.get('connect')?.();

    const readyEvent = {
      timestamp: Date.now(),
      data: { kotId: 'ready-kot-1', orderId: 'order-1', kotNumber: 42, status: 'ready' },
    };
    socketHandlers.get('kot.statusChanged')?.(readyEvent);
    socketHandlers.get('kot.statusChanged')?.(readyEvent);

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Order · KOT #42 is ready to serve.',
    });
    expect(useSocketStore.getState().kotStatusEventVersion).toBe(2);
    expect(applyRealtimeKotEvent).toHaveBeenCalledWith('kot.statusChanged', readyEvent.data);
  });

  it('triggers session refresh when auth:expired is signaled by server', async () => {
    useSocketStore.getState().init();
    socketHandlers.get('connect')?.();

    const expiredHandler = socketHandlers.get('auth:expired');
    expect(expiredHandler).toBeDefined();

    await expiredHandler?.();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('refreshAuth executes auth:refresh handshake over active socket', async () => {
    useSocketStore.getState().init();
    const success = await useSocketStore.getState().refreshAuth();

    expect(success).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      'auth:refresh',
      { token: 'test-token' },
      expect.any(Function),
    );
  });
});
