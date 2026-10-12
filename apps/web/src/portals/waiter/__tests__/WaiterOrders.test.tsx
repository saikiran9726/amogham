import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../../stores/useAuthStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../stores/useAuthStore.js')>()),
  apiFetch,
}));

import { WaiterOrders } from '../index.js';
import { useSocketStore } from '../../../stores/useSocketStore.js';

function renderPage(initialEntries = ['/orders']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={initialEntries}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/orders"
            element={
              <>
                <Link to="/away">Leave page</Link>
                <WaiterOrders />
              </>
            }
          />
          <Route
            path="/away"
            element={
              <>
                <p>Other waiter page</p>
                <Link to="/orders">Return to orders</Link>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const emptyKitchen = { activeKots: [] };

describe('Waiter Active Orders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSocketStore.setState({ kotStatusEventVersion: 0 });
  });
  afterEach(() => cleanup());

  function mockResponses(kitchen: unknown, orders: unknown = []) {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(path === '/kitchen/state' ? kitchen : orders),
    );
  }

  it('renders the kitchen-state response details and statuses', async () => {
    mockResponses({
      activeKots: [
        {
          id: 'kot-1',
          orderId: 'order-12345678-rest',
          tableLabel: 'T-1',
          kotNumber: 42,
          type: 'new',
          status: 'preparing',
          createdAt: '2026-10-11T10:00:00.000Z',
          seenAt: null,
          readyAt: null,
          items: [
            {
              id: 'kot-item-1',
              kotId: 'kot-1',
              orderItemId: 'order-item-1',
              name: 'Crispy Corn',
              qty: 2,
              action: 'add',
              status: 'pending',
              noteSnapshot: 'No chilli',
              modifiers: [],
              doneAt: null,
            },
          ],
        },
      ],
    });

    renderPage();

    expect(await screen.findByRole('article', { name: 'KOT 42, preparing' })).toBeInTheDocument();
    expect(screen.getByText(/T-1 · KOT #42/)).toBeInTheDocument();
    expect(screen.getByText(/Order order-12/)).toBeInTheDocument();
    expect(screen.getByText('Crispy Corn')).toBeInTheDocument();
    expect(screen.getByText('No chilli')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/kitchen/state');
  });

  it('immediately refetches the kitchen state after a KOT status event', async () => {
    mockResponses({
      activeKots: [
        {
          id: 'kot-ready',
          orderId: 'order-ready-12345678',
          tableLabel: 'T-1',
          kotNumber: 43,
          type: 'new',
          status: 'preparing',
          createdAt: '2026-10-11T10:00:00.000Z',
          seenAt: null,
          readyAt: null,
          items: [],
        },
      ],
    });

    renderPage();
    expect(await screen.findByRole('article', { name: 'KOT 43, preparing' })).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([path]) => path === '/kitchen/state')).toHaveLength(1);

    act(() => useSocketStore.setState({ kotStatusEventVersion: 1 }));

    await waitFor(() => {
      expect(apiFetch.mock.calls.filter(([path]) => path === '/kitchen/state')).toHaveLength(2);
    });
  });

  it('keeps a takeaway order in Active Orders after KOT submission', async () => {
    mockResponses(
      {
        activeKots: [
          {
            id: 'kot-takeaway',
            orderId: 'takeaway-12345678',
            tableLabel: null,
            kotNumber: 7,
            type: 'new',
            status: 'preparing',
            createdAt: '2026-10-11T10:00:00Z',
            items: [
              {
                id: 'item-a',
                kotId: 'kot-takeaway',
                orderItemId: 'line-a',
                name: 'Dosa',
                qty: 1,
                action: 'add',
                status: 'pending',
              },
            ],
          },
        ],
      },
      [
        {
          id: '10000000-0000-4000-8000-000000000001',
          type: 'takeaway',
          status: 'saved',
          kotStatuses: ['preparing'],
          totalPaise: 1000,
          createdAt: new Date(),
          itemSummary: '1x Dosa',
          items: [],
        },
      ],
    );

    renderPage();
    expect(await screen.findByRole('article', { name: 'KOT 7, preparing' })).toBeInTheDocument();
    expect(screen.getByText(/Takeaway · KOT #7/)).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /Takeaway order .* completed/ }),
    ).not.toBeInTheDocument();
  });

  it('keeps a takeaway KOT visible as Ready without classifying it as completed', async () => {
    mockResponses(
      {
        activeKots: [
          {
            id: 'kot-ready',
            orderId: 'takeaway-ready-1',
            tableLabel: null,
            kotNumber: 8,
            type: 'new',
            status: 'ready',
            createdAt: '2026-10-11T10:00:00Z',
            items: [
              {
                id: 'item-ready',
                kotId: 'kot-ready',
                orderItemId: 'line-ready',
                name: 'Idli',
                qty: 2,
                action: 'add',
                status: 'done',
              },
            ],
          },
        ],
      },
      [
        {
          id: '10000000-0000-4000-8000-000000000002',
          type: 'takeaway',
          status: 'saved',
          kotStatuses: ['ready'],
          totalPaise: 900,
          createdAt: new Date(),
          itemSummary: '2x Idli',
          items: [],
        },
      ],
    );

    renderPage();
    expect(await screen.findByRole('article', { name: 'KOT 8, ready' })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: /Takeaway order .* completed/ }),
    ).not.toBeInTheDocument();
  });

  it('shows served takeaway orders in completed history, not Active Orders', async () => {
    mockResponses(emptyKitchen, [
      {
        id: '10000000-0000-4000-8000-000000000003',
        type: 'takeaway',
        status: 'saved',
        kotStatuses: ['served'],
        totalPaise: 1200,
        createdAt: new Date(),
        itemSummary: '1x Masala Dosa',
        items: [],
      },
    ]);

    renderPage();
    expect(
      await screen.findByRole('article', { name: 'Takeaway order 10000000, completed' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1x Masala Dosa')).toBeInTheDocument();
    expect(screen.getByText('No active kitchen orders')).toBeInTheDocument();
  });

  it('opens the shared bill preview for a completed unpaid takeaway and deduplicates repeated clicks', async () => {
    const orderId = '10000000-0000-4000-8000-000000000005';
    apiFetch.mockImplementation((path: string) => {
      if (path === '/kitchen/state') return Promise.resolve(emptyKitchen);
      if (path === '/orders/recent') {
        return Promise.resolve([
          {
            id: orderId,
            type: 'takeaway',
            status: 'saved',
            kotStatuses: ['served'],
            billStatus: null,
            paidPaise: 0,
            pendingPaymentPaise: 0,
            totalPaise: 1000,
            createdAt: new Date(),
            itemSummary: '1x Dosa',
            items: [],
          },
        ]);
      }
      if (path === `/orders/${orderId}/bill`) {
        return Promise.resolve({
          taxMode: 'exclusive',
          bill: {
            id: 'bill-takeaway',
            billNumber: 'BILL-TAKEAWAY',
            status: 'unpaid',
            subtotalPaise: 1000,
            discountPaise: 0,
            serviceChargePaise: 0,
            taxPaise: 50,
            roundOffPaise: -50,
            totalPaise: 1000,
          },
          lines: [{ id: 'line-a', name: 'Dosa', qty: 1, subtotalPaise: 1000, pricePaise: 1000 }],
          payments: [],
        });
      }
      return Promise.resolve({});
    });

    renderPage();
    const createBill = await screen.findByRole('button', {
      name: 'Open bill for takeaway order 10000000',
    });
    fireEvent.click(createBill);
    fireEvent.click(createBill);

    expect(await screen.findByText('BILL-TAKEAWAY')).toBeInTheDocument();
    expect(screen.getByText('GST mode: added to item prices')).toBeInTheDocument();
    expect(screen.getByText('Dosa')).toBeInTheDocument();
    const billRequests = apiFetch.mock.calls.filter(([path]) => path === `/orders/${orderId}/bill`);
    expect(billRequests).toHaveLength(1);
    expect(JSON.parse(billRequests[0]![1].body).idempotencyKey).toMatch(/^bill_/);
  });

  it('keeps confirmed payment status visible on a completed takeaway order', async () => {
    mockResponses(emptyKitchen, [
      {
        id: '10000000-0000-4000-8000-000000000006',
        type: 'takeaway',
        status: 'billed',
        kotStatuses: ['served'],
        billStatus: 'paid',
        paidPaise: 10500,
        pendingPaymentPaise: 0,
        totalPaise: 10500,
        createdAt: new Date(),
        itemSummary: '1x Dosa',
        items: [],
      },
    ]);

    renderPage();
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'View bill for takeaway order 10000000' }),
    ).toBeInTheDocument();
  });

  it('refetches active and completed takeaway data after navigating away and back', async () => {
    const preparingKot = {
      id: 'kot-nav',
      orderId: 'takeaway-nav-1',
      tableLabel: null,
      kotNumber: 9,
      type: 'new',
      status: 'preparing',
      createdAt: '2026-10-11T10:00:00Z',
      items: [
        {
          id: 'item-nav',
          kotId: 'kot-nav',
          orderItemId: 'line-nav',
          name: 'Uttapam',
          qty: 1,
          action: 'add',
          status: 'pending',
        },
      ],
    };
    const savedOrder = {
      id: '10000000-0000-4000-8000-000000000004',
      type: 'takeaway',
      status: 'saved',
      kotStatuses: ['preparing'],
      billStatus: null,
      paidPaise: 0,
      pendingPaymentPaise: 0,
      totalPaise: 1000,
      createdAt: new Date(),
      itemSummary: '1x Uttapam',
      items: [],
    };
    let activeFetches = 0;
    let historyFetches = 0;
    apiFetch.mockImplementation((path: string) => {
      if (path === '/kitchen/state') {
        activeFetches += 1;
        return Promise.resolve(activeFetches === 1 ? { activeKots: [preparingKot] } : emptyKitchen);
      }
      historyFetches += 1;
      return Promise.resolve(
        historyFetches === 1 ? [savedOrder] : [{ ...savedOrder, kotStatuses: ['served'] }],
      );
    });

    renderPage();
    expect(await screen.findByRole('article', { name: 'KOT 9, preparing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Leave page' }));
    expect(await screen.findByText('Other waiter page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Return to orders' }));
    expect(
      await screen.findByRole('article', { name: 'Takeaway order 10000000, completed' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'KOT 9, preparing' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open bill for takeaway order 10000000' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiFetch.mock.calls.filter(([path]) => path === '/kitchen/state')).toHaveLength(2),
    );
    expect(apiFetch.mock.calls.filter(([path]) => path === '/orders/recent')).toHaveLength(2);
  });

  it('shows a retryable history error for malformed recent-order responses', async () => {
    mockResponses(emptyKitchen, { success: true, data: [] });
    renderPage();
    expect(
      await screen.findByText('Could not load completed takeaway orders.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an empty state when the kitchen feed has no active KOTs', async () => {
    mockResponses(emptyKitchen);
    renderPage();
    expect(await screen.findByText('No active kitchen orders')).toBeInTheDocument();
  });

  it('shows an actionable error state when the kitchen feed fails', async () => {
    apiFetch.mockImplementation((path: string) =>
      path === '/kitchen/state' ? Promise.reject(new Error('request failed')) : Promise.resolve([]),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load active orders.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
