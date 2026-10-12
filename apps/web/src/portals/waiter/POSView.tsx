import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../stores/useAuthStore.js';
import { localDb } from '../../db/dexie.js';
import { useCartStore } from '../../stores/useCartStore.js';
import { useToastStore } from '../../stores/useToastStore.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';
import { VegMark } from '../../components/ui/VegMark.js';
import { QtyStepper } from '../../components/ui/QtyStepper.js';
import { Button } from '../../components/ui/Button.js';
import { CartSheet } from './CartSheet.js';
import { KotHistorySheet } from '../../components/KotHistorySheet.js';
import { BillPreviewSheet } from './BillPreviewSheet.js';
import { CustomerChip } from '../../components/CustomerChip.js';
import {
  formatPaiseToRupeeString,
  type FrequentItemOutput,
  type RecentOrderOutput,
} from '@restaurant-os/shared';
import {
  Search,
  Sparkles,
  ShoppingBag,
  ArrowLeft,
  ArrowRight,
  Layers,
  SlidersHorizontal,
} from 'lucide-react';

interface ModifierOption {
  id: string;
  name: string;
  priceDeltaPaise: number;
}

interface ModifierGroup {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  modifiers: ModifierOption[];
}

interface MenuItemData {
  id: string;
  categoryId: string;
  name: string;
  aliases: string[];
  isVeg: boolean;
  pricePaise: number;
  taxRateBp: number;
  available: boolean;
  modifierGroups?: ModifierGroup[];
}

interface CategoryData {
  id: string;
  name: string;
  sortOrder: number;
}

interface POSViewProps {
  onBackToTables: () => void;
}

