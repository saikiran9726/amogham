import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { pool, closeDatabaseConnection, db } from '../src/db/client.js';
import { syncCommands } from '../src/db/schema/orders.js';
import { eq, and } from 'drizzle-orm';
import { withIdempotency } from '../src/http/idempotency.js';
import { IdempotencyCleanupService } from '../src/jobs/cleanup.js';

const expectedDatabase = process.env.RESTAURANT_OS_ISOLATED_TEST_DB;
const isDedicatedTestDatabase =
  Boolean(expectedDatabase) &&
  (new URL(process.env.DATABASE_URL || 'postgres://localhost/').pathname === `/${expectedDatabase}` ||
   process.env.DATABASE_URL?.includes(expectedDatabase));

describe.skipIf(!isDedicatedTestDatabase)('Idempotency hardening integration tests', () => {
  const restaurantA = randomUUID();
  const restaurantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const tokenA = signAccessToken({
    userId: userA,
    restaurantId: restaurantA,
    username: `user_a_${suffix}`,
    name: 'User A',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  const tokenB = signAccessToken({
    userId: userB,
    restaurantId: restaurantB,
    username: `user_b_${suffix}`,
    name: 'User B',
    role: Roles.OWNER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
  });

  let app: Awaited<ReturnType<typeof buildServer>>;
  let categoryIdA: string;
  let menuItemIdA: string;
  let categoryIdB: string;
  let menuItemIdB: string;

  beforeAll(async () => {
    // Seed restaurants and users
    await pool.query('INSERT INTO restaurants (id, name) VALUES ($1, $2), ($3, $4)', [
      restaurantA,
      'Restaurant A',
      restaurantB,
      'Restaurant B',
    ]);
    await pool.query(
      `INSERT INTO users (id, restaurant_id, username, password_hash, name, active)
       VALUES ($1, $2, $5, 'hash', 'User A', true),
              ($3, $4, $6, 'hash', 'User B', true)`,
      [userA, restaurantA, userB, restaurantB, `user_a_${suffix}`, `user_b_${suffix}`],
    );

    // Seed menu items for both
    categoryIdA = randomUUID();
    menuItemIdA = randomUUID();
    await pool.query('INSERT INTO menu_categories (id, restaurant_id, name) VALUES ($1, $2, $3)', [
      categoryIdA,
      restaurantA,
      'Cat A',
    ]);
    await pool.query(
      `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, available)
       VALUES ($1, $2, $3, 'Item A', 5000, true)`,
      [menuItemIdA, restaurantA, categoryIdA],
    );

    categoryIdB = randomUUID();
    menuItemIdB = randomUUID();
    await pool.query('INSERT INTO menu_categories (id, restaurant_id, name) VALUES ($1, $2, $3)', [
      categoryIdB,
      restaurantB,
      'Cat B',
    ]);
    await pool.query(
      `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, available)
       VALUES ($1, $2, $3, 'Item B', 6000, true)`,
      [menuItemIdB, restaurantB, categoryIdB],
    );

    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDatabaseConnection();
  });

  describe('Core withIdempotency unit behavior', () => {
    it('failure inside fn leaves no stored key', async () => {
      const key = `fail-key-${randomUUID()}`;
      await expect(
        db.transaction(async (tx) => {
          return withIdempotency(
            tx,
            {
              restaurantId: restaurantA,
              userId: userA,
              commandType: 'test.failure',
              key,
              requestBody: { action: 'fail' },
            },
            async () => {
              throw new Error('Simulated domain failure');
            },
          );
        }),
      ).rejects.toThrow('Simulated domain failure');

      const rows = await db
        .select()
        .from(syncCommands)
        .where(
          and(eq(syncCommands.restaurantId, restaurantA), eq(syncCommands.idempotencyKey, key)),
        );
      expect(rows).toHaveLength(0);
    });

    it('tenant B reusing tenant A key executes independently', async () => {
      const sharedKey = `cross-tenant-key-${randomUUID()}`;

      const resA = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'test.command',
            key: sharedKey,
            requestBody: { tenant: 'A' },
          },
          async () => ({ resultFor: 'A' }),
        );
      });

      const resB = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantB,
            userId: userB,
            commandType: 'test.command',
            key: sharedKey,
            requestBody: { tenant: 'B' },
          },
          async () => ({ resultFor: 'B' }),
        );
      });

      expect(resA.result).toEqual({ resultFor: 'A' });
      expect(resA.replayed).toBe(false);
      expect(resB.result).toEqual({ resultFor: 'B' });
      expect(resB.replayed).toBe(false);

      const rowsA = await db
        .select()
        .from(syncCommands)
        .where(
          and(
            eq(syncCommands.restaurantId, restaurantA),
            eq(syncCommands.idempotencyKey, sharedKey),
          ),
        );
      const rowsB = await db
        .select()
        .from(syncCommands)
        .where(
          and(
            eq(syncCommands.restaurantId, restaurantB),
            eq(syncCommands.idempotencyKey, sharedKey),
          ),
        );

      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]?.result).toEqual({ resultFor: 'A' });
      expect(rowsB[0]?.result).toEqual({ resultFor: 'B' });
    });

    it('same key on two endpoints does not collide', async () => {
      const sharedKey = `cross-endpoint-key-${randomUUID()}`;

      const res1 = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'endpoint.one',
            key: sharedKey,
            requestBody: { endpoint: 1 },
          },
          async () => ({ endpoint: 1 }),
        );
      });

      const res2 = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'endpoint.two',
            key: sharedKey,
            requestBody: { endpoint: 2 },
          },
          async () => ({ endpoint: 2 }),
        );
      });

      expect(res1.result).toEqual({ endpoint: 1 });
      expect(res2.result).toEqual({ endpoint: 2 });
    });

    it('same key + different body -> 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = `reuse-key-${randomUUID()}`;

      await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'test.reuse',
            key,
            requestBody: { amount: 100 },
          },
          async () => ({ ok: true }),
        );
      });

      await expect(
        db.transaction(async (tx) => {
          return withIdempotency(
            tx,
            {
              restaurantId: restaurantA,
              userId: userA,
              commandType: 'test.reuse',
              key,
              requestBody: { amount: 200 }, // different body
            },
            async () => ({ ok: true }),
          );
        }),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });

    it('same key + same body replays stored result', async () => {
      const key = `replay-key-${randomUUID()}`;

      const first = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'test.replay',
            key,
            requestBody: { amount: 100 },
          },
          async () => ({ output: 'created' }),
        );
      });

      const second = await db.transaction(async (tx) => {
        return withIdempotency(
          tx,
          {
            restaurantId: restaurantA,
            userId: userA,
            commandType: 'test.replay',
            key,
            requestBody: { amount: 100 },
          },
          async () => ({ output: 'unexpected' }),
        );
      });

      expect(first.result).toEqual({ output: 'created' });
      expect(first.replayed).toBe(false);
      expect(second.result).toEqual({ output: 'created' });
      expect(second.replayed).toBe(true);
    });
  });

  describe('HTTP Route Integration', () => {
    it('rejects same idempotency key with different body on POST /orders with 422', async () => {
      const key = `http-key-${randomUUID()}`;
      const res1 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'idempotency-key': key,
        },
        payload: {
          id: randomUUID(),
          type: 'takeaway',
          guests: 1,
          items: [{ itemId: menuItemIdA, qty: 1 }],
        },
      });

      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'idempotency-key': key,
        },
        payload: {
          id: randomUUID(),
          type: 'takeaway',
          guests: 2, // different payload
          items: [{ itemId: menuItemIdA, qty: 2 }],
        },
      });

      expect(res2.statusCode).toBe(422);
      expect(res2.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('20 parallel identical payment requests -> exactly one payment row and 19 replays', async () => {
      // 1. Create order and bill in restaurant A
      const orderId = randomUUID();
      await pool.query(
        `INSERT INTO orders (id, restaurant_id, type, guests, status, subtotal_paise, tax_paise, total_paise, created_by)
         VALUES ($1, $2, 'takeaway', 1, 'saved', 10000, 500, 10500, $3)`,
        [orderId, restaurantA, userA],
      );
      await pool.query(
        `INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot, qty, status)
         VALUES ($1, $2, $3, 'Item A', 10000, 1, 'active')`,
        [randomUUID(), orderId, menuItemIdA],
      );

      const billRes = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/bill`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {},
      });
      expect(billRes.statusCode).toBe(201);
      const billId = billRes.json().bill.id;

      const paymentKey = `parallel-payment-${randomUUID()}`;
      const payload = {
        amountPaise: 10500,
        tenderedPaise: 10500,
        method: 'cash',
      };

      // 2. Fire 20 concurrent requests
      const promises = Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/bills/${billId}/payments`,
          headers: {
            authorization: `Bearer ${tokenA}`,
            'idempotency-key': paymentKey,
          },
          payload,
        }),
      );

      const responses = await Promise.all(promises);

      // Verify statuses: 1 initial (201) and 19 replays (200)
      const status201s = responses.filter((r) => r.statusCode === 201);
      const status200s = responses.filter((r) => r.statusCode === 200);

      expect(status201s).toHaveLength(1);
      expect(status200s).toHaveLength(19);

      // All responses return matching payload
      const firstJson = status201s[0]!.json();
      for (const replay of status200s) {
        expect(replay.json()).toEqual(firstJson);
      }

      // Verify only 1 payment row in database
      const paymentRows = await pool.query(
        'SELECT id, amount_paise FROM payments WHERE bill_id = $1',
        [billId],
      );
      expect(paymentRows.rows).toHaveLength(1);

      // Verify only 1 sync_commands row for this key
      const syncRows = await pool.query(
        'SELECT id FROM sync_commands WHERE restaurant_id = $1 AND idempotency_key = $2',
        [restaurantA, paymentKey],
      );
      expect(syncRows.rows).toHaveLength(1);
    });
  });

  describe('Scheduled cleanup job', () => {
    it('deletes sync_commands older than 30 days and retains recent commands', async () => {
      const oldKey = `old-command-${randomUUID()}`;
      const recentKey = `recent-command-${randomUUID()}`;

      // Insert an old command (35 days ago)
      await pool.query(
        `INSERT INTO sync_commands (idempotency_key, restaurant_id, user_id, command_type, request_hash, status, result, created_at)
         VALUES ($1, $2, $3, 'test.old', 'hash_old', 'completed', '{"ok": true}'::jsonb, NOW() - INTERVAL '35 days')`,
        [oldKey, restaurantA, userA],
      );

      // Insert a recent command (5 days ago)
      await pool.query(
        `INSERT INTO sync_commands (idempotency_key, restaurant_id, user_id, command_type, request_hash, status, result, created_at)
         VALUES ($1, $2, $3, 'test.recent', 'hash_recent', 'completed', '{"ok": true}'::jsonb, NOW() - INTERVAL '5 days')`,
        [recentKey, restaurantA, userA],
      );

      const cleanupService = new IdempotencyCleanupService(db, 30);
      const deletedCount = await cleanupService.runCleanupOnce();

      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify old command is gone
      const oldCheck = await pool.query(
        'SELECT id FROM sync_commands WHERE restaurant_id = $1 AND idempotency_key = $2',
        [restaurantA, oldKey],
      );
      expect(oldCheck.rows).toHaveLength(0);

      // Verify recent command is retained
      const recentCheck = await pool.query(
        'SELECT id FROM sync_commands WHERE restaurant_id = $1 AND idempotency_key = $2',
        [restaurantA, recentKey],
      );
      expect(recentCheck.rows).toHaveLength(1);
    });
  });
});
