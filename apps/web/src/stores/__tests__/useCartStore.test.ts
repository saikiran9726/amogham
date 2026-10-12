import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueue, addToast, getLocalOrder, getOutboxCommand, apiFetch } = vi.hoisted(() => ({
  enqueue: vi.fn(async (_type: string, _payload: unknown) => 'idempotency-key'),
  addToast: vi.fn(),
  getLocalOrder: vi.fn(async () => undefined as { isSynced: boolean } | undefined),
  getOutboxCommand: vi.fn(async () => undefined as { type: string } | undefined),
  apiFetch: vi.fn(),
}));

vi.mock('../../db/dexie.js', () => ({
  localDb: {
    openOrders: {
      get: getLocalOrder,
      put: vi.fn(async () => undefined),
      update: vi.fn(async () => 1),
    },
    outbox: { get: getOutboxCommand },
    floorTables: { update: vi.fn(async () => 1) },
  },
}));
vi.mock('../useOutboxStore.js', () => ({
  useOutboxStore: { getState: () => ({ enqueue }) },
}));
vi.mock('../useToastStore.js', () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));
vi.mock('../useAuthStore.js', () => ({ apiFetch }));

import { useCartStore, type CartItem } from '../useCartStore.js';

const unsentItem: CartItem = {
  id: 'menu-item-line',
  itemId: '018f9e1e-2895-7800-9831-000000000001',
  name: 'Test dish',
  isVeg: true,
  pricePaise: 10000,
  taxRateBp: 500,
  qty: 1,
  sentQty: 0,
  modifiers: [],
  note: '',
  kotState: 'unsent',
};

describe('waiter cart KOT order persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockReset();
    getLocalOrder.mockResolvedValue(undefined);
    getOutboxCommand.mockResolvedValue(undefined);
    useCartStore.getState().initNewOrder({
      orderId: '018f9e1e-2895-7800-9831-000000000010',
      items: [unsentItem],
    });
    useCartStore.setState({ taxMode: 'exclusive' });
  });

  it('queues a single order.create before kot.send for a new unsaved draft', async () => {
    const orderId = useCartStore.getState().orderId;

    await expect(useCartStore.getState().sendKot()).resolves.toBe(true);

    expect(enqueue.mock.calls.map(([type]) => type)).toEqual(['order.create', 'kot.send']);
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ id: orderId });
    expect(enqueue.mock.calls[1]?.[1]).toMatchObject({ orderId });
    expect(useCartStore.getState().isPersisted).toBe(true);
  });

  it('blocks a concurrent duplicate KOT submission while the first send is being prepared', async () => {
    const firstSend = useCartStore.getState().sendKot();
    await expect(useCartStore.getState().sendKot()).resolves.toBe(false);
    await expect(firstSend).resolves.toBe(true);

    expect(enqueue.mock.calls.map(([type]) => type)).toEqual(['order.create', 'kot.send']);
  });

  it('reuses the existing order ID and does not enqueue order.create for a saved order', async () => {
    const orderId = useCartStore.getState().orderId;
    useCartStore.setState({ isPersisted: true });

    await expect(useCartStore.getState().sendKot()).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('kot.send', expect.objectContaining({ orderId }));
    expect(enqueue).not.toHaveBeenCalledWith('order.create', expect.anything());
  });

  it('recognizes a saved order restored from IndexedDB after a frontend reload', async () => {
    const orderId = useCartStore.getState().orderId;
    getLocalOrder.mockResolvedValue({ isSynced: true });

    await expect(useCartStore.getState().sendKot()).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('kot.send', expect.objectContaining({ orderId }));
    expect(useCartStore.getState().isPersisted).toBe(true);
  });

  it('loads the saved server order and queues its unsent KOT without creating the order again', async () => {
    const orderId = '018f9e1e-2895-7800-9831-000000000020';
    apiFetch.mockResolvedValue({
      id: orderId,
      tableId: '018f9e1e-2895-7800-9831-000000000030',
      tableLabel: 'T-1',
      type: 'dine_in',
      guests: 2,
      version: 1,
      items: [
        {
          id: '018f9e1e-2895-7800-9831-000000000040',
          itemId: unsentItem.itemId,
          nameSnapshot: unsentItem.name,
          pricePaiseSnapshot: unsentItem.pricePaise,
          taxRateBpSnapshot: 500,
          qty: 1,
          modifiers: [],
          note: null,
          kotState: 'unsent',
        },
      ],
    });

    await expect(useCartStore.getState().loadOrder(orderId)).resolves.toBe(true);
    expect(useCartStore.getState().orderId).toBe(orderId);
    expect(useCartStore.getState().getUnsentCount()).toBe(1);

    await expect(useCartStore.getState().sendKot()).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('kot.send', expect.objectContaining({ orderId }));
    expect(enqueue).not.toHaveBeenCalledWith('order.create', expect.anything());
  });

  it('uses the effective exclusive tax mode returned by the API instead of assuming inclusive', async () => {
    useCartStore.setState({ taxMode: null, isTaxModeLoading: false, taxModeError: null });
    apiFetch.mockResolvedValue({ taxMode: 'exclusive' });

    const loadPromise = useCartStore.getState().loadTaxMode();

    expect(useCartStore.getState().taxMode).toBeNull();
    expect(useCartStore.getState().isTaxModeLoading).toBe(true);
    await expect(loadPromise).resolves.toBe(true);
    expect(useCartStore.getState().taxMode).toBe('exclusive');
    expect(apiFetch).toHaveBeenCalledWith('/restaurant/tax-mode');
  });

  it('keeps totals unavailable and blocks order actions when tax mode cannot be loaded', async () => {
    useCartStore.setState({ taxMode: null, isTaxModeLoading: false, taxModeError: null });
    apiFetch.mockRejectedValue(new Error('configuration unavailable'));

    await expect(useCartStore.getState().loadTaxMode()).resolves.toBe(false);

    expect(useCartStore.getState().taxMode).toBeNull();
    expect(useCartStore.getState().getTotals()).toBeNull();
    await expect(useCartStore.getState().saveOrder()).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('adds recent items with current menu data without replacing a sent cart line', () => {
    const menuItemId = '018f9e1e-2895-7800-9831-000000000099';
    const sentLine: CartItem = {
      ...unsentItem,
      id: `${menuItemId}_`,
      itemId: menuItemId,
      qty: 1,
      sentQty: 1,
      orderItemId: '018f9e1e-2895-7800-9831-000000000098',
      kotState: 'preparing',
    };
    useCartStore.setState({ items: [sentLine] });

    useCartStore.getState().repeatOrder({
      items: [
        {
          itemId: menuItemId,
          name: 'Current dish name',
          qty: 2,
          available: true,
          isVeg: false,
          pricePaise: 12500,
          taxRateBp: 1200,
        },
      ],
    });

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]).toMatchObject({
      itemId: menuItemId,
      name: 'Current dish name',
      qty: 3,
      sentQty: 1,
      orderItemId: '018f9e1e-2895-7800-9831-000000000098',
      kotState: 'preparing',
      pricePaise: 12500,
      taxRateBp: 1200,
      isVeg: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
