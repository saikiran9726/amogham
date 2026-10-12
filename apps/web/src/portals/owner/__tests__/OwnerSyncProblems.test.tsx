import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiFetch } from '../../../stores/useAuthStore.js';
import { OwnerSyncProblems } from '../OwnerSyncProblems.js';

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

describe('OwnerSyncProblems', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
  });

  it('renders every dead-letter record from the API success/data response envelope', async () => {
    apiFetchMock.mockImplementation(async (url) => {
      if (url === '/sync/dead-letter') {
        return {
          success: true,
          data: [
            {
              id: 'dead-letter-active',
              restaurantId: 'restaurant-1',
              commandId: 'command-1',
              idempotencyKey: 'key-1',
              deviceId: 'offline-register',
              type: 'order.create',
              payload: { orderId: 'order-1' },
              errorMessage: 'Orphan order command',
              attempts: 5,
              status: 'dead_letter',
              discardReason: null,
              discardedBy: null,
              createdAt: '2026-10-11T00:00:00.000Z',
              updatedAt: '2026-10-11T00:00:00.000Z',
            },
            {
              id: 'dead-letter-discarded',
              restaurantId: 'restaurant-1',
              commandId: 'command-2',
              idempotencyKey: 'key-2',
              deviceId: 'tablet-2',
              type: 'payment.record',
              payload: { paymentId: 'payment-2' },
              errorMessage: 'Previously discarded command',
              attempts: 3,
              status: 'discarded',
              discardReason: 'No longer applicable',
              discardedBy: 'owner-1',
              createdAt: '2026-10-10T00:00:00.000Z',
              updatedAt: '2026-10-10T00:00:00.000Z',
            },
          ],
        };
      }

      return { success: true, data: [] };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <OwnerSyncProblems />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Error: Orphan order command')).toBeInTheDocument();
    expect(screen.getByText('Error: Previously discarded command')).toBeInTheDocument();
    expect(screen.getByText('Device: offline-register')).toBeInTheDocument();
    expect(screen.getByText('Device: tablet-2')).toBeInTheDocument();

    queryClient.clear();
  });

  it('shows Retry for a malformed list envelope instead of iterating it', async () => {
    apiFetchMock.mockImplementation(async (url) =>
      url === '/sync/dead-letter'
        ? { success: true, data: { commands: [] } }
        : { success: true, data: [] },
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <OwnerSyncProblems />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid API response from /sync/dead-letter.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    queryClient.clear();
  });
});
