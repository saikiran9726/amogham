import { act, renderHook, waitFor } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, notifyWaiterKotReady } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  notifyWaiterKotReady: vi.fn(),
}));

vi.mock('../../../stores/useAuthStore.js', () => ({ apiFetch }));
vi.mock('../../../stores/useSocketStore.js', () => ({ notifyWaiterKotReady }));

import { useWaiterKitchenFeed } from '../useWaiterKitchenFeed.js';

const preparing = {
  activeKots: [
    {
      id: 'kot-1',
      orderId: 'order-1',
      tableLabel: 'T-1',
      kotNumber: 7,
      type: 'new',
      status: 'preparing',
      createdAt: '2026-10-11T10:00:00.000Z',
      items: [],
    },
  ],
};

describe('waiter kitchen feed ready notification fallback', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    queryClient?.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    apiFetch.mockReset();
    notifyWaiterKotReady.mockReset();
  });

  it('notifies from a polled ready transition when the socket event is unavailable', async () => {
    apiFetch.mockResolvedValueOnce(preparing).mockResolvedValueOnce({
      activeKots: [{ ...preparing.activeKots[0], status: 'ready' }],
    });

    const { result } = renderHook(() => useWaiterKitchenFeed(), { wrapper });
    await waitFor(() => expect(result.current.data?.activeKots[0]?.status).toBe('preparing'));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() =>
      expect(notifyWaiterKotReady).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'kot-1', status: 'ready', tableLabel: 'T-1' }),
      ),
    );
    expect(apiFetch).toHaveBeenCalledWith('/kitchen/state');
  });

  it('refreshes the feed when returning to a backgrounded waiter tab', async () => {
    focusManager.setFocused(false);
    apiFetch.mockResolvedValueOnce({ activeKots: [] }).mockResolvedValueOnce({
      activeKots: [
        {
          id: 'kot-takeaway',
          orderId: 'takeaway-order',
          tableLabel: null,
          kotNumber: 10,
          type: 'new',
          status: 'ready',
          createdAt: '2026-10-11T10:00:00.000Z',
          items: [
            {
              id: 'kot-item-a',
              orderItemId: 'order-item-a',
              name: 'Dosa',
              qty: 1,
              action: 'add',
              status: 'done',
            },
          ],
        },
      ],
    });

    const { result } = renderHook(() => useWaiterKitchenFeed(), { wrapper });
    await waitFor(() => expect(result.current.data?.activeKots).toEqual([]));

    await act(async () => {
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(result.current.data?.activeKots[0]?.kotNumber).toBe(10));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(notifyWaiterKotReady).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kot-takeaway', status: 'ready' }),
    );
  });

  it('validates malformed kitchen responses instead of allowing unchecked array use', async () => {
    apiFetch.mockResolvedValue({ activeKots: { status: 'ready' } });
    const { result } = renderHook(() => useWaiterKitchenFeed(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(notifyWaiterKotReady).not.toHaveBeenCalled();
  });
});
