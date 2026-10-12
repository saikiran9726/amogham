import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, bulkPut, toArray, initNewOrder, loadOrder, useCartStoreMock } = vi.hoisted(
  () => ({
    apiFetch: vi.fn(),
    bulkPut: vi.fn(async () => undefined),
    toArray: vi.fn(async () => []),
    initNewOrder: vi.fn(),
    loadOrder: vi.fn(async () => true),
    useCartStoreMock: vi.fn(),
  }),
);

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch }));
vi.mock('../../../db/dexie.js', () => ({
  localDb: { floorTables: { bulkPut, toArray } },
}));
vi.mock('../../../stores/useCartStore.js', () => ({ useCartStore: useCartStoreMock }));
vi.mock('../POSView.js', () => ({
  POSView: () => <div>POS opened</div>,
}));

import { WaiterHome } from '../WaiterHome.js';

function renderWaiterHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WaiterHome />
    </QueryClientProvider>,
  );
}

describe('waiter occupied table order opening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCartStoreMock.mockReturnValue({ initNewOrder, loadOrder });
    loadOrder.mockResolvedValue(true);
    apiFetch.mockResolvedValue([
      {
        id: 'table-t1',
        restaurantId: 'restaurant-1',
        label: 'T-1',
        capacity: 4,
        section: 'Main',
        active: true,
        status: 'occupied',
        currentOrderId: '01a12956-6257-7000-8474-eff5514f79d2',
      },
    ]);
  });
  afterEach(() => cleanup());

  it('opens the linked saved order for an occupied table without starting a new order', async () => {
    renderWaiterHome();
    fireEvent.click(await screen.findByRole('button', { name: /T-1/ }));

    expect(await screen.findByText('POS opened')).toBeInTheDocument();
    expect(loadOrder).toHaveBeenCalledWith('01a12956-6257-7000-8474-eff5514f79d2');
    expect(initNewOrder).not.toHaveBeenCalled();
  });

  it('does not open a new order if the linked saved order cannot be loaded', async () => {
    loadOrder.mockResolvedValue(false);
    renderWaiterHome();
    fireEvent.click(await screen.findByRole('button', { name: /T-1/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No new order was started.');
    expect(screen.queryByText('POS opened')).not.toBeInTheDocument();
    expect(initNewOrder).not.toHaveBeenCalled();
  });

  it('refuses to start an order when an occupied table has no linked order ID', async () => {
    apiFetch.mockResolvedValue([
      {
        id: 'table-t1',
        restaurantId: 'restaurant-1',
        label: 'T-1',
        capacity: 4,
        section: 'Main',
        active: true,
        status: 'occupied',
        currentOrderId: null,
      },
    ]);
    renderWaiterHome();
    fireEvent.click(await screen.findByRole('button', { name: /T-1/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('has no linked order');
    expect(loadOrder).not.toHaveBeenCalled();
    expect(initNewOrder).not.toHaveBeenCalled();
  });
});
