import { create } from 'zustand';
import { generateUuidV7 } from '@restaurant-os/shared';
import { localDb, type LocalOrder } from '../db/dexie.js';
import { useOutboxStore } from './useOutboxStore.js';
import { useToastStore } from './useToastStore.js';
import { apiFetch } from './useAuthStore.js';

export interface CartModifier {
  id?: string;
  name: string;
  priceDeltaPaise: number;
}

export type ItemKotState = 'unsent' | 'sent' | 'preparing' | 'ready' | 'served' | 'cancelled';

export interface CartItem {
  id: string; // unique draft line key (e.g. itemId_modifiers)
  orderItemId?: string; // database UUID for previously sent items
  itemId: string;
  name: string;
  isVeg: boolean;
  pricePaise: number;
  taxRateBp: number;
  qty: number;
  sentQty?: number; // qty previously sent to kitchen
  modifiers: CartModifier[];
  note: string;
  kotState: ItemKotState;
}

interface ApiOrderItemResponse {
  id?: string;
  itemId: string;
  nameSnapshot: string;
  pricePaiseSnapshot?: number;
  taxRateBpSnapshot?: number;
  qty: number;
  kotState?: string;
  modifiers?: CartModifier[];
  note?: string;
  notes?: string;
  status?: string;
}

interface ApiOrderResponse {
  id: string;
  tableId: string | null;
  tableLabel?: string | null;
  customerId?: string | null;
  type: 'dine_in' | 'takeaway';
  guests: number;
  specialInstructions?: string | null;
  version: number;
  items: ApiOrderItemResponse[];
}

interface CartTotals {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

interface CartState {
  orderId: string;
  isPersisted: boolean;
  tableId: string | null;
  tableLabel: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerPreferences: { tags: string[]; note: string } | null;
  type: 'dine_in' | 'takeaway';
  guests: number;
  items: CartItem[];
  specialInstructions: string;
  taxMode: 'inclusive' | 'exclusive' | null;
  isTaxModeLoading: boolean;
  taxModeError: string | null;
  isSaving: boolean;
  isSendingKot: boolean;
  version: number;

  // Actions
  initNewOrder: (opts?: {
    orderId?: string;
    tableId?: string | null;
    tableLabel?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    customerPreferences?: { tags: string[]; note: string } | null;
    type?: 'dine_in' | 'takeaway';
    guests?: number;
    items?: CartItem[];
  }) => void;
  loadOrder: (orderId: string) => Promise<boolean>;
  setTable: (tableId: string | null, tableLabel?: string | null) => void;
  setCustomer: (
    customer: {
      id: string | null;
      name?: string | null;
      phone?: string | null;
      preferences?: { tags: string[]; note: string } | null;
    } | null,
  ) => Promise<void>;
  clearCustomer: () => Promise<void>;
  setOrderType: (type: 'dine_in' | 'takeaway') => void;
  setGuests: (guests: number) => void;
  setSpecialInstructions: (instructions: string) => void;
  setTaxMode: (mode: 'inclusive' | 'exclusive') => void;
  loadTaxMode: () => Promise<boolean>;

  addItem: (item: {
    itemId: string;
    name: string;
    isVeg: boolean;
    pricePaise: number;
    taxRateBp?: number;
    modifiers?: CartModifier[];
  }) => void;
  updateItemQty: (itemId: string, qty: number, modifiers?: CartModifier[]) => void;
  updateItemNote: (lineId: string, note: string) => void;
  removeItem: (lineId: string) => void;
  clearCart: () => void;

  repeatOrder: (recentOrder: {
    items: Array<{
      itemId: string;
      name: string;
      qty: number;
      pricePaise: number;
      available: boolean;
      isVeg: boolean;
      taxRateBp: number;
      modifiers?: CartModifier[];
    }>;
  }) => void;

