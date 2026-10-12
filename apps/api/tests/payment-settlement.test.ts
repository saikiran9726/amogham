import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => ({
  fakeDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock('../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../src/auth/middleware.js', () => ({
  requirePermission: () => async (request: any) => {
    request.user = { restaurantId: 'restaurant-1', userId: 'waiter-1', role: 'WAITER' };
  },
  registerRouteGuard: vi.fn(),
}));
vi.mock('../src/services/audit.js', () => ({ recordAuditLog: vi.fn() }));
vi.mock('../src/realtime/socket.js', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('../src/services/loyalty.js', () => ({
  processBillPaidLoyaltyEarn: vi.fn(),
  processBillReversalLoyalty: vi.fn(),
  getOrCreateLoyaltySettings: vi.fn(),
  getOrCreateLoyaltyAccount: vi.fn(),
}));

import { billsRoutes } from '../src/routes/bills.js';
import { payments, bills } from '../src/db/schema/bills.js';
import { orders, syncCommands } from '../src/db/schema/orders.js';
import { tables } from '../src/db/schema/tables.js';
import { dailySummaries } from '../src/db/schema/daily-summaries.js';

const originalBill = () => ({
  id: 'bill-1',
  orderId: 'order-1',
  restaurantId: 'restaurant-1',
  status: 'unpaid',
  totalPaise: 10_000,
  businessDate: null,
  paidAt: null,
});

let state: {
  bill: any;
  order: any;
  table: any;
  payments: any[];
  syncCommands: any[];
  paymentSequence: number;
  billLockTail: Promise<void>;
};
let forceNoExistingIdempotencyForConcurrentTest = false;
let suppressTransactionIdempotencyReads = false;

function rowsFor(table: unknown) {
  if (table === bills) return state.bill ? [state.bill] : [];
  if (table === orders) return state.order ? [state.order] : [];
  if (table === payments) return state.payments;
  if (table === syncCommands) return state.syncCommands;
  if (table === dailySummaries) return [];
  return [];
}

function selectQuery(transactionReleases: Array<() => void> = [], inTransaction = false) {
  let selectedTable: unknown;
  let waitForBillLock: Promise<void> | undefined;
  const query: any = {
    from(table: unknown) {
      selectedTable = table;
      return query;
    },
    where() {
      return query;
    },
    for() {
      if (selectedTable === bills) {
        waitForBillLock = state.billLockTail;
        let release!: () => void;
        state.billLockTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        transactionReleases.push(release);
      }
      return query;
    },
    async limit() {
      await waitForBillLock;
      if (inTransaction && suppressTransactionIdempotencyReads && selectedTable === syncCommands) {
        return [];
      }
      if (
        !inTransaction &&
        forceNoExistingIdempotencyForConcurrentTest &&
        selectedTable === syncCommands
      ) {
        return [];
      }
      return rowsFor(selectedTable);
    },
    then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
      const rows =
        inTransaction && suppressTransactionIdempotencyReads && selectedTable === syncCommands
          ? []
          : !inTransaction &&
              forceNoExistingIdempotencyForConcurrentTest &&
              selectedTable === syncCommands
            ? []
            : rowsFor(selectedTable);
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return query;
}

function makeTransaction(releases: Array<() => void>) {
  return {
    execute: vi.fn(() => Promise.resolve([])),
    select: vi.fn(() => selectQuery(releases, true)),
    insert: vi.fn((table: unknown) => {
      let values: any;
      const query: any = {
        values(data: any) {
          values = data;
          return query;
        },
        returning() {
          if (table === payments) {
            const payment = { ...values, id: `payment-${++state.paymentSequence}` };
            state.payments.push(payment);
            return Promise.resolve([payment]);
          }
          return Promise.resolve([]);
        },
        then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
          if (table === syncCommands) state.syncCommands.push(values);
          return Promise.resolve([]).then(resolve, reject);
        },
      };
      return query;
    }),
    update: vi.fn((table: unknown) => {
      let values: any;
      const query: any = {
        set(data: any) {
          values = data;
          return query;
        },
        where() {
          return query;
        },
        returning() {
          if (table === payments) {
            state.payments = state.payments.map((payment) => ({ ...payment, ...values }));
            return Promise.resolve(state.payments);
          }
          if (table === bills) state.bill = { ...state.bill, ...values };
          if (table === orders) state.order = { ...state.order, ...values };
          if (table === tables && state.table?.currentOrderId === state.order.id) {
            state.table = { ...state.table, ...values };
          }
          const updated =
            table === bills ? state.bill : table === orders ? state.order : state.table;
          return Promise.resolve([updated]);
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (table === bills) state.bill = { ...state.bill, ...values };
          if (table === orders) state.order = { ...state.order, ...values };
          if (table === tables && state.table?.currentOrderId === state.order.id) {
            state.table = { ...state.table, ...values };
          }
          return Promise.resolve().then(resolve, reject);
        },
      };
      return query;
    }),
  };
}

let app: ReturnType<typeof Fastify>;

describe('cash payment settlement (isolated database mock)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    await app.register(billsRoutes);
    await app.ready();
  });

  beforeEach(() => {
    forceNoExistingIdempotencyForConcurrentTest = false;
    suppressTransactionIdempotencyReads = false;
    state = {
      bill: originalBill(),
      order: { id: 'order-1', customerId: null, tableId: 'table-1', status: 'saved' },
      table: { id: 'table-1', currentOrderId: 'order-1', status: 'payment_pending' },
      payments: [],
      syncCommands: [],
      paymentSequence: 0,
      billLockTail: Promise.resolve(),
    };
    fakeDb.select.mockImplementation(() => selectQuery());
    fakeDb.transaction.mockImplementation(async (callback: (transaction: any) => unknown) => {
      const releases: Array<() => void> = [];
      const tx = makeTransaction(releases);
      try {
        return await callback(tx);
      } finally {
        releases.reverse().forEach((release) => release());
      }
    });
    const tx = makeTransaction([]);
    fakeDb.insert.mockImplementation(tx.insert);
    fakeDb.update.mockImplementation(tx.update);
  });

  afterAll(async () => {
    await app.close();
  });

  async function recordCashPayment(input: {
    amountPaise: number;
    tenderedPaise: number;
    idempotencyKey: string;
  }) {
    return app.inject({
      method: 'POST',
      url: '/bills/bill-1/payments',
      payload: { method: 'cash', ...input },
    });
  }

  async function confirmPayment(paymentId: string) {
    return app.inject({
      method: 'POST',
      url: `/payments/${paymentId}/confirm`,
    });
  }

  it('rejects cash payment above the remaining bill balance', async () => {
    const response = await recordCashPayment({
      amountPaise: 10_001,
      tenderedPaise: 11_000,
      idempotencyKey: 'cash-over-balance',
    });

    expect(response.statusCode).toBe(400);
    expect(state.payments).toHaveLength(0);
    expect(state.bill.status).toBe('unpaid');
  });

  it('reserves a pending UPI amount so another attempt cannot consume the same balance', async () => {
    state.payments.push({
      id: 'pending-upi-1',
      billId: 'bill-1',
      restaurantId: 'restaurant-1',
      method: 'upi',
      amountPaise: 7_000,
      status: 'pending_confirmation',
    });

    const response = await recordCashPayment({
      amountPaise: 4_000,
      tenderedPaise: 4_000,
      idempotencyKey: 'cash-while-upi-pending',
    });

    expect(response.statusCode).toBe(400);
    expect(state.payments).toHaveLength(1);
    expect(state.bill.status).toBe('unpaid');
  });

  it('treats excess cash tendered as change rather than extra payment', async () => {
    const response = await recordCashPayment({
      amountPaise: 10_000,
      tenderedPaise: 12_000,
      idempotencyKey: 'cash-change',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().payment.amountPaise).toBe(10_000);
    expect(response.json().payment.changePaise).toBe(2_000);
    expect(state.payments).toHaveLength(1);
  });

  it('returns the original result for a retry with the same idempotency key', async () => {
    const payment = {
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: 'cash-retry-same-key',
    };
    const first = await recordCashPayment(payment);
    const retry = await recordCashPayment(payment);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(state.payments).toHaveLength(1);
  });

  it('marks the bill paid and releases the table after full payment', async () => {
    const response = await recordCashPayment({
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: 'cash-full',
    });

    expect(response.json().isFullyPaid).toBe(true);
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table.status).toBe('available');
    expect(state.table.currentOrderId).toBeNull();
  });

  it('marks a fully paid takeaway order billed without requiring or changing a table', async () => {
    state.order.tableId = null;
    state.table = null;

    const response = await recordCashPayment({
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: 'cash-takeaway-full',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().isFullyPaid).toBe(true);
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table).toBeNull();
  });

  it('does not release a table that has since been assigned to another order', async () => {
    state.table = { id: 'table-1', currentOrderId: 'new-order', status: 'occupied' };

    const response = await recordCashPayment({
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: 'cash-table-reassigned',
    });

    expect(response.statusCode).toBe(201);
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table).toEqual({ id: 'table-1', currentOrderId: 'new-order', status: 'occupied' });
  });

  it('keeps a partially paid bill and its table occupied', async () => {
    const response = await recordCashPayment({
      amountPaise: 4_000,
      tenderedPaise: 5_000,
      idempotencyKey: 'cash-partial',
    });

    expect(response.json().isFullyPaid).toBe(false);
    expect(state.bill.status).toBe('partially_paid');
    expect(state.order.status).toBe('saved');
    expect(state.table.status).toBe('payment_pending');
    expect(state.table.currentOrderId).toBe('order-1');
  });

  it('serializes distinct concurrent payment attempts before checking remaining balance', async () => {
    forceNoExistingIdempotencyForConcurrentTest = true;
    suppressTransactionIdempotencyReads = true;
    const [first, second] = await Promise.all([
      recordCashPayment({
        amountPaise: 6_000,
        tenderedPaise: 6_000,
        idempotencyKey: 'concurrent-payment-a',
      }),
      recordCashPayment({
        amountPaise: 6_000,
        tenderedPaise: 6_000,
        idempotencyKey: 'concurrent-payment-b',
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 400]);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].amountPaise).toBe(6_000);
    expect(state.bill.status).toBe('partially_paid');
    expect(state.table.status).toBe('payment_pending');
  });

  it('replays the original result for concurrent requests using the same idempotency key', async () => {
    forceNoExistingIdempotencyForConcurrentTest = true;
    const payment = {
      amountPaise: 10_000,
      tenderedPaise: 10_000,
      idempotencyKey: 'concurrent-same-key',
    };

    const [first, retry] = await Promise.all([
      recordCashPayment(payment),
      recordCashPayment(payment),
    ]);

    expect([first.statusCode, retry.statusCode].sort()).toEqual([200, 201]);
    expect(retry.json()).toEqual(first.json());
    expect(state.payments).toHaveLength(1);
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table.status).toBe('available');
  });

  it('serializes concurrent confirmation retries so settlement side effects happen once', async () => {
    state.payments.push({
      id: 'pending-payment',
      billId: 'bill-1',
      restaurantId: 'restaurant-1',
      method: 'upi',
      amountPaise: 10_000,
      status: 'pending_confirmation',
    });

    const [first, second] = await Promise.all([
      confirmPayment('pending-payment'),
      confirmPayment('pending-payment'),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].status).toBe('confirmed');
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table.status).toBe('available');
    expect(state.table.currentOrderId).toBeNull();
    expect([first.json().alreadyConfirmed, second.json().alreadyConfirmed]).toContain(true);
  });
});
