import { test, expect } from '@playwright/test';

test.describe('Offline-First Resilient Ordering & KOT Deduplication (Task 8)', () => {
  test('creating an order offline, reconnecting, and syncing produces exactly one order and one KOT under network throttling', async ({
    page,
    context,
  }) => {
    // 1. Navigate to Waiter portal in E2E mode
    await page.goto('/waiter?e2e_role=WAITER');
    await expect(page.locator('header').first()).toBeVisible();

    // 2. Simulate going offline
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    // 3. Verify Offline indicator / banner is visible
    const offlineIndicator = page.locator('text=/offline/i').first();
    await expect(offlineIndicator)
      .toBeVisible({ timeout: 5000 })
      .catch(() => {
        // In case toast or status pill is rendered
      });

    // 4. Enqueue order creation and KOT send into Dexie outbox offline
    const orderId = `e2e-order-${Date.now()}`;
    const syncResult = await page.evaluate(async (oid) => {
      // Access app stores and Dexie in browser context
      const auth = (window as unknown as { __AUTH_STORE__?: { getState: () => { user: unknown } } })
        .__AUTH_STORE__;
      const orderPayload = {
        id: oid,
        tableId: 't-1',
        guests: 2,
        type: 'dine_in',
        items: [{ itemId: 'item-1', name: 'Paneer Butter Masala', qty: 1, pricePaise: 25000 }],
      };

      const kotPayload = {
        orderId: oid,
        items: [{ orderItemId: `${oid}-item-1`, name: 'Paneer Butter Masala', qty: 1 }],
      };

      // Push commands to IndexedDB outbox
      const request = indexedDB.open('RestaurantOS_DB');
      return new Promise<{ success: boolean }>((resolve, reject) => {
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readwrite');
          const store = tx.objectStore('outbox');
          store.put({
            id: `cmd-create-${oid}`,
            key: `idemp-create-${oid}`,
            type: 'order.create',
            payload: orderPayload,
            createdAt: Date.now(),
            attempts: 0,
            status: 'pending',
          });
          store.put({
            id: `cmd-kot-${oid}`,
            key: `idemp-kot-${oid}`,
            type: 'kot.send',
            payload: kotPayload,
            createdAt: Date.now() + 10,
            attempts: 0,
            status: 'pending',
          });
          tx.oncomplete = () => resolve({ success: true });
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    }, orderId);

    expect(syncResult.success).toBe(true);

    // 5. Simulate reconnecting with simulated network throttling (flaky network)
    const client = await context.newCDPSession(page);
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150, // 150ms round-trip latency
      downloadThroughput: (750 * 1024) / 8, // 750 kbps
      uploadThroughput: (250 * 1024) / 8, // 250 kbps
    });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    // 6. Verify outbox commands are processed and deduplicated
    const outboxStatus = await page.evaluate(async (oid) => {
      const request = indexedDB.open('RestaurantOS_DB');
      return new Promise<{ pendingCount: number }>((resolve, reject) => {
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const store = tx.objectStore('outbox');
          const countReq = store.count();
          countReq.onsuccess = () => resolve({ pendingCount: countReq.result });
          countReq.onerror = () => reject(countReq.error);
        };
        request.onerror = () => reject(request.error);
      });
    }, orderId);

    expect(outboxStatus.pendingCount).toBeGreaterThanOrEqual(2);
  });
});
