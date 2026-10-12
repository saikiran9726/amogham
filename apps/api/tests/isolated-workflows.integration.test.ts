import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import { Roles, ROLE_DEFAULT_PERMISSIONS } from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { pool, closeDatabaseConnection } from '../src/db/client.js';
import { SyncEngineService } from '../src/services/sync-engine.js';

const expectedDatabase = process.env.RESTAURANT_OS_ISOLATED_TEST_DB;
const isDedicatedTestDatabase =
  Boolean(expectedDatabase) &&
  (new URL(process.env.DATABASE_URL || 'postgres://localhost/').pathname === `/${expectedDatabase}` ||
   process.env.DATABASE_URL?.includes(expectedDatabase));

describe.skipIf(!isDedicatedTestDatabase)('isolated PostgreSQL workflow integration', () => {
  const restaurantId = randomUUID();
  const waiterId = randomUUID();
  const kitchenId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const waiterToken = signAccessToken({
    userId: waiterId,
    restaurantId,
    username: `test_waiter_${suffix}`,
    name: 'Integration Waiter',
    role: Roles.WAITER,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
  });
  const kitchenToken = signAccessToken({
    userId: kitchenId,
    restaurantId,
    username: `test_kitchen_${suffix}`,
    name: 'Integration Kitchen',
    role: Roles.KITCHEN,
    permissions: ROLE_DEFAULT_PERMISSIONS[Roles.KITCHEN],
  });
  let app: Awaited<ReturnType<typeof buildServer>>;
  let waiterSocket: Socket | undefined;
  let apiAddress: string;
  let menuItemId: string;

  async function makeOrder(options: { table?: boolean; withItem?: boolean } = {}) {
    const orderId = randomUUID();
    const tableId = options.table ? randomUUID() : null;
    if (tableId) {
      await pool.query(
        `INSERT INTO tables (id, restaurant_id, label, capacity, section, status, current_order_id)
         VALUES ($1, $2, $3, 4, 'Integration', 'occupied', NULL)`,
        [tableId, restaurantId, `TEST-${suffix}-${orderId.slice(0, 4)}`],
      );
    }
    await pool.query(
      `INSERT INTO orders (id, restaurant_id, table_id, type, guests, status, total_paise, created_by)
       VALUES ($1, $2, $3, $4, 2, 'saved', 10000, $5)`,
      [orderId, restaurantId, tableId, tableId ? 'dine_in' : 'takeaway', waiterId],
    );
    if (tableId) {
      await pool.query('UPDATE tables SET current_order_id = $1 WHERE id = $2', [orderId, tableId]);
    }
    let orderItemId: string | undefined;
    if (options.withItem) {
      orderItemId = randomUUID();
      await pool.query(
        `INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot,
           tax_rate_bp_snapshot, qty, kot_state)
         VALUES ($1, $2, $3, 'Integration Dish', 10000, 500, 1, 'unsent')`,
        [orderItemId, orderId, menuItemId],
      );
    }
    return { orderId, tableId, orderItemId };
  }

  async function makeBill(orderId: string, billId = randomUUID()) {
    await pool.query(
      `INSERT INTO bills (id, restaurant_id, order_id, bill_number, subtotal_paise, total_paise, status, created_by)
       VALUES ($1, $2, $3, $4, 10000, 10000, 'unpaid', $5)`,
      [billId, restaurantId, orderId, `TEST-${suffix}-${billId.slice(0, 6)}`, waiterId],
    );
    return billId;
  }

  async function postPayment(
    billId: string,
    input: {
      method: 'cash' | 'upi' | 'card';
      amountPaise: number;
      idempotencyKey: string;
      tenderedPaise?: number;
    },
  ) {
    return app.inject({
      method: 'POST',
      url: `/bills/${billId}/payments`,
      headers: { authorization: `Bearer ${waiterToken}` },
      payload: input,
    });
  }

  beforeAll(async () => {
    if (!expectedDatabase || !isDedicatedTestDatabase) {
      throw new Error(
        'Refusing database workflow tests without an explicit isolated test database URL.',
      );
    }
    const identity = await pool.query(
      `SELECT current_database() AS database, current_user AS role,
              inet_server_port() AS port, current_setting('server_version_num') AS version_num`,
    );
    const actual = identity.rows[0];
    if (actual.database !== expectedDatabase && !process.env.DATABASE_URL?.includes(actual.database)) {
      throw new Error(
        `Refusing workflow tests because connected database (${actual.database}) did not match expected (${expectedDatabase}).`,
      );
    }

    await pool.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [
      restaurantId,
      `Isolated workflow test ${suffix}`,
    ]);
    await pool.query(
      `INSERT INTO users (id, restaurant_id, name, username, active)
       VALUES ($1, $2, 'Integration Waiter', $3, true), ($4, $2, 'Integration Kitchen', $5, true)`,
      [waiterId, restaurantId, `test_waiter_${suffix}`, kitchenId, `test_kitchen_${suffix}`],
    );
    const categoryId = randomUUID();
    menuItemId = randomUUID();
    await pool.query('INSERT INTO menu_categories (id, restaurant_id, name) VALUES ($1, $2, $3)', [
      categoryId,
      restaurantId,
      `Integration ${suffix}`,
    ]);
    await pool.query(
      `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, tax_rate_bp, available)
       VALUES ($1, $2, $3, 'Integration Dish', 10000, 500, true)`,
      [menuItemId, restaurantId, categoryId],
    );

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Isolated API test server did not bind a TCP port.');
    apiAddress = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    waiterSocket?.disconnect();
    if (app) await app.close();
    await closeDatabaseConnection();
  });

  it('sends one KOT for duplicate idempotent submissions and delivers Food Ready through Socket.IO', async () => {
    const { orderId } = await makeOrder({ withItem: true });
    waiterSocket = createSocketClient(apiAddress, {
      auth: { token: waiterToken },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      waiterSocket!.once('connect', resolve);
      waiterSocket!.once('connect_error', reject);
    });

    const first = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/kots`,
      headers: {
        authorization: `Bearer ${waiterToken}`,
        'idempotency-key': `kot-${suffix}-${orderId}`,
      },
      payload: {},
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/kots`,
      headers: {
        authorization: `Bearer ${waiterToken}`,
        'idempotency-key': `kot-${suffix}-${orderId}`,
      },
      payload: {},
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().kot.id).toBe(first.json().kot.id);
    const kotRows = await pool.query('SELECT id FROM kots WHERE order_id = $1', [orderId]);
    const kotItemRows = await pool.query('SELECT id FROM kot_items WHERE kot_id = $1', [
      first.json().kot.id,
    ]);
    expect(kotRows.rowCount).toBe(1);
    expect(kotItemRows.rowCount).toBe(1);

    const readyEvent = new Promise<Record<string, unknown>>((resolve) => {
      waiterSocket!.once('kot.statusChanged', resolve);
    });
    const markedDone = await app.inject({
      method: 'PATCH',
      url: `/kot-items/${kotItemRows.rows[0].id}/done`,
      headers: { authorization: `Bearer ${kitchenToken}` },
    });
    expect(markedDone.statusCode).toBe(200);
    const event = await readyEvent;
    expect(event.data).toMatchObject({ kotId: first.json().kot.id, status: 'ready' });

    const kitchenState = await app.inject({
      method: 'GET',
      url: '/kitchen/state',
      headers: { authorization: `Bearer ${kitchenToken}` },
    });
    const waiterState = await app.inject({
      method: 'GET',
      url: '/kitchen/state',
      headers: { authorization: `Bearer ${waiterToken}` },
    });
    expect(kitchenState.json().activeKots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.json().kot.id, status: 'ready' }),
      ]),
    );
    expect(waiterState.json().activeKots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.json().kot.id, status: 'ready' }),
      ]),
    );
    waiterSocket.disconnect();
    waiterSocket = undefined;
  });

  it('serializes concurrent online payments, retries, and confirmation without duplicate settlement', async () => {
    const { orderId, tableId } = await makeOrder({ table: true });
    const billId = await makeBill(orderId);
    const payment = {
      method: 'cash' as const,
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: `pay-${suffix}-${billId}`,
    };
    const [first, retry] = await Promise.all([
      postPayment(billId, payment),
      postPayment(billId, payment),
    ]);
    expect([first.statusCode, retry.statusCode].sort()).toEqual([200, 201]);
    expect(first.json()).toEqual(retry.json());

    const settlement = await pool.query(
      `SELECT b.status AS bill_status, o.status AS order_status, t.status AS table_status,
              t.current_order_id, (SELECT count(*)::int FROM payments p WHERE p.bill_id = b.id) AS payments
       FROM bills b JOIN orders o ON o.id = b.order_id JOIN tables t ON t.id = o.table_id WHERE b.id = $1`,
      [billId],
    );
    expect(settlement.rows[0]).toMatchObject({
      bill_status: 'paid',
      order_status: 'billed',
      table_status: 'available',
      current_order_id: null,
      payments: 1,
    });
    expect(tableId).toBeTruthy();

    const confirmFixture = await makeOrder({ table: true });
    const confirmBillId = await makeBill(confirmFixture.orderId);
    const pending = await postPayment(confirmBillId, {
      method: 'upi',
      amountPaise: 10_000,
      idempotencyKey: `upi-${suffix}-${confirmBillId}`,
    });
    expect(pending.statusCode).toBe(201);
    const paymentId = pending.json().payment.id as string;
    const confirmPath = `/payments/${paymentId}/confirm`;
    const [confirmationA, confirmationB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: confirmPath,
        headers: { authorization: `Bearer ${waiterToken}` },
      }),
      app.inject({
        method: 'POST',
        url: confirmPath,
        headers: { authorization: `Bearer ${waiterToken}` },
      }),
    ]);
    expect(confirmationA.statusCode).toBe(200);
    expect(confirmationB.statusCode).toBe(200);
    const confirmed = await pool.query(
      `SELECT b.status AS bill_status, o.status AS order_status, t.status AS table_status,
              (SELECT count(*)::int FROM payments p WHERE p.bill_id = b.id AND p.status = 'confirmed') AS confirmed_count
       FROM bills b JOIN orders o ON o.id = b.order_id JOIN tables t ON t.id = o.table_id WHERE b.id = $1`,
      [confirmBillId],
    );
    expect(confirmed.rows[0]).toMatchObject({
      bill_status: 'paid',
      order_status: 'billed',
      table_status: 'available',
      confirmed_count: 1,
    });

    const partialFixture = await makeOrder({ table: true });
    const partialBillId = await makeBill(partialFixture.orderId);
    const partialAttempts = await Promise.all(
      ['partial-online-a', 'partial-online-b'].map((label) =>
        postPayment(partialBillId, {
          method: 'cash',
          amountPaise: 6_000,
          tenderedPaise: 6_000,
          idempotencyKey: `${label}-${suffix}-${partialBillId}`,
        }),
      ),
    );
    expect(partialAttempts.map((response) => response.statusCode).sort()).toEqual([201, 400]);
    const partialSettlement = await pool.query(
      `SELECT b.status AS bill_status, t.status AS table_status, t.current_order_id,
              (SELECT count(*)::int FROM payments p WHERE p.bill_id = b.id) AS payment_count,
              (SELECT coalesce(sum(p.amount_paise), 0)::int FROM payments p WHERE p.bill_id = b.id) AS amount
       FROM bills b JOIN orders o ON o.id = b.order_id JOIN tables t ON t.id = o.table_id WHERE b.id = $1`,
      [partialBillId],
    );
    expect(partialSettlement.rows[0]).toEqual({
      bill_status: 'partially_paid',
      table_status: 'occupied',
      current_order_id: partialFixture.orderId,
      payment_count: 1,
      amount: 6_000,
    });

    const reassignedFixture = await makeOrder({ table: true });
    const reassignedBillId = await makeBill(reassignedFixture.orderId);
    const replacementOrderId = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, restaurant_id, table_id, type, guests, status, total_paise, created_by)
       VALUES ($1, $2, $3, 'dine_in', 2, 'saved', 10000, $4)`,
      [replacementOrderId, restaurantId, reassignedFixture.tableId, waiterId],
    );
    await pool.query('UPDATE tables SET current_order_id = $1 WHERE id = $2', [
      replacementOrderId,
      reassignedFixture.tableId,
    ]);
    const reassignedPayment = await postPayment(reassignedBillId, {
      method: 'cash',
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: `reassigned-${suffix}-${reassignedBillId}`,
    });
    expect(reassignedPayment.statusCode).toBe(201);
    const stillLinked = await pool.query(
      'SELECT status, current_order_id FROM tables WHERE id = $1',
      [reassignedFixture.tableId],
    );
    expect(stillLinked.rows[0]).toEqual({
      status: 'occupied',
      current_order_id: replacementOrderId,
    });
  });

  it('does not overpay on concurrent distinct offline sync keys and settles once on a same-key retry', async () => {
    const fullFixture = await makeOrder({ table: true });
    const fullBillId = await makeBill(fullFixture.orderId);
    const command = {
      id: randomUUID(),
      idempotencyKey: `offline-full-${suffix}-${fullBillId}`,
      deviceId: `test-device-${suffix}`,
      type: 'payment.record',
      payload: { billId: fullBillId, amountPaise: 10_000, method: 'cash' },
    };
    const input = {
      restaurantId,
      deviceId: command.deviceId,
      batchId: `batch-${suffix}-full`,
      commands: [command],
    };
    const [pushA, pushB] = await Promise.all([
      SyncEngineService.processPushBatch(restaurantId, input, {
        userId: waiterId,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      }),
      SyncEngineService.processPushBatch(
        restaurantId,
        { ...input, batchId: `batch-${suffix}-retry` },
        {
          userId: waiterId,
          permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
        },
      ),
    ]);
    expect([pushA.results[0]?.status, pushB.results[0]?.status].sort()).toEqual([
      'applied',
      'duplicate',
    ]);
    const fullCount = await pool.query(
      'SELECT count(*)::int AS count FROM payments WHERE bill_id = $1',
      [fullBillId],
    );
    expect(fullCount.rows[0].count).toBe(1);

    const partialFixture = await makeOrder({ table: true });
    const partialBillId = await makeBill(partialFixture.orderId);
    const createCommand = (key: string) => ({
      id: randomUUID(),
      idempotencyKey: key,
      deviceId: `test-device-${suffix}`,
      type: 'payment.record',
      payload: { billId: partialBillId, amountPaise: 6_000, method: 'cash' },
    });
    const [partialA, partialB] = await Promise.all(
      [`offline-a-${suffix}-${partialBillId}`, `offline-b-${suffix}-${partialBillId}`].map((key) =>
        SyncEngineService.processPushBatch(
          restaurantId,
          {
            deviceId: `test-device-${suffix}`,
            batchId: `batch-${randomUUID()}`,
            commands: [createCommand(key)],
          },
          {
            userId: waiterId,
            permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
          },
        ),
      ),
    );
    expect([partialA.results[0]?.status, partialB.results[0]?.status].sort()).toEqual([
      'applied',
      'conflict',
    ]);
    const partial = await pool.query(
      `SELECT b.status AS bill_status, (SELECT count(*)::int FROM payments p WHERE p.bill_id = b.id) AS payments,
              (SELECT coalesce(sum(p.amount_paise),0)::int FROM payments p WHERE p.bill_id = b.id) AS amount
       FROM bills b WHERE b.id = $1`,
      [partialBillId],
    );
    expect(partial.rows[0]).toEqual({ bill_status: 'partially_paid', payments: 1, amount: 6_000 });
  });

  it('ignores client-supplied prices in sync order.create and recalculates server totals', async () => {
    const syncOrderId = randomUUID();
    const command = {
      id: randomUUID(),
      idempotencyKey: `sync-pricing-${suffix}-${syncOrderId}`,
      deviceId: `test-device-${suffix}`,
      type: 'order.create',
      payload: {
        id: syncOrderId,
        type: 'takeaway',
        guests: 1,
        // Attempt to spoof prices: 1 paisa instead of actual 10000 paise
        subtotalPaise: 1,
        taxPaise: 0,
        totalPaise: 1,
        items: [
          {
            itemId: menuItemId,
            qty: 2,
            pricePaise: 1,
            pricePaiseSnapshot: 1,
          },
        ],
      },
    };

    const pushResult = await SyncEngineService.processPushBatch(
      restaurantId,
      {
        deviceId: `test-device-${suffix}`,
        batchId: randomUUID(),
        commands: [command],
      },
      {
        userId: waiterId,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      },
    );

    expect(pushResult.results[0]?.status).toBe('applied');

    const [dbOrder] = (
      await pool.query('SELECT subtotal_paise, tax_paise, total_paise FROM orders WHERE id = $1', [
        syncOrderId,
      ])
    ).rows;

    // Menu item is 10000 paise with 5% (500 bp) tax exclusive: 2 * 10000 = 20000 subtotal, 1000 tax = 21000 total
    expect(dbOrder.subtotal_paise).toBe(20000);
    expect(dbOrder.tax_paise).toBe(1000);
    expect(dbOrder.total_paise).toBe(21000);

    const [dbItem] = (
      await pool.query('SELECT price_paise_snapshot FROM order_items WHERE order_id = $1', [
        syncOrderId,
      ])
    ).rows;
    expect(dbItem.price_paise_snapshot).toBe(10000);
  });

  it('rejects foreign itemId and foreign tableId in sync order.create', async () => {
    const foreignItemId = randomUUID();
    const foreignTableId = randomUUID();

    // 1. Foreign itemId rejection
    const invalidItemCommand = {
      id: randomUUID(),
      idempotencyKey: `sync-foreign-item-${suffix}`,
      deviceId: `test-device-${suffix}`,
      type: 'order.create',
      payload: {
        id: randomUUID(),
        type: 'takeaway',
        guests: 1,
        items: [{ itemId: foreignItemId, qty: 1 }],
      },
    };

    const itemResult = await SyncEngineService.processPushBatch(
      restaurantId,
      {
        deviceId: `test-device-${suffix}`,
        batchId: randomUUID(),
        commands: [invalidItemCommand],
      },
      {
        userId: waiterId,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      },
    );

    expect(itemResult.results[0]?.status).toBe('rejected');
    expect(itemResult.results[0]?.errorCode).toBe('BAD_REQUEST');

    // 2. Foreign tableId rejection
    const invalidTableCommand = {
      id: randomUUID(),
      idempotencyKey: `sync-foreign-table-${suffix}`,
      deviceId: `test-device-${suffix}`,
      type: 'order.create',
      payload: {
        id: randomUUID(),
        tableId: foreignTableId,
        type: 'dine_in',
        guests: 2,
        items: [{ itemId: menuItemId, qty: 1 }],
      },
    };

    const tableResult = await SyncEngineService.processPushBatch(
      restaurantId,
      {
        deviceId: `test-device-${suffix}`,
        batchId: randomUUID(),
        commands: [invalidTableCommand],
      },
      {
        userId: waiterId,
        permissions: ROLE_DEFAULT_PERMISSIONS[Roles.WAITER],
      },
    );

    expect(tableResult.results[0]?.status).toBe('rejected');
    expect(tableResult.results[0]?.errorCode).toBe('BAD_REQUEST');
  });

  it('rejects cross-tenant push with 403 TENANT_MISMATCH and writes zero rows to database', async () => {
    const foreignRestaurantId = randomUUID();
    const batchId = randomUUID();
    const commandId = randomUUID();
    const orderId = randomUUID();

    const response = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${waiterToken}` },
      payload: {
        restaurantId: foreignRestaurantId,
        deviceId: `test-device-${suffix}`,
        batchId,
        commands: [
          {
            id: commandId,
            idempotencyKey: `cross-tenant-${suffix}-${orderId}`,
            deviceId: `test-device-${suffix}`,
            type: 'order.create',
            payload: {
              id: orderId,
              type: 'takeaway',
              items: [],
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('TENANT_MISMATCH');

    // Verify 0 rows written in foreign restaurant and caller restaurant
    const foreignEvents = await pool.query(
      'SELECT count(*)::int AS count FROM sync_events WHERE restaurant_id = $1',
      [foreignRestaurantId],
    );
    expect(foreignEvents.rows[0].count).toBe(0);

    const callerEvents = await pool.query(
      'SELECT count(*)::int AS count FROM sync_events WHERE command_id = $1',
      [commandId],
    );
    expect(callerEvents.rows[0].count).toBe(0);
  });
});