export const POSView: React.FC<POSViewProps> = ({ onBackToTables }) => {
  const {
    items: cartItems,
    tableLabel,
    type,
    isPersisted,
    guests,
    addItem,
    updateItemQty,
    repeatOrder,
    getTotals,
    taxMode,
    isTaxModeLoading,
    taxModeError,
    loadTaxMode,
  } = useCartStore();

  const [dietFilter, setDietFilter] = useState<'ALL' | 'VEG' | 'NON-VEG'>(() => {
    const saved = localStorage.getItem('waiter_pos_diet_filter');
    return saved === 'VEG' || saved === 'NON-VEG' ? saved : 'ALL';
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [isCartSheetOpen, setIsCartSheetOpen] = useState(false);
  const [isKotHistoryOpen, setIsKotHistoryOpen] = useState(false);
  const [isBillPreviewOpen, setIsBillPreviewOpen] = useState(false);
  const [activeModItem, setActiveModItem] = useState<MenuItemData | null>(null);
  const [selectedMods, setSelectedMods] = useState<ModifierOption[]>([]);
  const [quickPickTab, setQuickPickTab] = useState<'frequent' | 'popular' | 'recent'>('frequent');

  // 120ms debounce for search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery.trim());
    }, 120);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Save diet filter choice
  const handleDietChange = (val: string) => {
    setDietFilter(val as 'ALL' | 'VEG' | 'NON-VEG');
    localStorage.setItem('waiter_pos_diet_filter', val);
  };

  // Queries
  const { data: menuData, isLoading: isMenuLoading } = useQuery<{
    categories: CategoryData[];
    items: MenuItemData[];
  }>({
    queryKey: ['waiter-menu'],
    queryFn: async () => {
      try {
        const res = await apiFetch<{ categories: CategoryData[]; items: MenuItemData[] }>('/menu');
        // Cache to dexie
        if (res.categories) await localDb.categories.bulkPut(res.categories);
        if (res.items) await localDb.menu.bulkPut(res.items);
        return res;
      } catch {
        // Fallback to local Dexie
        const cachedCategories = await localDb.categories.toArray();
        const cachedItems = await localDb.menu.toArray();
        return {
          categories: cachedCategories as unknown as CategoryData[],
          items: cachedItems as unknown as MenuItemData[],
        };
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: frequentItems = [] } = useQuery<FrequentItemOutput[]>({
    queryKey: ['frequent-items'],
    queryFn: () => apiFetch('/menu/frequent'),
    staleTime: 60 * 1000,
  });

  const { data: popularToday = [] } = useQuery<FrequentItemOutput[]>({
    queryKey: ['popular-today'],
    queryFn: () => apiFetch('/menu/popular-today'),
    staleTime: 60 * 1000,
  });

  const { data: recentOrders = [] } = useQuery<RecentOrderOutput[]>({
    queryKey: ['recent-orders'],
    queryFn: () => apiFetch('/orders/recent'),
    staleTime: 30 * 1000,
  });

  const categories = menuData?.categories || [];
  const allItems = menuData?.items || [];

  // Client-side instant filter: Diet + Category + Search query
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      // Diet filter
      if (dietFilter === 'VEG' && !item.isVeg) return false;
      if (dietFilter === 'NON-VEG' && item.isVeg) return false;

      // Category filter
      if (selectedCategory !== 'ALL' && item.categoryId !== selectedCategory) return false;

      // Search query (names & aliases)
      if (debouncedQuery) {
        const q = debouncedQuery.toLowerCase();
        const nameMatch = item.name.toLowerCase().includes(q);
        const aliasMatch = (item.aliases || []).some((a) => a.toLowerCase().includes(q));
        if (!nameMatch && !aliasMatch) return false;
      }

      return true;
    });
  }, [allItems, dietFilter, selectedCategory, debouncedQuery]);

  // Compute item count map in cart for quick QtyStepper rendering
  const itemQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cartItems) {
      map.set(c.itemId, (map.get(c.itemId) || 0) + c.qty);
    }
    return map;
  }, [cartItems]);

  const totals = getTotals();
  const totalCartQty = cartItems.reduce((sum, i) => sum + i.qty, 0);

  useEffect(() => {
    if (taxMode === null && !isTaxModeLoading && !taxModeError) {
      void loadTaxMode();
    }
  }, [taxMode, isTaxModeLoading, taxModeError, loadTaxMode]);

  const totalLabel = totals
    ? formatPaiseToRupeeString(totals.totalPaise)
    : taxModeError
      ? 'Unavailable'
      : 'Loading tax settings…';

  const quickItems = useMemo(() => {
    if (quickPickTab === 'recent') return [];
    const source = quickPickTab === 'frequent' ? frequentItems : popularToday;
    return source.flatMap((entry) => {
      const current = allItems.find((item) => item.id === entry.itemId);
      return current?.available ? [current] : [];
    });
  }, [quickPickTab, frequentItems, popularToday, allItems]);

  const handleRepeatOrder = async (order: RecentOrderOutput) => {
    let currentMenuItems: MenuItemData[];
    try {
      const currentMenu = await apiFetch<{ items: MenuItemData[] }>('/menu');
      currentMenuItems = currentMenu.items || [];
    } catch {
      useToastStore.getState().addToast({
        type: 'warning',
        message: 'Reconnect to verify current prices and options before reordering.',
      });
      return;
    }

    const currentItems = order.items.flatMap((line) => {
      const item = currentMenuItems.find((candidate) => candidate.id === line.itemId);
      if (!item?.available) {
        return [{ ...line, available: false, isVeg: false, taxRateBp: 0 }];
      }

      const modifiers: ModifierOption[] = [];
      for (const oldModifier of line.modifiers || []) {
        const match = item.modifierGroups
          ?.flatMap((group) => group.modifiers)
          .find((option) => option.id === oldModifier.id || option.name === oldModifier.name);
        if (!match || match.priceDeltaPaise !== oldModifier.priceDeltaPaise) {
          return [{ ...line, available: false, isVeg: item.isVeg, taxRateBp: item.taxRateBp }];
        }
        modifiers.push(match);
      }
      const selectedIds = new Set(modifiers.map((modifier) => modifier.id));
      const validOptions =
        item.modifierGroups?.every((group) => {
          const count = group.modifiers.filter((modifier) => selectedIds.has(modifier.id)).length;
          return count >= group.minSelections && count <= group.maxSelections;
        }) ?? modifiers.length === 0;
      if (!validOptions) {
        return [{ ...line, available: false, isVeg: item.isVeg, taxRateBp: item.taxRateBp }];
      }

      return [
        {
          itemId: item.id,
          name: item.name,
          qty: line.qty,
          available: true,
          isVeg: item.isVeg,
          pricePaise: item.pricePaise,
          taxRateBp: item.taxRateBp,
          modifiers,
        },
      ];
    });
    repeatOrder({ items: currentItems });
  };

  const handleItemClick = (item: MenuItemData) => {
    if (item.modifierGroups && item.modifierGroups.length > 0) {
      setActiveModItem(item);
      setSelectedMods([]);
      return;
    }
    addItem({
      itemId: item.id,
      name: item.name,
      isVeg: item.isVeg,
      pricePaise: item.pricePaise,
      taxRateBp: item.taxRateBp,
    });
  };

  const handleConfirmModifiers = () => {
    if (!activeModItem) return;
    addItem({
      itemId: activeModItem.id,
      name: activeModItem.name,
      isVeg: activeModItem.isVeg,
      pricePaise: activeModItem.pricePaise,
      taxRateBp: activeModItem.taxRateBp,
      modifiers: selectedMods,
    });
    setActiveModItem(null);
    setSelectedMods([]);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      {taxModeError ? (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-content-primary"
        >
          <span>{taxModeError}</span>
          <Button variant="secondary" size="sm" onClick={() => void loadTaxMode()}>
            Retry
          </Button>
        </div>
      ) : taxMode === null ? (
        <div
          role="status"
          className="mb-2 rounded-xl border border-surface-border bg-surface-card p-3 text-sm text-content-secondary"
        >
          Loading tax settings… Order totals and actions will be available when settings load.
        </div>
      ) : null}

      {/* Order context */}
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3 rounded-2xl bg-[#062A22] px-4 py-3 text-white shadow-sm sm:px-5">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBackToTables}
            className="h-10 shrink-0 border border-white/15 px-3 text-white hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            <span>Tables</span>
          </Button>

          <div className="min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-white/60">
              Amogham · {isPersisted ? 'Order in progress' : 'New order'}
            </span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="truncate text-lg font-bold leading-tight sm:text-xl">
                {type === 'dine_in' ? `Table ${tableLabel || '—'}` : 'Takeaway'}
              </h2>
              {type === 'dine_in' && (
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/80">
                  {guests} guests
                </span>
              )}
              <CustomerChip tone="inverse" />
            </div>
          </div>
        </div>

        <Button
          variant="primary"
          size="md"
          onClick={() => setIsCartSheetOpen(true)}
          aria-label={`Open order, ${totalCartQty} items${totalCartQty > 0 ? `, ${totalLabel}` : ''}`}
          className="relative flex shrink-0 items-center gap-2 border border-brand-gold/70 bg-brand-gold px-3 text-accent-foreground hover:bg-[#d5b15f] sm:px-4"
        >
          <ShoppingBag className="w-4 h-4" />
          <span className="hidden sm:inline">Order</span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-bold">
            {totalCartQty}
          </span>
          {totalCartQty > 0 && <span className="hidden font-semibold sm:inline">{totalLabel}</span>}
        </Button>
      </div>

      {/* Search and dietary filters */}
      <div className="mb-4 flex shrink-0 flex-col gap-3 rounded-2xl border border-surface-border bg-surface-card p-3 shadow-sm sm:flex-row sm:items-center sm:p-3.5">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted" />
          <input
            type="text"
            placeholder="Search by dish name or alias"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 w-full rounded-xl border border-transparent bg-surface-canvas/70 pl-10 pr-12 text-body text-content-primary placeholder:text-content-muted focus:border-accent/30 focus:bg-surface-card focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-1 text-xs font-semibold text-content-muted hover:text-content-primary"
            >
              Clear
            </button>
          )}
        </div>

        {/* ALL / VEG / NON-VEG Segmented Control */}
        <SegmentedControl
          value={dietFilter}
          onChange={handleDietChange}
          options={[
            { value: 'ALL', label: 'ALL' },
            { value: 'VEG', label: 'VEG' },
            { value: 'NON-VEG', label: 'NON-VEG' },
          ]}
          size="md"
        />
      </div>

      {/* Menu and order panel */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden xl:gap-5">
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto pr-1 pb-4">
          {!debouncedQuery && (
            <section
              aria-label="Quick picks"
              className="space-y-3 rounded-2xl border border-brand-gold/50 bg-surface-card p-3.5 sm:p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-bold text-content-primary">
                    <Sparkles className="h-4 w-4 text-brand-gold" /> Quick picks
                  </h3>
                  <p className="mt-0.5 text-xs text-content-secondary">
                    Based on your restaurant’s order history
                  </p>
                </div>
                <div
                  role="tablist"
                  aria-label="Quick pick type"
                  className="flex rounded-xl border border-surface-border/70 bg-surface-canvas/70 p-1"
                >
                  {(
                    [
                      ['frequent', 'Frequent'],
                      ['popular', 'Popular'],
                      ['recent', 'Recent'],
                    ] as const
                  ).map(([tab, label]) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={quickPickTab === tab}
                      onClick={() => setQuickPickTab(tab)}
                      className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors duration-press ease-out ${quickPickTab === tab ? 'bg-accent text-white shadow-sm' : 'text-content-secondary hover:bg-surface-canvas hover:text-content-primary'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {quickPickTab === 'recent' ? (
                recentOrders.length ? (
                  <div className="flex gap-2.5 overflow-x-auto pb-1">
                    {recentOrders.slice(0, 5).map((order) => (
                      <div
                        key={order.id}
                        className="flex min-w-[230px] max-w-[290px] shrink-0 items-center justify-between gap-3 rounded-xl border border-surface-border bg-surface-card p-3"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-content-primary">
                            {order.tableLabel ? `T-${order.tableLabel}` : 'Takeaway'}
                          </p>
                          <p className="truncate text-xs text-content-secondary">
                            {order.itemSummary}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleRepeatOrder(order)}
                          className="shrink-0 text-xs"
                        >
                          Add to cart
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-content-muted">No recent orders yet.</p>
                )
              ) : quickItems.length ? (
                <div className="flex gap-2.5 overflow-x-auto pb-1">
                  {quickItems.slice(0, 8).map((item) => {
                    const currentQty = itemQtyMap.get(item.id) || 0;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="flex min-w-[165px] shrink-0 items-center gap-2.5 rounded-xl border border-surface-border/80 bg-surface-card px-3 py-2.5 text-left transition-[border-color,box-shadow] duration-press ease-out hover:border-brand-gold hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <VegMark type={item.isVeg ? 'veg' : 'nonveg'} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-bold text-content-primary">
                            {item.name}
                          </span>
                          <span className="text-xs text-content-secondary">
                            {formatPaiseToRupeeString(item.pricePaise)}
                          </span>
                        </span>
                        {currentQty > 0 && (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-accent-foreground">
                            {currentQty}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-content-muted">
                  No {quickPickTab === 'frequent' ? 'frequent' : 'popular'} items available right
                  now.
                </p>
              )}
            </section>
          )}

          <div className="flex items-end justify-between gap-3 pt-1">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-content-primary">Full menu</h3>
              <p className="text-xs text-content-muted">
                {filteredItems.length} dishes in this view
              </p>
            </div>
          </div>

          {/* Category navigation */}
          <div
            aria-label="Menu categories"
            className="sticky top-0 z-10 -mx-1 flex gap-2 overflow-x-auto bg-surface-canvas/95 px-1 py-2 backdrop-blur-sm"
          >
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition-colors duration-press ease-out ${
                selectedCategory === 'ALL'
                  ? 'bg-accent text-accent-foreground'
                  : 'border border-surface-border bg-surface-card/80 text-content-secondary hover:border-brand-gold hover:text-content-primary'
              }`}
            >
              All Items ({allItems.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition-colors duration-press ease-out ${
                  selectedCategory === cat.id
                    ? 'bg-accent text-accent-foreground'
                    : 'border border-surface-border bg-surface-card/80 text-content-secondary hover:border-brand-gold hover:text-content-primary'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {/* Menu Items Grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {filteredItems.length === 0 && (
              <div className="col-span-full flex flex-col items-center rounded-2xl border border-dashed border-surface-border bg-surface-card/70 px-6 py-12 text-center">
                <Search className="mb-3 h-6 w-6 text-brand-gold" />
                <p className="font-semibold text-content-primary">No dishes in this view</p>
                <p className="mt-1 text-sm text-content-secondary">
                  Try another search or clear your filters.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4 rounded-full"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('ALL');
                    handleDietChange('ALL');
                  }}
                >
                  Clear search and filters
                </Button>
              </div>
            )}
            {filteredItems.map((item) => {
              const currentQty = itemQtyMap.get(item.id) || 0;
              const hasModifiers = item.modifierGroups && item.modifierGroups.length > 0;

              return (
                <div
                  key={item.id}
                  onClick={() => !currentQty && item.available && handleItemClick(item)}
                  className={`flex min-h-[142px] flex-col justify-between rounded-2xl border bg-surface-card p-4 shadow-[0_1px_3px_rgba(20,38,31,0.04)] select-none ${
                    !item.available
                      ? 'cursor-not-allowed border-dashed border-surface-border opacity-60'
                      : !currentQty
                        ? 'cursor-pointer border-surface-border transition-[border-color,box-shadow] duration-press ease-out hover:border-brand-gold/70 hover:shadow-[0_6px_18px_rgba(20,38,31,0.07)]'
                        : 'border-brand-gold/70'
                  }`}
                >
                  <div>
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <VegMark type={item.isVeg ? 'veg' : 'nonveg'} size="sm" />
                        <h4 className="line-clamp-2 font-semibold leading-snug text-content-primary">
                          {item.name}
                        </h4>
                      </div>
                      {!item.available ? (
                        <span className="shrink-0 rounded-full bg-red-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-red-700">
                          Out of stock
                        </span>
                      ) : hasModifiers ? (
                        <span className="shrink-0 rounded-full bg-[#f6f0e3] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-content-secondary">
                          Options
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-surface-border/70 pt-3">
                    <span className="font-bold text-body text-content-primary">
                      {formatPaiseToRupeeString(item.pricePaise)}
                    </span>

                    {!item.available ? (
                      <span className="text-xs font-medium text-red-700">Unavailable today</span>
                    ) : currentQty > 0 ? (
                      <QtyStepper
                        value={currentQty}
                        onChange={(qty) => updateItemQty(item.id, qty)}
                        size="sm"
                        ariaLabel={`Quantity for ${item.name}`}
                      />
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemClick(item);
                        }}
                      >
                        Add
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right pane: Persistent Desktop/Tablet Cart Column */}
        <div className="hidden h-full w-80 flex-col rounded-2xl border border-surface-border bg-surface-card p-4 shadow-[0_2px_12px_rgba(20,38,31,0.05)] lg:flex xl:w-[22rem]">
          <div className="flex items-start justify-between gap-2 border-b border-surface-border pb-3">
            <div>
              <span className="block font-bold text-content-primary">Your order</span>
              <span className="text-xs text-content-muted">Review before sending to kitchen</span>
            </div>
            <span className="rounded-full bg-[#f6f0e3] px-2.5 py-1 text-xs font-semibold text-content-secondary">
              {totalCartQty}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto py-3 space-y-2 pr-1">
            {cartItems.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-surface-border bg-surface-canvas/50 px-5 text-center text-content-muted">
                <ShoppingBag className="mb-3 h-7 w-7 text-brand-gold" />
                <p className="font-semibold text-content-primary">Start with a dish</p>
                <p className="mt-1 text-xs">Your selections will appear here.</p>
              </div>
            ) : (
              cartItems.map((line) => (
                <div
                  key={line.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-surface-border/80 bg-surface-card p-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          line.isVeg ? 'bg-emerald-500' : 'bg-red-500'
                        }`}
                      />
                      <p className="truncate text-sm font-semibold text-content-primary">
                        {line.name}
                      </p>
                    </div>
                    {line.modifiers.length > 0 && (
                      <p className="text-[10px] text-content-muted truncate">
                        {line.modifiers.map((m) => m.name).join(', ')}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <QtyStepper
                      value={line.qty}
                      onChange={(qty) => updateItemQty(line.itemId, qty, line.modifiers)}
                      size="sm"
                    />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2 border-t border-surface-border pt-3">
            <div className="flex justify-between text-caption text-content-secondary">
              <span>Subtotal</span>
              <span>{totals ? formatPaiseToRupeeString(totals.subtotalPaise) : '—'}</span>
            </div>
            <div className="flex justify-between text-caption text-content-secondary">
              <span>Taxes</span>
              <span>{totals ? formatPaiseToRupeeString(totals.taxPaise) : '—'}</span>
            </div>
            <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-content-primary">
              <span>Total</span>
              <span>{totalLabel}</span>
            </div>

            <Button
              variant="primary"
              size="lg"
              className="mt-2 w-full rounded-xl"
              disabled={cartItems.length === 0 || !totals}
              onClick={() => setIsCartSheetOpen(true)}
            >
              Review & Save Order
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Sticky Cart Bar */}
      {totalCartQty > 0 && (
        <div className="lg:hidden fixed bottom-16 inset-x-0 p-3 bg-surface-card/95 backdrop-blur-md border-t border-surface-border z-20 shadow-xl">
          <div className="flex items-center justify-between max-w-md mx-auto">
            <div>
              <span className="text-xs text-content-muted block">{totalCartQty} items added</span>
              <span className="font-extrabold text-title text-content-primary">{totalLabel}</span>
            </div>

            <Button
              variant="primary"
              size="md"
              className="flex items-center gap-2 font-bold px-5"
              onClick={() => setIsCartSheetOpen(true)}
            >
              <span>View Cart</span>
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Cart Sheet */}
      <CartSheet
        isOpen={isCartSheetOpen}
        onClose={() => setIsCartSheetOpen(false)}
        onOpenKotHistory={() => {
          setIsCartSheetOpen(false);
          setIsKotHistoryOpen(true);
        }}
        onOpenBillPreview={() => {
          setIsCartSheetOpen(false);
          setIsBillPreviewOpen(true);
        }}
        onOrderSaved={() => {
          setIsCartSheetOpen(false);
          onBackToTables();
        }}
      />

      {/* Bill Preview & Settlement Sheet */}
      <BillPreviewSheet
        isOpen={isBillPreviewOpen}
        orderId={useCartStore.getState().orderId}
        tableLabel={tableLabel || undefined}
        onClose={() => setIsBillPreviewOpen(false)}
        onOrderSettled={() => {
          setIsBillPreviewOpen(false);
          onBackToTables();
        }}
      />

      {/* KOT History Sheet */}
      <KotHistorySheet
        isOpen={isKotHistoryOpen}
        orderId={useCartStore.getState().orderId}
        tableLabel={tableLabel || undefined}
        onClose={() => setIsKotHistoryOpen(false)}
      />

      {/* Modifier Selection Modal / Dialog */}
      {activeModItem && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-surface-card border border-surface-border rounded-2xl p-6 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-surface-border pb-3">
              <div>
                <h3 className="font-bold text-title text-content-primary">{activeModItem.name}</h3>
                <span className="text-caption text-content-muted">Choose your options</span>
              </div>
              <button
                onClick={() => setActiveModItem(null)}
                className="text-content-muted hover:text-content-primary font-bold p-1"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 max-h-60 overflow-y-auto pr-1">
              {activeModItem.modifierGroups?.map((group) => (
                <div key={group.id} className="space-y-2">
                  <span className="text-caption font-bold text-content-secondary uppercase block">
                    {group.name}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {group.modifiers.map((mod) => {
                      const isSelected = selectedMods.some((m) => m.id === mod.id);
                      return (
                        <button
                          key={mod.id}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setSelectedMods((prev) => prev.filter((m) => m.id !== mod.id));
                            } else {
                              setSelectedMods((prev) => [...prev, mod]);
                            }
                          }}
                          className={`p-2.5 rounded-xl border text-left font-medium text-caption transition-colors duration-press ${
                            isSelected
                              ? 'bg-accent/15 border-accent text-accent font-bold'
                              : 'bg-surface-elevated border-surface-border text-content-primary hover:border-surface-border-strong'
                          }`}
                        >
                          <div>{mod.name}</div>
                          {mod.priceDeltaPaise > 0 && (
                            <div className="text-xs text-content-muted">
                              +{formatPaiseToRupeeString(mod.priceDeltaPaise)}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-3 border-t border-surface-border flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setActiveModItem(null)}>
                Cancel
              </Button>
              <Button variant="primary" className="flex-1" onClick={handleConfirmModifiers}>
                Add to Cart
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
