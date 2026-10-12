import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../stores/useAuthStore.js';
import { notifyWaiterKotReady } from '../../stores/useSocketStore.js';
import type { KitchenKot } from '../../stores/useKitchenStore.js';

export const waiterKitchenFeedKey = ['waiter-active-kots'] as const;

export interface WaiterKitchenState {
  activeKots: KitchenKot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKitchenKot(value: unknown): value is KitchenKot {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (
    typeof value.id !== 'string' ||
    typeof value.orderId !== 'string' ||
    typeof value.kotNumber !== 'number' ||
    typeof value.createdAt !== 'string' ||
    !['new', 'additional', 'modified'].includes(String(value.type)) ||
    !['new', 'preparing', 'ready'].includes(String(value.status)) ||
    (value.tableLabel !== undefined &&
      value.tableLabel !== null &&
      typeof value.tableLabel !== 'string')
  ) {
    return false;
  }

  return value.items.every((item) => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === 'string' &&
      typeof item.orderItemId === 'string' &&
      typeof item.name === 'string' &&
      typeof item.qty === 'number' &&
      ['add', 'cancel', 'update'].includes(String(item.action)) &&
      ['pending', 'done', 'cancelled'].includes(String(item.status))
    );
  });
}

function parseKitchenState(value: unknown): WaiterKitchenState | null {
  if (!isRecord(value) || !Array.isArray(value.activeKots)) return null;
  const activeKots: KitchenKot[] = [];
  for (const candidate of value.activeKots) {
    if (!isKitchenKot(candidate)) return null;
    activeKots.push(candidate);
  }
  return { activeKots };
}

/** Shared query powers Active Orders and keeps ready notifications alive across waiter routes. */
export function useWaiterKitchenFeed() {
  const previousStatuses = useRef<Map<string, string> | null>(null);
  const query = useQuery({
    queryKey: waiterKitchenFeedKey,
    queryFn: async () => {
      const response = await apiFetch<unknown>('/kitchen/state');
      const parsed = parseKitchenState(response);
      if (!parsed) {
        throw new Error('Kitchen order response has an unexpected shape.');
      }
      return parsed;
    },
    retry: false,
    staleTime: 10_000,
    refetchOnMount: 'always',
    // The app disables window-focus refetch globally. Force a fresh feed when
    // a waiter returns to a backgrounded tab, where interval polling pauses.
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (!query.data) return;

    const previous = previousStatuses.current;
    for (const kot of query.data.activeKots) {
      // On the first result, surface already-ready KOTs too; this covers a
      // waiter who opened the portal while disconnected from Socket.IO.
      if (kot.status === 'ready' && (!previous || previous.get(kot.id) !== 'ready')) {
        notifyWaiterKotReady(kot);
      }
    }
    previousStatuses.current = new Map(query.data.activeKots.map((kot) => [kot.id, kot.status]));
  }, [query.data]);

  return query;
}
