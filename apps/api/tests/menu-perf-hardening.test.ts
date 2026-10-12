import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db, pool } from '../src/db/client.js';
import { menuCategories } from '../src/db/schema/menu-categories.js';
import { menuItems } from '../src/db/schema/menu-items.js';
import { orders, orderItems } from '../src/db/schema/orders.js';
import { bills, billLines } from '../src/db/schema/bills.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { eq, and } from 'drizzle-orm';
import { generateUuidV7, Roles, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { signAccessToken } from '../src/auth/jwt.js';

describe('Menu Hardening & Clear-Sample Soft Delete Tests', () => {
  let app: FastifyInstance;
  let testRestaurantId: string;
  let managerToken: string;
  let managerId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    testRestaurantId = generateUuidV7();
    managerId = generateUuidV7();

    await db.insert(restaurants).values({
      id: testRestaurantId,
      name: 'Menu Hardening Bistro',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });

    await db.insert(users).values({
      id: managerId,
      restaurantId: testRestaurantId,
      name: 'Menu Manager',
      username: `mgr_${Date.now()}`,
      role: Roles.MANAGER,
      passwordHash: 'placeholder',
      active: true,
    });

    managerToken = signAccessToken({
      userId: managerId,
      restaurantId: testRestaurantId,
      username: 'manager_user',
      name: 'Menu Manager',
      role: Roles.MANAGER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.MANAGER],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('bulk-veg toggle: handles empty itemIds array gracefully without DB query', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/menu/items/bulk-veg',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        itemIds: [],
        isVeg: true,
      },
    });

    // In shared schema, min(1) rejects empty array with 400
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('bulk-veg toggle: caps bulk item IDs at 200 in the schema', async () => {
    const excessiveIds = Array.from({ length: 205 }, () => generateUuidV7());

    const res = await app.inject({
      method: 'POST',
      url: '/menu/items/bulk-veg',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {
        itemIds: excessiveIds,
        isVeg: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('seed-sample sets explicit is_sample=true on categories and items', async () => {
    const seedRes = await app.inject({
      method: 'POST',
      url: '/menu/seed-sample',
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(seedRes.statusCode).toBe(200);
    expect(seedRes.json().success).toBe(true);

    const sampleCats = await db
      .select()
      .from(menuCategories)
      .where(
        and(eq(menuCategories.restaurantId, testRestaurantId), eq(menuCategories.isSample, true)),
      );
    expect(sampleCats.length).toBeGreaterThan(0);

    const sampleItemList = await db
      .select()
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, testRestaurantId), eq(menuItems.isSample, true)));
    expect(sampleItemList.length).toBeGreaterThan(0);
  });

  it('clear-sample: soft-deletes referenced items and hard-deletes unreferenced items in one transaction', async () => {
    // 1. Get sample items
    const sampleItemsInDb = await db
      .select()
      .from(menuItems)
      .where(and(eq(menuItems.restaurantId, testRestaurantId), eq(menuItems.isSample, true)));

    expect(sampleItemsInDb.length).toBeGreaterThanOrEqual(2);
    const referencedItem = sampleItemsInDb[0]!;
    const unreferencedItem = sampleItemsInDb[1]!;

    // 2. Create an order referencing the first sample item
    const orderId = generateUuidV7();
    await db.insert(orders).values({
      id: orderId,
      restaurantId: testRestaurantId,
      type: 'dine_in',
      status: 'completed',
      subtotalPaise: referencedItem.pricePaise,
      taxPaise: 0,
      totalPaise: referencedItem.pricePaise,
      createdBy: managerId,
    });

    const orderItemId = generateUuidV7();
    await db.insert(orderItems).values({
      id: orderItemId,
      orderId,
      itemId: referencedItem.id,
      nameSnapshot: referencedItem.name,
      pricePaiseSnapshot: referencedItem.pricePaise,
      taxRateBpSnapshot: 500,
      qty: 1,
      lineNo: 1,
    });

    // 3. Clear sample menu
    const clearRes = await app.inject({
      method: 'DELETE',
      url: '/menu/clear-sample',
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(clearRes.statusCode).toBe(200);
    const result = clearRes.json();
    expect(result.success).toBe(true);
    expect(result.softDeletedCount).toBeGreaterThanOrEqual(1);
    expect(result.hardDeletedCount).toBeGreaterThanOrEqual(1);

    // 4. Verify referenced item was soft-deleted (active = false)
    const [softDeletedCheck] = await db
      .select()
      .from(menuItems)
      .where(eq(menuItems.id, referencedItem.id));
    expect(softDeletedCheck).toBeDefined();
    expect(softDeletedCheck!.active).toBe(false);

    // 5. Verify unreferenced item was hard-deleted (removed from DB)
    const [hardDeletedCheck] = await db
      .select()
      .from(menuItems)
      .where(eq(menuItems.id, unreferencedItem.id));
    expect(hardDeletedCheck).toBeUndefined();
  });
});
