import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb, state } = vi.hoisted(() => ({
  fakeDb: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  state: {
    bill: null as any,
    order: null as any,
    table: null as any,
    payments: [] as any[],
    events: [] as any[],
    commands: [] as any[],
    conflicts: [] as any[],
    deadLetters: [] as any[],
    sequence: 0,
    transactionTail: Promise.resolve(),
  },
}));

vi.mock('../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../src/realtime/socket.js', () => ({ emitRealtimeEvent: vi.fn() }));

import { SyncEngineService } from '../src/services/sync-engine.js';
import { bills, payments } from '../src/db/schema/bills.js';
import { orders, syncCommands } from '../src/db/schema/orders.js';
import { tables } from '../src/db/schema/tables.js';
import {
  conflictReviews,
  deadLetterCommands,
  deviceRegistry,
  syncEvents,
} from '../src/db/schema/sync.js';

function rowsFor(table: unknown): any[] {
  if (table === bills) return state.bill ? [state.bill] : [];
  if (table === orders) return state.order ? [state.order] : [];
  if (table === tables) return state.table ? [state.table] : [];
  if (table === payments) return state.payments;
  if (table === syncEvents) return state.events;
  if (table === syncCommands) return state.commands;
  return [];
}

function collectSqlParameters(value: any, output: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') return output;
  if (value.constructor?.name === 'Param') {
    output.push(value.value);
    return output;
  }
  if (Array.isArray(value.queryChunks)) {
    for (const chunk of value.queryChunks) collectSqlParameters(chunk, output);
  }
  return output;
}

function makeQueries(inTransaction = false) {
  return {
    execute: vi.fn(() => Promise.resolve([])),
    select: vi.fn(() => {
      let table: unknown;
      let syncEventKey: string | undefined;
      const selectedRows = () => {
        const rows = rowsFor(table);
        return table === syncEvents && syncEventKey
          ? rows.filter((event) => event.idempotencyKey === syncEventKey)
          : rows;
      };
      const query: any = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where(condition: unknown) {
          if (table === syncEvents) {
            syncEventKey = String(collectSqlParameters(condition).at(-1) || '');
          }
          return query;
        },
        for() {
          return query;
        },
        async limit() {
          return selectedRows();
        },
        then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(selectedRows()).then(resolve, reject);
        },
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => {
      let values: any;
      const query: any = {
        values(input: any) {
          values = input;
          return query;
        },
        onConflictDoNothing() {
          return query;
        },
        onConflictDoUpdate() {
          return query;
        },
        async returning() {
          if (table === payments) {
            const payment = { ...values, id: `payment-${state.payments.length + 1}` };
            state.payments.push(payment);
            return [payment];
          }
          if (table === syncEvents) {
            const event = {
              ...values,
              seq: ++state.sequence,
              serverTimestamp: new Date(),
            };
            state.events.push(event);
            return [event];
          }
          return [];
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (table === payments) {
            state.payments.push({ ...values, id: `payment-${state.payments.length + 1}` });
          }
          if (table === conflictReviews) state.conflicts.push(values);
          if (table === deadLetterCommands) state.deadLetters.push(values);
          if (table === syncCommands) state.commands.push(values);
          return Promise.resolve().then(resolve, reject);
        },
      };
      return query;
    }),
    update: vi.fn((table: unknown) => {
      let values: any;
      const query: any = {
        set(input: any) {
          values = input;
          return query;
        },
        where() {
          return query;
        },
        async returning() {
          if (table === bills) state.bill = { ...state.bill, ...values };
          if (table === orders) state.order = { ...state.order, ...values };
          if (table === tables && state.table.currentOrderId === state.order.id) {
            state.table = { ...state.table, ...values };
          }
          return [values];
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (table === bills) state.bill = { ...state.bill, ...values };
          if (table === orders) state.order = { ...state.order, ...values };
          if (table === tables && state.table.currentOrderId === state.order.id) {
            state.table = { ...state.table, ...values };
          }
          return Promise.resolve().then(resolve, reject);
        },
      };
      return query;
    }),
  };
}

