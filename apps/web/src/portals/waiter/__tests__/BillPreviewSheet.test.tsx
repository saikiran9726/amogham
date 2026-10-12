import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../../stores/useAuthStore.js', () => ({
  apiFetch,
  useAuthStore: (selector?: (state: any) => any) => {
    const state = {
      user: {
        id: 'u-1',
        name: 'Waiter',
        role: 'WAITER',
        permissions: ['bill.create', 'discount.apply'],
      },
    };
    return selector ? selector(state) : state;
  },
}));

import {
  BILL_PREVIEW_TIMEOUT_MS,
  BillPreviewSheet,
  fetchBillPreview,
} from '../BillPreviewSheet.js';

const billResponse = {
  taxMode: 'exclusive',
  bill: {
    id: 'bill-1',
    billNumber: 'BILL-42',
    status: 'unpaid',
    subtotalPaise: 10000,
    discountPaise: 0,
    discountType: null,
    discountValue: null,
    discountReason: null,
    serviceChargePaise: 0,
    taxPaise: 500,
    roundOffPaise: 0,
    totalPaise: 10500,
  },
  lines: [],
  payments: [],
};

function renderPreview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BillPreviewSheet isOpen orderId="order-1" tableLabel="T-1" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('BillPreviewSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a successful bill preview and sends JSON to the bill API', async () => {
    apiFetch.mockResolvedValue(billResponse);

    renderPreview();

    expect(await screen.findByText('BILL-42')).toBeInTheDocument();
    expect(screen.getByText('GST mode: added to item prices')).toBeInTheDocument();
    expect(screen.getByText('Discount')).toBeInTheDocument();
    expect(screen.getByText('Total GST')).toBeInTheDocument();
    expect(screen.getByText('Round-off Adjustment')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      '/orders/order-1/bill',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringMatching(/"idempotencyKey":"bill_order-1_/),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('retries an ambiguous bill request with the same idempotency key', async () => {
    apiFetch
      .mockRejectedValueOnce(new Error('Network response lost'))
      .mockResolvedValueOnce(billResponse);

    await expect(fetchBillPreview('order-1', new AbortController().signal)).rejects.toThrow(
      'Network response lost',
    );
    const savedKey = localStorage.getItem('restaurant-os:bill-attempt:v1:order-1');
    expect(savedKey).toBeTruthy();

    await fetchBillPreview('order-1', new AbortController().signal);

    const requestKeys = apiFetch.mock.calls.map(
      ([, options]) => JSON.parse(options.body).idempotencyKey,
    );
    expect(requestKeys).toEqual([savedKey, savedKey]);
    expect(localStorage.getItem('restaurant-os:bill-attempt:v1:order-1')).toBeNull();
  });

  it('shows the API error and retry action instead of leaving the computing state', async () => {
    apiFetch.mockRejectedValue(new Error('Order could not be billed'));

    renderPreview();

    expect(await screen.findByRole('alert')).toHaveTextContent('Order could not be billed');
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeInTheDocument();
    expect(screen.queryByText('Computing order bill...')).not.toBeInTheDocument();
  });

  it('aborts and reports a request that exceeds the preview timeout', async () => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    const pending = fetchBillPreview('order-1', new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Bill preview request timed out. Please try again.',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BILL_PREVIEW_TIMEOUT_MS);
    });

    await rejected;
  });
});
