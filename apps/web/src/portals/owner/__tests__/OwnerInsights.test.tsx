import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { apiFetch } from '../../../stores/useAuthStore.js';
import { OwnerInsights } from '../OwnerInsights.js';

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../stores/useToastStore.js', () => ({
  useToastStore: () => ({ addToast: vi.fn() }),
}));

const apiFetchMock = vi.mocked(apiFetch);
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

function renderPage(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OwnerInsights />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('OwnerInsights response contract', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
  });

  it('normalizes a populated success/data response before rendering', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: [insight] });
    const queryClient = renderPage();
    expect(await screen.findByText('Sales increased today.')).toBeInTheDocument();
    expect(queryClient.getQueryData(['owner-insights'])).toEqual([insight]);
    queryClient.clear();
  });

  it('shows the legitimate empty state for an empty list', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: [] });
    const queryClient = renderPage();
    expect(
      await screen.findByText(/No business insights to display right now/),
    ).toBeInTheDocument();
    queryClient.clear();
  });

  it('shows a retryable error for malformed API data', async () => {
    apiFetchMock.mockResolvedValue({ success: true, data: { insights: [insight] } });
    const queryClient = renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid API response from /insights.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });

  it('does not render a legacy raw envelope found in the old insights cache key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['insights'], { success: true, data: [insight] });
    apiFetchMock.mockResolvedValue({ success: true, data: [] });
    renderPage(queryClient);
    expect(
      await screen.findByText(/No business insights to display right now/),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(['owner-insights'])).toEqual([]);
    queryClient.clear();
  });

  it('shows Retry when the active insight cache contains a non-list value', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['owner-insights'], { success: true, data: [insight] });
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    renderPage(queryClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('cached insights data was invalid');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });
});