describe('offline sync payment safety (isolated database mock)', () => {
  beforeEach(() => {
    Object.assign(state, {
      bill: {
        id: '018f9e1e-2895-7800-9831-000000000001',
        restaurantId: '11111111-1111-4111-8111-111111111111',
        orderId: 'order-1',
        billNumber: 'B-1',
        businessDate: null,
        totalPaise: 10_000,
        status: 'unpaid',
      },
      order: { id: 'order-1', tableId: 'table-1', status: 'saved' },
      table: { id: 'table-1', currentOrderId: 'order-1', status: 'payment_pending' },
      payments: [],
      events: [],
      commands: [],
      conflicts: [],
      deadLetters: [],
      sequence: 0,
      transactionTail: Promise.resolve(),
    });

    fakeDb.insert.mockImplementation((table: unknown) => makeQueries().insert(table));
    fakeDb.select.mockImplementation(() => makeQueries().select());
    fakeDb.update.mockImplementation((table: unknown) => makeQueries().update(table));
    fakeDb.transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
      const previous = state.transactionTail;
      let release!: () => void;
      state.transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback({ ...makeQueries(true), execute: vi.fn().mockResolvedValue([]) });
      } finally {
        release();
      }
    });
  });

  afterEach(() => vi.clearAllMocks());

  function paymentCommand(key: string, amountPaise: number) {
    return {
      id: `command-${key}`,
      idempotencyKey: key,
      deviceId: 'device-1',
      type: 'payment.record' as const,
      payload: { billId: state.bill.id, amountPaise, method: 'cash' as const },
    };
  }

  async function push(commands: ReturnType<typeof paymentCommand>[]) {
    return SyncEngineService.processPushBatch(
      state.bill.restaurantId,
      {
        deviceId: 'device-1',
        batchId: '018f9e1e-2895-7800-9831-294719283748',
        commands,
      },
      {
        userId: '018f9e1e-2895-7800-9831-111111111111',
        permissions: ['payment.take', 'order.create', 'kot.update_status'],
      },
    );
  }

  it('prevents distinct offline payment commands from overpaying a bill', async () => {
    const result = await push([
      paymentCommand('offline-a', 7_000),
      paymentCommand('offline-b', 7_000),
    ]);

    expect(result.results.map((entry) => entry.status)).toEqual(['applied', 'conflict']);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].amountPaise).toBe(7_000);
    expect(state.bill.status).toBe('partially_paid');
    expect(state.conflicts).toHaveLength(1);
    expect(state.deadLetters).toHaveLength(0);
  });

  it('acknowledges a concurrent retry with the same idempotency key without a second payment', async () => {
    const [first, retry] = await Promise.all([
      push([paymentCommand('offline-retry', 4_000)]),
      push([paymentCommand('offline-retry', 4_000)]),
    ]);

    expect(first.results[0]?.status).toBe('applied');
    expect(retry.results[0]?.status).toBe('duplicate');
    expect(state.payments).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it('marks a fully paid synced bill and order settled and releases only its linked table', async () => {
    const result = await push([paymentCommand('offline-full', 10_000)]);

    expect(result.results[0]?.status).toBe('applied');
    expect(state.bill.status).toBe('paid');
    expect(state.order.status).toBe('billed');
    expect(state.table.status).toBe('available');
    expect(state.table.currentOrderId).toBeNull();
  });

  it('does not release a table that has since been linked to a different order', async () => {
    state.table.currentOrderId = 'newer-order';

    await push([paymentCommand('offline-full-other-table-order', 10_000)]);

    expect(state.bill.status).toBe('paid');
    expect(state.table.currentOrderId).toBe('newer-order');
    expect(state.table.status).toBe('payment_pending');
  });
});
