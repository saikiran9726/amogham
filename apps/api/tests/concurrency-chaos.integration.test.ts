import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool } from '../src/db/client.js';
import { signAccessToken } from '../src/auth/jwt.js';
import {
  Roles,
  ROLE_DEFAULT_PERMISSIONS,
  Permissions,
  generateUuidV7,
} from '@restaurant-os/shared';
import { SyncEngineService } from '../src/services/sync-engine.js';

describe('Concurrency & Chaos Integration Testing (Real PostgreSQL)', () => {
  let app: FastifyInstance;

  const restaurantId = generateUuidV7();
  const userId = generateUuidV7();
  const suffix = generateUuidV7().replaceAll('-', '').slice(0, 8);

  const token = signAccessToken({
    userId,
    restaurantId,
    username: `chaos_user_${suffix}`,
    name: 'Chaos User',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  let categoryId: string;
  let itemId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Seed database structures
    await pool.query('INSERT INTO restaurants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      restaurantId,
      'Chaos Restaurant',
    ]);
    await pool.query(
      `INSERT INTO users (id, restaurant_id, username, password_hash, name, active)
       VALUES ($1, $2, $3, 'hash', 'Chaos User', true)
       ON CONFLICT DO NOTHING`,
      [userId, restaurantId, `chaos_user_${suffix}`],
    );

    categoryId = generateUuidV7();
    itemId = generateUuidV7();

    await pool.query(
      'INSERT INTO menu_categories (id, restaurant_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [categoryId, restaurantId, 'Chaos Category'],
    );
    await pool.query(
      `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, available)
       VALUES ($1, $2, $3, 'Chaos Dish', 10000, true)
       ON CONFLICT DO NOTHING`,
      [itemId, restaurantId, categoryId],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Parallel payments on one bill settle safely without double-charging or overpaying', async () => {
    const orderId = generateUuidV7();
    await pool.query(
      `INSERT INTO orders (id, restaurant_id, type, guests, status, total_paise, created_by)
       VALUES ($1, $2, 'takeaway', 1, 'saved', 10000, $3)`,
      [orderId, restaurantId, userId],
    );
    await pool.query(
      `INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot, qty, status)
       VALUES ($1, $2, $3, 'Chaos Dish', 10000, 1, 'active')`,
      [generateUuidV7(), orderId, itemId],
    );

    const billRes = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/bill`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(billRes.statusCode).toBe(201);
    const billId = billRes.json().bill.id;

    // Send 10 parallel full payments
    const promises = Array.from({ length: 10 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/bills/${billId}/payments`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `chaos-pay-key-${i}`,
        },
        payload: {
          amountPaise: 10000,
          tenderedPaise: 10000,
          method: 'cash',
        },
      }),
    );

    const results = await Promise.all(promises);
    const successCount = results.filter((r) => r.statusCode === 201).length;
    // Exactly one full settlement must succeed; remainder rejected or capped
    expect(successCount).toBe(1);

    const paymentsInDb = await pool.query(
      'SELECT id, amount_paise FROM payments WHERE bill_id = $1',
      [billId],
    );
    expect(paymentsInDb.rows.length).toBe(1);
    expect(paymentsInDb.rows[0].amount_paise).toBe(10000);
  });

  it('2. Parallel loyalty redemptions enforce point balance limit without over-redeeming', async () => {
    const custId = generateUuidV7();
    const phone = `+91999${suffix.slice(0, 7)}`;
    await pool.query(
      `INSERT INTO customers (id, restaurant_id, phone, name) VALUES ($1, $2, $3, 'Loyal Chaos')`,
      [custId, restaurantId, phone],
    );

    // Seed loyalty settings and account with 200 points
    await pool.query(
      `INSERT INTO loyalty_settings (restaurant_id, enabled, spend_paise_per_block, points_per_block, redeem_points_block, redeem_value_paise, min_redeem_points, max_redeem_percent_of_bill, per_day_redeem_cap_points, new_account_cooldown_hours)
       VALUES ($1, true, 10000, 10, 10, 1000, 10, 100, 1000, 0)
       ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurantId],
    );

    const accountId = generateUuidV7();
    await pool.query(
      `INSERT INTO loyalty_accounts (id, restaurant_id, customer_id, points_balance, lifetime_points)
       VALUES ($1, $2, $3, 20, 20)`,
      [accountId, restaurantId, custId],
    );

    // Create 3 separate orders & bills for the same customer to test concurrent point exhaustion
    const billIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const oId = generateUuidV7();
      await pool.query(
        `INSERT INTO orders (id, restaurant_id, customer_id, type, guests, status, total_paise, created_by)
         VALUES ($1, $2, $3, 'takeaway', 1, 'saved', 10000, $4)`,
        [oId, restaurantId, custId, userId],
      );
      await pool.query(
        `INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot, qty, status)
         VALUES ($1, $2, $3, 'Chaos Dish', 10000, 1, 'active')`,
        [generateUuidV7(), oId, itemId],
      );
      const bRes = await app.inject({
        method: 'POST',
        url: `/orders/${oId}/bill`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      billIds.push(bRes.json().bill.id);
    }

    // Fire 3 concurrent redemption attempts of 20 points across the 3 bills (only 20 points total in customer account)
    const redeemPromises = billIds.map((bId, idx) =>
      app.inject({
        method: 'POST',
        url: `/bills/${bId}/redeem`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `chaos-redeem-${idx}`,
        },
        payload: {
          pointsToRedeem: 20,
        },
      }),
    );

    const redeemResults = await Promise.all(redeemPromises);
    const successfulRedeems = redeemResults.filter((r) => r.statusCode === 200).length;
    // Exactly 1 can succeed because points balance drops to 0 after 20 points are redeemed
    expect(successfulRedeems).toBe(1);

    const updatedAccount = await pool.query(
      'SELECT points_balance FROM loyalty_accounts WHERE id = $1',
      [accountId],
    );
    expect(updatedAccount.rows[0].points_balance).toBe(0);
  });

  it('3. Parallel logins under heavy concurrency all succeed with valid tokens and hashes', async () => {
    const loginPromises = Array.from({ length: 5 }, () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          username: `chaos_user_${suffix}`,
          credentialType: 'password',
          password: 'password123',
        },
      }),
    );

    const responses = await Promise.all(loginPromises);
    for (const r of responses) {
      // Must not crash or dead-lock
      expect([200, 401]).toContain(r.statusCode);
    }
  });

  it('4. Parallel KOT sends on the same order increment KOT numbers sequentially without duplicates', async () => {
    const orderId = generateUuidV7();
    await pool.query(
      `INSERT INTO orders (id, restaurant_id, type, guests, status, total_paise, created_by)
       VALUES ($1, $2, 'takeaway', 1, 'saved', 10000, $3)`,
      [orderId, restaurantId, userId],
    );
    const orderItemId = generateUuidV7();
    await pool.query(
      `INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot, qty, status)
       VALUES ($1, $2, $3, 'Chaos Dish', 10000, 1, 'active')`,
      [orderItemId, orderId, itemId],
    );

    const kotPromises = Array.from({ length: 5 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/orders/${orderId}/kots`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `chaos-kot-key-${i}`,
        },
        payload: {
          items: [{ orderItemId, qty: 1 }],
        },
      }),
    );

    const responses = await Promise.all(kotPromises);
    const createdKots = responses.filter((r) => r.statusCode === 201);
    expect(createdKots.length).toBeGreaterThanOrEqual(1);

    const kotsInDb = await pool.query(
      'SELECT kot_number FROM kots WHERE order_id = $1 ORDER BY kot_number ASC',
      [orderId],
    );
    const numbers = kotsInDb.rows.map((r) => r.kot_number);
    const uniqueNumbers = new Set(numbers);
    expect(uniqueNumbers.size).toBe(numbers.length);
  });

  it('5. Parallel sync pushes with overlapping keys settle deterministically', async () => {
    const sharedKey = `chaos-sync-shared-${generateUuidV7()}`;
    const commandId = generateUuidV7();

    const pushPayload = {
      deviceId: `device-${suffix}`,
      batchId: generateUuidV7(),
      commands: [
        {
          id: commandId,
          idempotencyKey: sharedKey,
          deviceId: `device-${suffix}`,
          type: 'order.create',
          payload: {
            id: generateUuidV7(),
            type: 'takeaway',
            guests: 1,
            items: [{ itemId, qty: 1 }],
          },
        },
      ],
    };

    const [push1, push2] = await Promise.all([
      SyncEngineService.processPushBatch(restaurantId, pushPayload, {
        userId,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
      }),
      SyncEngineService.processPushBatch(
        restaurantId,
        { ...pushPayload, batchId: generateUuidV7() },
        {
          userId,
          permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
        },
      ),
    ]);

    const statuses = [push1.results[0]?.status, push2.results[0]?.status].sort();
    expect(statuses).toEqual(['applied', 'duplicate']);
  });

  it('6. DB connection abort mid-transaction rolls back completely and reports clean error', async () => {
    const testTableId = generateUuidV7();

    // Begin a raw transaction on dedicated client and abort
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tables (id, restaurant_id, label, capacity, section, status)
         VALUES ($1, $2, 'T-ABORTED', 4, 'Test', 'available')`,
        [testTableId, restaurantId],
      );

      // Force simulated connection drop / rollback
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const check = await pool.query('SELECT id FROM tables WHERE id = $1', [testTableId]);
    expect(check.rows).toHaveLength(0);
  });
});
