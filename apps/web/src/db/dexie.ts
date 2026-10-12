import Dexie, { type Table } from 'dexie';
import type { MenuCategory, MenuItem, TableModel, CustomerWaiterSummary } from '@restaurant-os/shared';

export interface OutboxCommand {
  id: string; // client uuid
  key: string; // idempotency key
  type: string; // 'order.create' | 'order.update'
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastAttemptAt?: number;
  error?: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
}

export interface LocalOrder {
  id: string;
  tableId?: string | null;
  tableLabel?: string;
  customerId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerPreferences?: { tags: string[]; note: string } | null;
  type: 'dine_in' | 'takeaway';
  guests: number;
  status: 'open' | 'saved' | 'billed' | 'cancelled';
  specialInstructions?: string;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  items: Array<{
    itemId: string;
    name: string;
    isVeg: boolean;
    pricePaise: number;
    qty: number;
    modifiers: Array<{ name: string; priceDeltaPaise: number }>;
    note?: string;
  }>;
  createdAt: number;
  updatedAt: number;
  version: number;
  isSynced: boolean;
}

export interface LocalPrintJob {
  id: string;
  billId: string;
  billNumber: string;
  printerId?: string;
  printerName?: string;
  transport?: string;
  type: 'print' | 'reprint' | 'duplicate' | 'test';
  status: 'queued' | 'printing' | 'printed' | 'failed';
  attempts: number;
  lastAttemptAt?: number;
  error?: string;
  printError?: string;
  auditPending?: boolean;
  auditError?: string;
  createdAt: number;
  receiptData?: unknown;
}

export interface CachedCustomer {
  id: string;
  phone: string;
  name: string | null;
  preferences: { tags: string[]; note: string };
  favouriteItems?: CustomerWaiterSummary['favouriteItems'];
  lastOrder?: CustomerWaiterSummary['lastOrder'];
  lastVisitAt?: string | null;
  visitCount?: number;
  updatedAt: number;
}

export interface KitchenItem {
  id: string;
  orderItemId: string;
  name: string;
  qty: number;
  action: 'add' | 'cancel' | 'update';
  status: 'pending' | 'done' | 'cancelled';
  noteSnapshot?: string | null;
  modifiers?: Array<{ name: string }>;
  doneAt?: string | null;
  cancelledReason?: string | null;
}

export interface KitchenKot {
  id: string;
  orderId: string;
  tableLabel?: string | null;
  kotNumber: number;
  type: 'new' | 'additional' | 'modified';
  status: 'new' | 'preparing' | 'ready' | 'served' | 'cancelled';
  createdAt: string;
  seenAt?: string | null;
  readyAt?: string | null;
  items: KitchenItem[];
}

export type CachedCategory = Partial<MenuCategory> & { id: string; name: string };
export type CachedMenuItem = Partial<MenuItem> & { id: string; name: string; categoryId: string };

export class RestaurantDatabase extends Dexie {
  categories!: Table<CachedCategory, string>;
  menu!: Table<CachedMenuItem, string>;
  floorTables!: Table<TableModel & { status?: string; currentOrderId?: string | null }, string>;
  openOrders!: Table<LocalOrder, string>;
  outbox!: Table<OutboxCommand, string>;
  activeKots!: Table<KitchenKot, string>;
  printJobs!: Table<LocalPrintJob, string>;
  cachedCustomers!: Table<CachedCustomer, string>;

  constructor() {
    super('RestaurantOS_DB');
    this.version(4).stores({
      categories: 'id, sortOrder, active',
      menu: 'id, categoryId, isVeg, available, active, sortOrder',
      floorTables: 'id, label, status, active',
      openOrders: 'id, tableId, status, updatedAt, isSynced',
      outbox: 'id, key, status, createdAt, attempts',
      activeKots: 'id, orderId, status, createdAt',
      printJobs: 'id, billId, status, createdAt, attempts',
      cachedCustomers: 'id, phone, name, updatedAt',
    });

    // Version 5: Privacy indexes for retention and PII purging
    this.version(5).stores({
      categories: 'id, sortOrder, active',
      menu: 'id, categoryId, isVeg, available, active, sortOrder',
      floorTables: 'id, label, status, active',
      openOrders: 'id, tableId, status, updatedAt, isSynced',
      outbox: 'id, key, status, createdAt, attempts',
      activeKots: 'id, orderId, status, createdAt',
      printJobs: 'id, billId, status, createdAt, attempts',
      cachedCustomers: 'id, phone, name, updatedAt',
    });
  }
}

export const localDb = new RestaurantDatabase();

/**
 * Purges cached customer PII and local receipt data.
 * - On logout: clears all cached customer PII, customer details in open orders, and receiptData in print jobs.
 * - On retention cleanup (N days old, default 7 days): purges records older than cutoffMs.
 */
export async function purgeCustomerPiiAndReceipts(options: { daysOld?: number; purgeAll?: boolean } = {}): Promise<{
  purgedCustomers: number;
  clearedOrders: number;
  clearedPrintJobs: number;
}> {
  const { daysOld = 7, purgeAll = false } = options;
  const cutoffMs = Date.now() - daysOld * 24 * 60 * 60 * 1000;

  return await localDb.transaction('rw', [localDb.cachedCustomers, localDb.openOrders, localDb.printJobs], async () => {
    let purgedCustomers = 0;
    if (purgeAll) {
      purgedCustomers = await localDb.cachedCustomers.count();
      await localDb.cachedCustomers.clear();
    } else {
      const oldCustomers = await localDb.cachedCustomers
        .filter((c) => c.updatedAt < cutoffMs)
        .toArray();
      purgedCustomers = oldCustomers.length;
      await localDb.cachedCustomers.bulkDelete(oldCustomers.map((c) => c.id));
    }

    // Strip PII from local orders (anonymize customer info)
    const ordersToAnonymize = await localDb.openOrders
      .filter((o) => {
        if (purgeAll) {
          return Boolean(o.customerPhone || o.customerName || o.customerPreferences);
        }
        return o.updatedAt < cutoffMs && Boolean(o.customerPhone || o.customerName || o.customerPreferences);
      })
      .toArray();

    for (const order of ordersToAnonymize) {
      await localDb.openOrders.update(order.id, {
        customerPhone: null,
        customerName: null,
        customerPreferences: null,
      });
    }

    // Strip receipt payloads from printJobs
    const jobsToScrub = await localDb.printJobs
      .filter((job) => {
        if (!job.receiptData) return false;
        if (purgeAll) return true;
        return job.createdAt < cutoffMs;
      })
      .toArray();

    for (const job of jobsToScrub) {
      await localDb.printJobs.update(job.id, {
        receiptData: undefined,
      });
    }

    return {
      purgedCustomers,
      clearedOrders: ordersToAnonymize.length,
      clearedPrintJobs: jobsToScrub.length,
    };
  });
}

