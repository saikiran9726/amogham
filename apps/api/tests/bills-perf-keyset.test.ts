import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/db/client.js';
import { bills } from '../src/db/schema/bills.js';
import { orders } from '../src/db/schema/orders.js';
import { restaurants } from '../src/db/schema/restaurants.js';
import { users } from '../src/db/schema/users.js';
import { eq } from 'drizzle-orm';
import { generateUuidV7, Roles, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { hashPassword } from '../src/auth/crypto.js';
import { signAccessToken } from '../src/auth/jwt.js';

describe('GET /bills Performance, Search Escaping & Keyset Pagination Tests', () => {
  let app: FastifyInstance;
  let testRestaurantId: string;
  let cashierToken: string;
  let cashierId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    testRestaurantId = generateUuidV7();
    cashierId = generateUuidV7();

    await db.insert(restaurants).values({
      id: testRestaurantId,
      name: 'Bills Perf Bistro',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });

    const passwordHash = await hashPassword('CashierPass123!');
    await db.insert(users).values({
      id: cashierId,
      restaurantId: testRestaurantId,
      name: 'Bills Cashier',
      username: `cashier_${Date.now()}`,
      role: 'CASHIER',
      passwordHash,
      active: true,
    });

    cashierToken = signAccessToken({
      userId: cashierId,
      restaurantId: testRestaurantId,
      username: 'bills_cashier',
      name: 'Bills Cashier',
      role: Roles.CASHIER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.CASHIER],
    });

    // Seed test bills with specific business dates and numbers
    const targetDates = ['2026-10-10', '2026-10-10', '2026-10-11', '2026-10-12'];
    const billNumbers = ['BILL-100%OFF', 'BILL-100_REG', 'BILL-200_SPL', 'BILL-SPECIAL\\1'];

    for (let i = 0; i < 4; i++) {
      const orderId = generateUuidV7();
      await db.insert(orders).values({
        id: orderId,
        restaurantId: testRestaurantId,
        type: 'dine_in',
        status: 'billed',
        subtotalPaise: 10000,
        taxPaise: 500,
        totalPaise: 10500,
      });

      await db.insert(bills).values({
        id: generateUuidV7(),
        restaurantId: testRestaurantId,
        orderId,
        billNumber: billNumbers[i]!,
        subtotalPaise: 10000,
        taxPaise: 500,
        totalPaise: 10500,
        status: 'paid',
        businessDate: targetDates[i]!,
        taxMode: 'exclusive',
        createdAt: new Date(Date.now() - (4 - i) * 60000), // distinct timestamps
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('filters on indexed business_date column', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bills?date=2026-10-10',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.bills).toHaveLength(2);
    expect(data.bills.every((b: any) => b.businessDate === '2026-10-10')).toBe(true);
  });

  it('escapes % wildcard in search so literal percent matches only target bill', async () => {
    // Search for literal '100%' - if % was not escaped, it would match everything starting with 100
    const res = await app.inject({
      method: 'GET',
      url: '/bills?search=100%',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.bills).toHaveLength(1);
    expect(data.bills[0].billNumber).toBe('BILL-100%OFF');
  });

  it('escapes _ wildcard in search so literal underscore does not act as single character wildcard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bills?search=100_',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.bills).toHaveLength(1);
    expect(data.bills[0].billNumber).toBe('BILL-100_REG');
  });

  it('escapes backslash in search query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bills?search=SPECIAL\\1',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.bills).toHaveLength(1);
    expect(data.bills[0].billNumber).toBe('BILL-SPECIAL\\1');
  });

  it('keyset pagination: returns nextCursor and paginates deterministically without gaps', async () => {
    // Page 1: limit = 2
    const page1Res = await app.inject({
      method: 'GET',
      url: '/bills?limit=2',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(page1Res.statusCode).toBe(200);
    const page1Data = page1Res.json();
    expect(page1Data.bills).toHaveLength(2);
    expect(page1Data.nextCursor).toBeDefined();
    expect(page1Data.nextCursor.cursorCreatedAt).toBeDefined();
    expect(page1Data.nextCursor.cursorId).toBeDefined();

    // Page 2: query with keyset cursor
    const page2Res = await app.inject({
      method: 'GET',
      url: `/bills?limit=2&cursorCreatedAt=${encodeURIComponent(page1Data.nextCursor.cursorCreatedAt)}&cursorId=${page1Data.nextCursor.cursorId}`,
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    expect(page2Res.statusCode).toBe(200);
    const page2Data = page2Res.json();
    expect(page2Data.bills).toHaveLength(2);

    // Ensure distinct IDs across pages (no overlaps or skips)
    const page1Ids = new Set(page1Data.bills.map((b: any) => b.id));
    const page2Ids = page2Data.bills.map((b: any) => b.id);
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  });

  it('enforces max page size of 100 on limit query param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/bills?limit=150',
      headers: { authorization: `Bearer ${cashierToken}` },
    });

    // Zod schema enforces .max(100) -> 400
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
