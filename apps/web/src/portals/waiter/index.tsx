import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WaiterLayout } from './WaiterLayout.js';
import { WaiterHome } from './WaiterHome.js';
import { EmptyState, Skeleton } from '../../components/ui/UtilityComponents.js';
import { Utensils, Receipt, Bell, RefreshCw } from 'lucide-react';
import { ErrorBoundary } from '../../components/ErrorBoundary.js';
import { apiFetch } from '../../stores/useAuthStore.js';
import { Button } from '../../components/ui/Button.js';
import { recentOrderOutputSchema, type RecentOrderOutput } from '@restaurant-os/shared';
import { formatPaiseToRupeeString } from '@restaurant-os/shared';
import { BillPreviewSheet } from './BillPreviewSheet.js';
import { useSocketStore } from '../../stores/useSocketStore.js';
import { useWaiterKitchenFeed, waiterKitchenFeedKey } from './useWaiterKitchenFeed.js';

export const WaiterOrders: React.FC = () => {
  const queryClient = useQueryClient();
  const kotStatusEventVersion = useSocketStore((state) => state.kotStatusEventVersion);
  const [billOrder, setBillOrder] = React.useState<RecentOrderOutput | null>(null);
  const { data, isPending, isError, refetch, isFetching } = useWaiterKitchenFeed();

  React.useEffect(() => {
    if (kotStatusEventVersion > 0) {
      void queryClient.invalidateQueries({ queryKey: waiterKitchenFeedKey });
    }
  }, [kotStatusEventVersion, queryClient]);
  const {
    data: recentOrders,
    isPending: recentOrdersPending,
    isError: recentOrdersError,
    refetch: refetchRecentOrders,
    isFetching: isFetchingRecentOrders,
  } = useQuery({
    queryKey: ['waiter-recent-orders'],
    queryFn: async () => {
      const response = await apiFetch<unknown>('/orders/recent');
      const parsed = recentOrderOutputSchema.array().safeParse(response);
      if (!parsed.success) {
        throw new Error('Recent order history response has an unexpected shape.');
      }
      return parsed.data;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 15_000,
  });

  const completedTakeawayOrders = (recentOrders || []).filter((order) => {
    const statuses = order.kotStatuses || [];
    return (
      order.type === 'takeaway' &&
      order.status !== 'cancelled' &&
      statuses.length > 0 &&
      statuses.every((status) => status === 'served' || status === 'cancelled')
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-bold text-content-primary">Active Kitchen Orders</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh active orders"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isPending ? (
        <div aria-label="Loading active orders" className="space-y-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : isError ? (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4">
          <p className="font-semibold text-content-primary">Could not load active orders.</p>
          <p className="mt-1 text-caption text-content-secondary">
            Check the connection and try again.
          </p>
          <Button className="mt-3" size="sm" onClick={() => void refetch()} isLoading={isFetching}>
            Retry
          </Button>
        </div>
      ) : !data?.activeKots?.length ? (
        <EmptyState
          icon={<Utensils className="w-8 h-8" />}
          title="No active kitchen orders"
          description="Orders fired to kitchen will show live preparation progress here."
        />
      ) : (
        <div className="space-y-3">
          {data.activeKots.map((kot) => (
            <article
              key={kot.id}
              className="rounded-xl border border-surface-border bg-surface-card p-4 shadow-sm"
              aria-label={`KOT ${kot.kotNumber}, ${kot.status}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-bold text-content-primary">
                    {kot.tableLabel || (kot.type === 'new' ? 'Takeaway' : 'Order')} · KOT #
                    {kot.kotNumber}
                  </h3>
                  <p className="text-caption text-content-secondary">
                    Order {kot.orderId.slice(0, 8)} · {kot.type} ·{' '}
                    {new Date(kot.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <span className="rounded-full bg-surface-elevated px-3 py-1 text-xs font-bold capitalize text-content-primary">
                  {kot.status}
                </span>
              </div>
              <ul className="mt-3 divide-y divide-surface-border">
                {kot.items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                    <span className="text-content-primary">
                      <span className="font-semibold">{item.qty}×</span> {item.name}
                      {item.action !== 'add' && (
                        <span className="ml-2 text-xs capitalize text-content-muted">
                          {item.action}
                        </span>
                      )}
                      {item.noteSnapshot && (
                        <span className="block text-xs text-content-secondary">
                          {item.noteSnapshot}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs capitalize text-content-secondary">
                      {item.status}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}

      <section aria-labelledby="completed-takeaway-orders-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2
              id="completed-takeaway-orders-heading"
              className="text-title font-bold text-content-primary"
            >
              Completed Takeaway Orders
            </h2>
            <p className="text-caption text-content-secondary">
              Served takeaway orders remain available here after leaving this page.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh completed takeaway orders"
            onClick={() => void refetchRecentOrders()}
            disabled={isFetchingRecentOrders}
          >
            <RefreshCw className={`w-4 h-4 ${isFetchingRecentOrders ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        {recentOrdersPending ? (
          <div aria-label="Loading completed takeaway orders">
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : recentOrdersError ? (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4">
            <p className="font-semibold text-content-primary">
              Could not load completed takeaway orders.
            </p>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => void refetchRecentOrders()}
              isLoading={isFetchingRecentOrders}
            >
              Retry
            </Button>
          </div>
        ) : completedTakeawayOrders.length === 0 ? (
          <p className="rounded-xl border border-surface-border bg-surface-card p-4 text-caption text-content-secondary">
            No completed takeaway orders in recent history.
          </p>
        ) : (
          <div className="space-y-3">
            {completedTakeawayOrders.map((order) => (
              <article
                key={order.id}
                aria-label={`Takeaway order ${order.id.slice(0, 8)}, completed`}
                className="rounded-xl border border-surface-border bg-surface-card p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-content-primary">
                      Takeaway order #{order.id.slice(0, 8)}
                    </h3>
                    <p className="text-caption text-content-secondary">{order.itemSummary}</p>
                    <p className="mt-1 text-caption font-semibold text-content-secondary">
                      {order.status === 'billed' || order.billStatus === 'paid'
                        ? 'Paid'
                        : order.pendingPaymentPaise
                          ? `Payment pending confirmation · ${formatPaiseToRupeeString(order.pendingPaymentPaise)}`
                          : order.billStatus === 'partially_paid'
                            ? `Partially paid · ${formatPaiseToRupeeString(order.paidPaise || 0)}`
                            : order.billStatus
                              ? 'Payment due'
                              : 'Bill not created'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-surface-elevated px-3 py-1 text-xs font-bold capitalize text-content-primary">
                      {order.kotStatuses?.every((status) => status === 'served')
                        ? 'Served'
                        : 'Completed'}
                    </span>
                    <Button
                      size="sm"
                      variant={
                        order.status === 'billed' || order.billStatus === 'paid'
                          ? 'secondary'
                          : 'primary'
                      }
                      aria-label={`${order.status === 'billed' || order.billStatus === 'paid' ? 'View' : 'Open'} bill for takeaway order ${order.id.slice(0, 8)}`}
                      onClick={() => setBillOrder(order)}
                    >
                      {order.status === 'billed' || order.billStatus === 'paid'
                        ? 'View Bill'
                        : order.billStatus === 'partially_paid'
                          ? 'Continue Payment'
                          : order.pendingPaymentPaise
                            ? 'Review Payment'
                            : order.billStatus
                              ? 'Open Bill'
                              : 'Create Bill'}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <BillPreviewSheet
        isOpen={Boolean(billOrder)}
        orderId={billOrder?.id || null}
        onClose={() => {
          setBillOrder(null);
          void queryClient.invalidateQueries({ queryKey: ['waiter-recent-orders'] });
        }}
        onOrderSettled={() => {
          void queryClient.invalidateQueries({ queryKey: ['waiter-recent-orders'] });
        }}
      />
    </div>
  );
};

import { BillHistoryView } from '../../components/BillHistoryView.js';

const WaiterAlerts: React.FC = () => (
  <div className="space-y-4">
    <h2 className="text-title font-bold text-content-primary">Waiter Notifications</h2>
    <EmptyState
      icon={<Bell className="w-8 h-8" />}
      title="All clear"
      description="Kitchen ready notifications and guest call bell alerts will appear here."
    />
  </div>
);

export default function WaiterPortal(): React.JSX.Element {
  return (
    <ErrorBoundary portalName="Waiter Portal">
      <Routes>
        <Route element={<WaiterLayout />}>
          <Route index element={<WaiterHome />} />
          <Route path="orders" element={<WaiterOrders />} />
          <Route path="bill" element={<BillHistoryView />} />
          <Route path="alerts" element={<WaiterAlerts />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
