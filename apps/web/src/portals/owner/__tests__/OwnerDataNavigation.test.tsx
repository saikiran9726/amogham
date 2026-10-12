import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { apiFetch } from '../../../stores/useAuthStore.js';
import { OwnerHome } from '../OwnerHome.js';
import { OwnerAlerts } from '../OwnerAlerts.js';
import { OwnerInsights } from '../OwnerInsights.js';
import { ownerAlertQueryKey, ownerInsightsQueryKey } from '../dataContracts.js';

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../stores/useToastStore.js', () => ({
  useToastStore: () => ({ addToast: vi.fn() }),
}));

const apiFetchMock = vi.mocked(apiFetch);
const alert = {
  id: 'alert-1',
  restaurantId: 'restaurant-1',
  type: 'low_stock',
  severity: 'warning',
  dedupeKey: 'low-stock:item-1',
  payload: { title: 'Low stock', whatIsWrong: 'Stock is low.', whyItMatters: 'It may run out.' },
  firstSeen: '2026-10-11T10:00:00.000Z',
  lastSeen: '2026-10-11T10:00:00.000Z',
  status: 'open',
  snoozedUntil: null,
  resolvedAt: null,
  resolvedBy: null,
  note: null,
  dismissReason: null,
  createdAt: '2026-10-11T10:00:00.000Z',
};
const insight = {
  id: 'insight-1',
  restaurantId: 'restaurant-1',
  period: 'daily',
  kind: 'sales_change',
  text: 'Sales increased today.',
  evidence: { metricName: 'sales', currentValue: 1200, details: {} },
  materialityScore: 42,
  createdAt: '2026-10-11T10:00:00.000Z',
  dismissed: false,
};

function Navigation() {
  const navigate = useNavigate();
  return (
    <nav>
      <button onClick={() => navigate('/owner')}>Home</button>
      <button onClick={() => navigate('/owner/alerts')}>Alerts</button>
      <button onClick={() => navigate('/owner/insights')}>Insights</button>
    </nav>
  );
}

describe('Owner list data normalization across navigation', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
  });

  it('shares only normalized list values between Home, Alerts, and Insights and ignores legacy envelope caches', async () => {
    apiFetchMock.mockImplementation(async (url) => {
      if (url === '/alerts?status=open') return { success: true, data: [alert] };
      if (url === '/insights') return { success: true, data: [insight] };
      if (url === '/health-score') return { overallScore: null };
      throw new Error(`Unexpected request: ${url}`);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['alerts', 'open'], { success: true, data: { alerts: [alert] } });
    queryClient.setQueryData(['insights'], { success: true, data: [insight] });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/owner']}>
          <Navigation />
          <Routes>
            <Route path="/owner" element={<OwnerHome />} />
            <Route path="/owner/alerts" element={<OwnerAlerts />} />
            <Route path="/owner/insights" element={<OwnerInsights />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Low stock')).toBeInTheDocument();
    expect(await screen.findByText('Sales increased today.')).toBeInTheDocument();
    await waitFor(() => {
      expect(queryClient.getQueryData(ownerAlertQueryKey())).toEqual([alert]);
      expect(queryClient.getQueryData(ownerInsightsQueryKey)).toEqual([insight]);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    expect(await screen.findByText('Low stock')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    expect(await screen.findByText('Sales increased today.')).toBeInTheDocument();

    expect(queryClient.getQueryData(ownerAlertQueryKey())).toEqual([alert]);
    expect(queryClient.getQueryData(ownerInsightsQueryKey)).toEqual([insight]);
    queryClient.clear();
  });
});
