import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { apiFetch } from '../../../stores/useAuthStore.js';
import { OwnerAlerts } from '../OwnerAlerts.js';

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
  payload: {
    title: 'Low stock',
    whatIsWrong: 'An item is below its reorder level.',
    whyItMatters: 'It may run out soon.',
  },
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

function renderOwnerAlerts(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/owner/alerts']}>
        <OwnerAlerts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('OwnerAlerts response contract', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
  });

  it('reads the API success/data envelope instead of treating the envelope as the list', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: [alert] });
    const queryClient = renderOwnerAlerts();

    expect(await screen.findByText('Low stock')).toBeInTheDocument();
    expect(screen.getByText(/An item is below its reorder level/)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/alerts?status=open');

    queryClient.clear();
  });

  it('does not reuse the raw envelope cached by the dashboard under the legacy alerts key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // OwnerHome and OwnerLayout previously cached this exact response shape at ['alerts', 'open'].
    queryClient.setQueryData(['alerts', 'open'], { success: true, data: [alert] });
    apiFetchMock.mockResolvedValue({ success: true, data: [] });

    renderOwnerAlerts(queryClient);

    expect(await screen.findByText(/All Clear — No Operational Gaps Detected/)).toBeInTheDocument();
    expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/alerts?status=open');
    queryClient.clear();
  });

  it('shows Retry for a malformed value found under its current cache key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['owner-alerts', 'open'], { success: true, data: [alert] });
    apiFetchMock.mockReturnValue(new Promise(() => {}));

    renderOwnerAlerts(queryClient);

    expect(await screen.findByRole('alert')).toHaveTextContent('cached alerts data was invalid');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });

  it('shows the all-clear state for an empty alerts envelope', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: [] });
    const queryClient = renderOwnerAlerts();

    expect(await screen.findByText(/All Clear — No Operational Gaps Detected/)).toBeInTheDocument();
    queryClient.clear();
  });

  it('shows API errors instead of rendering them as an empty alert list', async () => {
    apiFetchMock.mockRejectedValue(new Error('Alerts service unavailable'));
    const queryClient = renderOwnerAlerts();

    expect(await screen.findByRole('alert')).toHaveTextContent('Alerts service unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });

  it('rejects a malformed API envelope with a retryable error', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: { alerts: [alert] } });
    const queryClient = renderOwnerAlerts();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid API response from /alerts.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });

  it('reports a loading state while the alerts request is pending', () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    const queryClient = renderOwnerAlerts();

    expect(screen.getByText('Loading alerts...')).toBeInTheDocument();
    queryClient.clear();
  });
});
