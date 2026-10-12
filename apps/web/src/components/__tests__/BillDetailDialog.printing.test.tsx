import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { printBill, addToast } = vi.hoisted(() => ({ printBill: vi.fn(), addToast: vi.fn() }));

vi.mock('../../services/printer/printer-service.js', () => ({
  printerService: { printBill },
}));

import { BillDetailDialog } from '../BillDetailDialog.js';
import { useAuthStore, apiFetch } from '../../stores/useAuthStore.js';
import { Permissions } from '@restaurant-os/shared';

let billFixture: { status: string; printedCount: number };

vi.mock('../../stores/useAuthStore.js', async () => {
  const actual = await vi.importActual<typeof import('../../stores/useAuthStore.js')>(
    '../../stores/useAuthStore.js',
  );
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('../../stores/useToastStore.js', () => ({
  useToastStore: () => ({ addToast }),
}));

function mountBillDetail(permissions: string[]) {
  act(() => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'cashier',
        name: 'Cashier',
        role: 'CASHIER',
        permissions,
      } as any,
    });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BillDetailDialog isOpen billId="bill-1" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('BillDetailDialog receipt printing', () => {
  beforeEach(() => {
    billFixture = { status: 'paid', printedCount: 2 };
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === '/staff/approvers') {
        return [{ id: 'appr-1', name: 'Manager Bob', role: 'MANAGER' }] as any;
      }
      return {
        bill: {
          id: 'bill-1',
          billNumber: 'B-1',
          ...billFixture,
          totalPaise: 10000,
          subtotalPaise: 10000,
          discountPaise: 0,
          serviceChargePaise: 0,
          taxPaise: 0,
          roundOffPaise: 0,
          createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        },
        lines: [],
        payments: [],
        refunds: [],
      } as any;
    });
    printBill.mockReset();
    addToast.mockReset();
    printBill.mockResolvedValue({ success: true, jobId: 'print-job-1' });
  });

  afterEach(() => {
    act(() => useAuthStore.setState({ user: null }));
  });

  it('opens owner PIN authorization and only then invokes the reprint service', async () => {
    mountBillDetail([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reprint Receipt (#2)' }));
    expect(screen.getByText(/Reprinting a paid bill requires/i)).toBeInTheDocument();
    expect(printBill).not.toHaveBeenCalled();

    // Wait for approvers to load
    await screen.findByText('Manager Bob (MANAGER)');

    for (const digit of ['1', '2', '3', '4']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${digit}$`) }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));

    await waitFor(() =>
      expect(printBill).toHaveBeenCalledWith(
        'bill-1',
        expect.objectContaining({
          isReprint: true,
          approverUserId: 'appr-1',
          pin: '1234',
        }),
      ),
    );
  });

  it('uses the receipt printer service for an authorized reprint', async () => {
    mountBillDetail([Permissions.BILL_REPRINT]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reprint Receipt (#2)' }));

    await waitFor(() =>
      expect(printBill).toHaveBeenCalledWith('bill-1', { isReprint: true, ownerPin: undefined }),
    );
  });

  it('shows the actual printer error and does not report a failed print as successful', async () => {
    printBill.mockResolvedValue({ success: false, error: 'Printer offline', jobId: 'job-1' });
    billFixture = { status: 'unpaid', printedCount: 0 };
    mountBillDetail([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Print Receipt' }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        type: 'danger',
        message: 'Printer offline',
      }),
    );
    expect(addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Receipt sent to printer' }),
    );
  });
});
