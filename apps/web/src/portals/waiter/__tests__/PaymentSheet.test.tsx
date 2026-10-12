import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        permissions: ['payment.take', 'bill.create'],
      },
    };
    return selector ? selector(state) : state;
  },
}));

import { PaymentSheet } from '../PaymentSheet.js';

const bill = {
  id: 'bill-1',
  billNumber: 'BILL-1',
  totalPaise: 10_000,
  loyaltyPointsRedeemed: 0,
};

function renderPaymentSheet(tableLabel: string | null = 'T-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PaymentSheet isOpen bill={bill} tableLabel={tableLabel} onClose={vi.fn()} onPaid={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('PaymentSheet payment attempt idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    apiFetch.mockImplementation((url: string) => {
      if (url === '/bills/bill-1') return Promise.resolve({ bill, payments: [] });
      if (url === '/bills/bill-1/receipt') {
        return Promise.resolve({ receiptData: {}, templateConfig: {} });
      }
      return Promise.resolve({});
    });
  });
  afterEach(cleanup);

  it('reuses the original key after an ambiguous request and PaymentSheet remount', async () => {
    let paymentRequestCount = 0;
    apiFetch.mockImplementation((url: string) => {
      if (url === '/bills/bill-1') return Promise.resolve({ bill, payments: [] });
      if (url === '/bills/bill-1/receipt') {
        return Promise.resolve({ receiptData: {}, templateConfig: {} });
      }
      if (url === '/bills/bill-1/payments') {
        paymentRequestCount += 1;
        if (paymentRequestCount === 1) return Promise.reject(new Error('Network response lost'));
        return Promise.resolve({ isFullyPaid: false });
      }
      return Promise.resolve({});
    });

    const firstRender = renderPaymentSheet();
    const recordButton = await screen.findByRole('button', { name: /Record .*\(CASH\)/ });
    fireEvent.click(recordButton);

    await waitFor(() => expect(paymentRequestCount).toBe(1));
    const firstPayload = JSON.parse(
      apiFetch.mock.calls.find(([url]) => url === '/bills/bill-1/payments')![1].body,
    );

    await waitFor(() => expect(recordButton).not.toBeDisabled());
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('restaurant-os:payment-attempt:v1:bill-1')).toBe(
      firstPayload.idempotencyKey,
    );
    firstRender.unmount();

    renderPaymentSheet();
    const remountedButton = await screen.findByRole('button', { name: /Record .*\(CASH\)/ });
    fireEvent.click(remountedButton);

    await waitFor(() => expect(paymentRequestCount).toBe(2));
    const paymentCalls = apiFetch.mock.calls.filter(([url]) => url === '/bills/bill-1/payments');
    const secondPayload = JSON.parse(paymentCalls[1]![1].body);
    expect(secondPayload.idempotencyKey).toBe(firstPayload.idempotencyKey);
    expect(secondPayload.amountPaise).toBe(firstPayload.amountPaise);
    await waitFor(() => expect(localStorage.length).toBe(0));
  });

  it('shows confirmed takeaway settlement without claiming a table was released', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/bills/bill-1') return Promise.resolve({ bill, payments: [] });
      if (url === '/bills/bill-1/receipt') {
        return Promise.resolve({ receiptData: {}, templateConfig: {} });
      }
      if (url === '/bills/bill-1/payments') return Promise.resolve({ isFullyPaid: true });
      return Promise.resolve({});
    });

    renderPaymentSheet(null);
    fireEvent.click(await screen.findByRole('button', { name: /Record .*\(CASH\)/ }));

    expect(await screen.findByText('Payment Complete!')).toBeInTheDocument();
    expect(screen.getByText('Bill settled • Takeaway order marked billed.')).toBeInTheDocument();
    expect(screen.queryByText(/Table released/)).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      '/bills/bill-1/payments',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps another payment disabled while UPI confirmation is pending', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/bills/bill-1') {
        return Promise.resolve({
          bill,
          payments: [
            {
              id: 'pending-1',
              method: 'upi',
              amountPaise: 6_000,
              status: 'pending_confirmation',
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === '/bills/bill-1/receipt') {
        return Promise.resolve({ receiptData: {}, templateConfig: {} });
      }
      return Promise.resolve({});
    });

    renderPaymentSheet(null);

    expect(await screen.findByText(/is pending payment confirmation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record .*\(CASH\)/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment Received' })).toBeInTheDocument();
  });
});