  saveOrder: () => Promise<string | null>;
  sendKot: (
    cancelledItems?: Array<{
      orderItemId: string;
      reason: string;
      managerPin?: string;
      pin?: string;
      approverUserId?: string;
    }>,
  ) => Promise<boolean>;
  markOrderServed: () => Promise<boolean>;
  getTotals: () => CartTotals | null;
  getUnsentCount: () => number;
}

function computeLineKey(itemId: string, modifiers: CartModifier[] = []): string {
  const sortedMods = [...modifiers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => m.name)
    .join('|');
  return `${itemId}_${sortedMods}`;
}

export const useCartStore = create<CartState>((set, get) => ({
  orderId: generateUuidV7(),
  isPersisted: false,
  tableId: null,
  tableLabel: null,
  customerId: null,
  customerName: null,
  customerPhone: null,
  customerPreferences: null,
  type: 'dine_in',
  guests: 2,
  items: [],
  specialInstructions: '',
  taxMode: null,
  isTaxModeLoading: false,
  taxModeError: null,
  isSaving: false,
  isSendingKot: false,
  version: 1,

  initNewOrder: (opts) => {
    set({
      orderId: opts?.orderId || generateUuidV7(),
      isPersisted: false,
      tableId: opts?.tableId ?? null,
      tableLabel: opts?.tableLabel ?? null,
      customerId: opts?.customerId ?? null,
      customerName: opts?.customerName ?? null,
      customerPhone: opts?.customerPhone ?? null,
      customerPreferences: opts?.customerPreferences ?? null,
      type: opts?.type ?? (opts?.tableId ? 'dine_in' : 'takeaway'),
      guests: opts?.guests ?? 2,
      items: opts?.items || [],
      specialInstructions: '',
      version: 1,
      isSaving: false,
      isSendingKot: false,
    });
  },

  loadOrder: async (orderId: string) => {
    let loaded = false;
    try {
      // First check local Dexie
      const local = await localDb.openOrders.get(orderId);
      if (local) {
        loaded = true;
        set({
          orderId: local.id,
          isPersisted: true,
          tableId: local.tableId || null,
          tableLabel: local.tableLabel || null,
          customerId: local.customerId || null,
          customerName: local.customerName || null,
          customerPhone: local.customerPhone || null,
          customerPreferences: local.customerPreferences || null,
          type: local.type,
          guests: local.guests,
          specialInstructions: local.specialInstructions || '',
          version: local.version,
          items: (local.items || []).map((i) => ({
            id: computeLineKey(i.itemId, i.modifiers),
            itemId: i.itemId,
            name: i.name,
            isVeg: i.isVeg,
            pricePaise: i.pricePaise,
            taxRateBp: 500,
            qty: i.qty,
            sentQty: i.qty,
            modifiers: i.modifiers,
            note: i.note || '',
            kotState: 'sent',
          })),
        });
      }

      // Fetch latest from API if online
      if (navigator.onLine) {
        const orderData = await apiFetch<ApiOrderResponse>(`/orders/${orderId}`);
        if (orderData) {
          loaded = true;
          let custName = get().customerName;
          let custPhone = get().customerPhone;
          let custPrefs = get().customerPreferences;

          if (orderData.customerId && (!custName || !custPhone)) {
            try {
              await apiFetch<unknown>(`/customers/lookup?phone=`);
            } catch {
              // Ignore or lookup cached customer
            }
            if (orderData.customerId) {
              const cached = await localDb.cachedCustomers.get(orderData.customerId);
              if (cached) {
                custName = cached.name;
                custPhone = cached.phone;
                custPrefs = cached.preferences;
              }
            }
          }

          set({
            orderId: orderData.id,
            isPersisted: true,
            tableId: orderData.tableId,
            tableLabel: orderData.tableLabel || null,
            customerId: orderData.customerId || null,
            customerName: custName,
            customerPhone: custPhone,
            customerPreferences: custPrefs,
            type: orderData.type,
            guests: orderData.guests,
            specialInstructions: orderData.specialInstructions || '',
            version: orderData.version,
            items: (orderData.items || []).map((i: ApiOrderItemResponse) => ({
              id: computeLineKey(i.itemId, i.modifiers),
              orderItemId: i.id,
              itemId: i.itemId,
              name: i.nameSnapshot,
              isVeg: false,
              pricePaise: i.pricePaiseSnapshot ?? 0,
              taxRateBp: i.taxRateBpSnapshot || 500,
              qty: i.qty,
              sentQty: i.kotState === 'sent' ? i.qty : 0,
              modifiers: i.modifiers || [],
              note: i.note || '',
              kotState: (i.kotState || 'unsent') as ItemKotState,
            })),
          });
        }
      }
      return loaded;
    } catch (err) {
      console.warn('Failed to load order:', err);
      return loaded;
    }
  },

  setTable: (tableId, tableLabel) =>
    set({
      tableId,
      tableLabel: tableLabel || null,
      type: tableId ? 'dine_in' : 'takeaway',
    }),
  setCustomer: async (customer) => {
    const { orderId } = get();
    if (!customer || !customer.id) {
      set({
        customerId: null,
        customerName: null,
        customerPhone: null,
        customerPreferences: null,
      });
      return;
    }

    set({
      customerId: customer.id,
      customerName: customer.name ?? null,
      customerPhone: customer.phone ?? null,
      customerPreferences: customer.preferences ?? null,
    });

    // Update in dexie local order if exists
    try {
      await localDb.openOrders.update(orderId, {
        customerId: customer.id,
        customerName: customer.name ?? null,
        customerPhone: customer.phone ?? null,
        customerPreferences: customer.preferences ?? null,
      });
      // If online and order is saved on backend, sync patch
      if (navigator.onLine) {
        await apiFetch(`/orders/${orderId}/customer`, {
          method: 'PATCH',
          body: JSON.stringify({ customerId: customer.id }),
        }).catch(() => {});
      }
    } catch {
      // Offline or order not yet saved locally/remotely
    }
  },

  clearCustomer: async () => {
    const { orderId } = get();
    set({
      customerId: null,
      customerName: null,
      customerPhone: null,
      customerPreferences: null,
    });
    try {
      await localDb.openOrders.update(orderId, {
        customerId: null,
        customerName: null,
        customerPhone: null,
        customerPreferences: null,
      });
      if (navigator.onLine) {
        await apiFetch(`/orders/${orderId}/customer`, {
          method: 'PATCH',
          body: JSON.stringify({ customerId: null }),
        }).catch(() => {});
      }
    } catch {
      // Ignore
    }
  },
  setOrderType: (type) => set({ type }),
  setGuests: (guests) => set({ guests }),
  setSpecialInstructions: (specialInstructions) => set({ specialInstructions }),
  setTaxMode: (taxMode) => set({ taxMode, taxModeError: null }),
  loadTaxMode: async () => {
    if (get().isTaxModeLoading) return false;

    set({ taxMode: null, isTaxModeLoading: true, taxModeError: null });
    try {
      const response = await apiFetch<{ taxMode: 'inclusive' | 'exclusive' }>(
        '/restaurant/tax-mode',
      );
      if (response.taxMode !== 'inclusive' && response.taxMode !== 'exclusive') {
        throw new Error('Invalid tax mode response');
      }
      set({ taxMode: response.taxMode, isTaxModeLoading: false, taxModeError: null });
      return true;
    } catch {
      set({
        taxMode: null,
        isTaxModeLoading: false,
        taxModeError:
          'Tax settings could not be loaded. Retry before saving or sending this order.',
      });
      return false;
    }
  },

  addItem: (item) => {
    const modifiers = item.modifiers || [];
    const lineId = computeLineKey(item.itemId, modifiers);
    const currentItems = get().items;
    const existingIndex = currentItems.findIndex((i) => i.id === lineId);

    if (existingIndex >= 0) {
      const nextItems = [...currentItems];
      const existing = nextItems[existingIndex]!;
      nextItems[existingIndex] = {
        ...existing,
        qty: existing.qty + 1,
        // If it was already sent, modifying qty marks as updated
        kotState: existing.kotState === 'unsent' ? 'unsent' : 'unsent',
      };
      set({ items: nextItems });
    } else {
      const newItem: CartItem = {
        id: lineId,
        itemId: item.itemId,
        name: item.name,
        isVeg: item.isVeg,
        pricePaise: item.pricePaise,
        taxRateBp: item.taxRateBp ?? 500,
        qty: 1,
        sentQty: 0,
        modifiers,
        note: '',
        kotState: 'unsent',
      };
      set({ items: [...currentItems, newItem] });
    }
  },

  updateItemQty: (itemId, qty, modifiers = []) => {
    const lineId = computeLineKey(itemId, modifiers);
    const currentItems = get().items;

    if (qty <= 0) {
      set({ items: currentItems.filter((i) => i.id !== lineId) });
      return;
    }

    const nextItems = currentItems.map((item) => {
      if (item.id === lineId) {
        return {
          ...item,
          qty,
          kotState: item.sentQty && qty !== item.sentQty ? 'unsent' : item.kotState,
        };
      }
      return item;
    });
    set({ items: nextItems });
  },

  updateItemNote: (lineId, note) => {
    set({
      items: get().items.map((i) => (i.id === lineId ? { ...i, note } : i)),
    });
  },

  removeItem: (lineId) => {
    set({ items: get().items.filter((i) => i.id !== lineId) });
  },

  clearCart: () => {
    set({
      items: [],
      specialInstructions: '',
    });
  },

  repeatOrder: (recentOrder) => {
    const { addToast } = useToastStore.getState();
    const skippedItems: string[] = [];
    const availableItems = new Map<string, CartItem>();

    for (const line of recentOrder.items) {
      if (!line.available || !line.qty || line.qty < 1) {
        skippedItems.push(line.name);
        continue;
      }
      const modifiers = line.modifiers || [];
      const id = computeLineKey(line.itemId, modifiers);
      const existing = availableItems.get(id);
      const draftLine = get().items.find((item) => item.id === id);
      if (line.qty + (existing?.qty || draftLine?.qty || 0) > 99) {
        skippedItems.push(line.name);
        continue;
      }
      availableItems.set(id, {
        id,
        itemId: line.itemId,
        name: line.name,
        isVeg: line.isVeg,
        pricePaise: line.pricePaise,
        taxRateBp: line.taxRateBp,
        qty: line.qty + (existing?.qty || 0),
        sentQty: 0,
        modifiers,
        note: '',
        kotState: 'unsent',
      });
    }

    if (skippedItems.length > 0) {
      addToast({
        type: 'warning',
        message: `Skipped unavailable items: ${skippedItems.join(', ')}`,
      });
    }

    if (availableItems.size > 0) {
      const nextItems = [...get().items];
      for (const [id, item] of availableItems) {
        const existingIndex = nextItems.findIndex((current) => current.id === id);
        if (existingIndex < 0) {
          nextItems.push(item);
        } else {
          const current = nextItems[existingIndex]!;
          nextItems[existingIndex] = {
            ...current,
            ...item,
            qty: current.qty + item.qty,
            orderItemId: current.orderItemId,
            sentQty: current.sentQty,
            kotState: current.kotState,
            note: current.note,
          };
        }
      }
      set({ items: nextItems });
      addToast({
        type: 'info',
        message: 'Items added to the cart. Review prices and options before sending.',
      });
    }
  },

  getUnsentCount: () => {
    return get().items.filter((i) => i.kotState === 'unsent' || (i.sentQty && i.qty !== i.sentQty))
      .length;
  },

  getTotals: () => {
    const { items, taxMode } = get();
    if (!taxMode) return null;
    let totalItemsPrice = 0;
    let totalTaxPaise = 0;

    for (const line of items) {
      const modTotalDelta = line.modifiers.reduce((sum, m) => sum + (m.priceDeltaPaise || 0), 0);
      const unitPrice = line.pricePaise + modTotalDelta;
      const lineTotal = unitPrice * line.qty;
      totalItemsPrice += lineTotal;

      if (taxMode === 'inclusive') {
        const lineTax = Math.round(lineTotal - (lineTotal * 10000) / (10000 + line.taxRateBp));
        totalTaxPaise += lineTax;
      } else {
        const lineTax = Math.round((lineTotal * line.taxRateBp) / 10000);
        totalTaxPaise += lineTax;
      }
    }

    if (taxMode === 'inclusive') {
      const subtotalPaise = totalItemsPrice - totalTaxPaise;
      return {
        subtotalPaise,
        taxPaise: totalTaxPaise,
        totalPaise: totalItemsPrice,
      };
    } else {
      return {
        subtotalPaise: totalItemsPrice,
        taxPaise: totalTaxPaise,
        totalPaise: totalItemsPrice + totalTaxPaise,
      };
    }
  },

  saveOrder: async () => {
    const state = get();
    if (state.items.length === 0) {
      useToastStore.getState().addToast({
        type: 'warning',
        message: 'Cart is empty. Add at least one item.',
      });
      return null;
    }

    const totals = state.getTotals();
    if (!totals) {
      useToastStore.getState().addToast({
        type: 'warning',
        message: 'Tax settings are unavailable. Retry before saving this order.',
      });
      return null;
    }

    set({ isSaving: true });
    const orderPayload = {
      id: state.orderId,
      tableId: state.tableId,
      customerId: state.customerId || undefined,
      type: state.type,
      guests: state.guests,
      specialInstructions: state.specialInstructions || undefined,
      items: state.items.map((i) => ({
        itemId: i.itemId,
        qty: i.qty,
        modifiers: i.modifiers.map((m) => ({ name: m.name, priceDeltaPaise: m.priceDeltaPaise })),
        note: i.note || undefined,
      })),
    };

    try {
      const localRecord: LocalOrder = {
        id: state.orderId,
        tableId: state.tableId,
        tableLabel: state.tableLabel || undefined,
        customerId: state.customerId,
        customerName: state.customerName,
        customerPhone: state.customerPhone,
        customerPreferences: state.customerPreferences,
        type: state.type,
        guests: state.guests,
        status: 'saved',
        specialInstructions: state.specialInstructions || undefined,
        subtotalPaise: totals.subtotalPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
        items: state.items.map((i) => ({
          itemId: i.itemId,
          name: i.name,
          isVeg: i.isVeg,
          pricePaise: i.pricePaise,
          qty: i.qty,
          modifiers: i.modifiers,
          note: i.note,
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: state.version,
        isSynced: false,
      };

      await localDb.openOrders.put(localRecord);

      if (state.tableId) {
        await localDb.floorTables.update(state.tableId, {
          status: 'occupied',
          currentOrderId: state.orderId,
        });
      }

      await useOutboxStore.getState().enqueue('order.create', orderPayload);

      // The local order and its create command are now persisted. Subsequent
      // KOT sends must reuse this order instead of enqueueing another create.
      set({ isPersisted: true });

      useToastStore.getState().addToast({
        type: 'success',
        message: `Order #${state.orderId.slice(0, 8)} saved successfully!`,
      });

      return state.orderId;
    } catch (err: unknown) {
      console.error('Failed to save order:', err);
      useToastStore.getState().addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Failed to save order',
      });
      return null;
    } finally {
      set({ isSaving: false });
    }
  },

  sendKot: async (cancelledItems = []) => {
    // React disables the submit button while sending, but store-level callers
    // (including double taps before React commits) must share the same lock.
    if (get().isSendingKot) return false;

    const state = get();
    const unsentCount = state.getUnsentCount();

    if (!state.taxMode) {
      useToastStore.getState().addToast({
        type: 'warning',
        message: 'Tax settings are unavailable. Retry before sending this order.',
      });
      return false;
    }

    if (unsentCount === 0 && cancelledItems.length === 0) {
      useToastStore.getState().addToast({
        type: 'warning',
        message: 'No unsent or modified items to send to kitchen.',
      });
      return false;
    }

    set({ isSendingKot: true });

    try {
      // 1. Ensure a new draft is saved first. Also recover the persisted state
      // from IndexedDB so a cart surviving a frontend reload doesn't enqueue a
      // duplicate create when its original command is already synced or queued.
      const [localOrder, existingCreate] = state.isPersisted
        ? [null, null]
        : await Promise.all([
            localDb.openOrders.get(state.orderId),
            localDb.outbox.get(state.orderId),
          ]);
      const alreadyPersisted =
        state.isPersisted ||
        localOrder?.isSynced === true ||
        existingCreate?.type === 'order.create';

      if (alreadyPersisted) {
        set({ isPersisted: true });
      } else {
        const savedOrderId = await state.saveOrder();
        if (!savedOrderId) return false;
      }

      // 2. Prepare provisional KOT label for offline resilience
      const provisionalLabel = `P-${Date.now().toString().slice(-4)}`;

      const kotPayload = {
        orderId: state.orderId,
        provisionalLabel,
        cancelledItems,
      };

      // 3. Enqueue KOT into Outbox
      await useOutboxStore.getState().enqueue('kot.send', kotPayload);

      // Optimistically update local item states to 'sent'
      const updatedItems = state.items.map((i) => ({
        ...i,
        kotState: 'sent' as ItemKotState,
        sentQty: i.qty,
      }));

      set({ items: updatedItems });

      useToastStore.getState().addToast({
        type: 'success',
        message: 'KOT fired to kitchen!',
      });

      return true;
    } catch (err: unknown) {
      console.error('Failed to send KOT:', err);
      useToastStore.getState().addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Failed to send KOT',
      });
      return false;
    } finally {
      set({ isSendingKot: false });
    }
  },

  markOrderServed: async () => {
    const state = get();
    try {
      await useOutboxStore.getState().enqueue('order.served', { orderId: state.orderId });

      const updatedItems = state.items.map((i) => ({
        ...i,
        kotState: 'served' as ItemKotState,
      }));
      set({ items: updatedItems });

      useToastStore.getState().addToast({
        type: 'success',
        message: 'Order marked served!',
      });
      return true;
    } catch (err: unknown) {
      useToastStore.getState().addToast({
        type: 'danger',
        message: err instanceof Error ? err.message : 'Failed to mark served',
      });
      return false;
    }
  },
}));
