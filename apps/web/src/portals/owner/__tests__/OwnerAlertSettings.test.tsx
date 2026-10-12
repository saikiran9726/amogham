import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { apiFetch } from '../../../stores/useAuthStore.js';
import { OwnerAlertSettings } from '../OwnerAlertSettings.js';

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../stores/useToastStore.js', () => ({
  useToastStore: () => ({ addToast: vi.fn() }),
}));

const apiFetchMock = vi.mocked(apiFetch);
const settings = {
  id: 'settings-1',
  restaurantId: 'restaurant-1',
  cashMismatchTolerancePaise: 5000,
  highExpenseMultiplier: 1.5,
  highExpenseMinAmountPaise: 500000,
  upiPendingTimeoutHours: 2,
  profitDeclinePointsThreshold: 5,
  regularCustomerInactiveDays: 30,
  enabledAlerts: {
    cash_mismatch: true,
    low_stock: false,
    high_expense: true,
    payment_reconciliation: true,
    profit_decline: true,
  },
  enabledInsights: {
    sales_change: true,
    top_seller: true,
    supply_cost_change: true,
    margin_change: true,
    unreturned_regulars: true,
    consumption_change: true,
  },
  updatedAt: '2026-10-11T10:00:00.000Z',
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OwnerAlertSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('OwnerAlertSettings response contract', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
  });

  it('uses validated settings from the standard API envelope', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: settings });
    const queryClient = renderPage();
    expect(await screen.findByText('Alert Thresholds & Configuration')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Low Stock Level/ })).not.toBeChecked();
    queryClient.clear();
  });

  it('shows a retryable error when settings data is malformed', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: { enabledAlerts: {} } });
    const queryClient = renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid API response from /alert-settings.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });
});
