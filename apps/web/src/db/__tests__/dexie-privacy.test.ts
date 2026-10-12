import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { localDb, purgeCustomerPiiAndReceipts } from '../dexie.js';

describe('Dexie Privacy & Retention Policy', () => {
  beforeEach(async () => {
    await localDb.cachedCustomers.clear();
    await localDb.openOrders.clear();
    await localDb.printJobs.clear();
  });

  it('purges all customer PII and receipt data when purgeAll is true (logout)', async () => {
    // Seed cached customer
    await localDb.cachedCustomers.put({
      id: 'cust-1',
      name: 'Alice Doe',
      phone: '+919876543210',
      preferences: { tags: ['vip'], note: 'Allergic to nuts' },
      updatedAt: Date.now(),
    });

    // Seed order with customer details
    await localDb.openOrders.put({
      id: 'order-1',
      customerId: 'cust-1',
      customerName: 'Alice Doe',
      customerPhone: '+919876543210',
      customerPreferences: { tags: ['vip'], note: 'Allergic to nuts' },
      type: 'dine_in',
      guests: 2,
      status: 'open',
      subtotalPaise: 1000,
      taxPaise: 50,
      totalPaise: 1050,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      isSynced: true,
    });

    // Seed print job with receipt data
    await localDb.printJobs.put({
      id: 'job-1',
      billId: 'bill-1',
      billNumber: 'B-100',
      type: 'print',
      status: 'printed',
      attempts: 1,
      createdAt: Date.now(),
      receiptData: { items: [{ name: 'Soup' }], customerPhone: '+919876543210' },
    });

    const result = await purgeCustomerPiiAndReceipts({ purgeAll: true });
    expect(result.purgedCustomers).toBe(1);
    expect(result.clearedOrders).toBe(1);
    expect(result.clearedPrintJobs).toBe(1);

    // Verify Dexie storage state
    const remainingCustomers = await localDb.cachedCustomers.toArray();
    expect(remainingCustomers).toHaveLength(0);

    const updatedOrder = await localDb.openOrders.get('order-1');
    expect(updatedOrder?.customerName).toBeNull();
    expect(updatedOrder?.customerPhone).toBeNull();
    expect(updatedOrder?.customerPreferences).toBeNull();

    const updatedJob = await localDb.printJobs.get('job-1');
    expect(updatedJob?.receiptData).toBeUndefined();
  });

  it('purges only records older than retention threshold (daysOld)', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

    await localDb.cachedCustomers.bulkPut([
      {
        id: 'cust-old',
        name: 'Old User',
        phone: '+911111111111',
        preferences: { tags: [], note: '' },
        updatedAt: eightDaysAgo,
      },
      {
        id: 'cust-recent',
        name: 'Recent User',
        phone: '+912222222222',
        preferences: { tags: [], note: '' },
        updatedAt: oneDayAgo,
      },
    ]);

    const result = await purgeCustomerPiiAndReceipts({ daysOld: 7 });
    expect(result.purgedCustomers).toBe(1);

    const remainingCustomers = await localDb.cachedCustomers.toArray();
    expect(remainingCustomers).toHaveLength(1);
    expect(remainingCustomers[0]!.id).toBe('cust-recent');
  });
});
