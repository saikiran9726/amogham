import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb, fakeTx, emitRealtimeEvent, cachedCommands, insertedCommands } = vi.hoisted(() => ({
  fakeDb: { select: vi.fn(), transaction: vi.fn(), execute: vi.fn(() => Promise.resolve([])) },
  fakeTx: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(() => Promise.resolve([])),
  },
  emitRealtimeEvent: vi.fn(),
  cachedCommands: [] as Array<Record<string, unknown>>,
  insertedCommands: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../src/auth/middleware.js', () => ({
  requirePermission: () => async (request: any) => {
    request.user = { restaurantId: 'restaurant-1', userId: 'waiter-1', role: 'WAITER' };
  },
  registerRouteGuard: vi.fn(),
}));
vi.mock('../src/services/audit.js', () => ({ recordAuditLog: vi.fn() }));
vi.mock('../src/realtime/socket.js', () => ({ emitRealtimeEvent }));

import { registerKotRoutes } from '../src/routes/kots.js';
import { orders, orderItems, syncCommands } from '../src/db/schema/orders.js';
import { kots, kotItems } from '../src/db/schema/kots.js';

const existingOrder = {
  id: '018f9e1e-2895-7800-9831-000000000001',
  restaurantId: 'restaurant-1',
  tableId: null,
  status: 'saved',
};
const existingOrderItem = {
  id: '018f9e1e-2895-7800-9831-000000000002',
  orderId: existingOrder.id,
  itemId: '018f9e1e-2895-7800-9831-000000000003',
  nameSnapshot: 'Test dish',
  qty: 1,
  status: 'active',
  kotState: 'sent',
  note: null,
};
const existingKot = {
  id: '018f9e1e-2895-7800-9831-000000000004',
  orderId: existingOrder.id,
  restaurantId: 'restaurant-1',
  kotNumber: 7,
  type: 'new',
  status: 'ready',
  createdAt: new Date('2026-10-11T10:00:00.000Z'),
};
const existingKotItem = {
  id: '018f9e1e-2895-7800-9831-000000000005',
  kotId: existingKot.id,
  orderItemId: existingOrderItem.id,
  qty: 1,
  action: 'add',
  status: 'done',
};

let app: ReturnType<typeof Fastify>;
let transactionCount: number;
let insertKotCount: number;
let orderLockRequested: boolean;

function selectQuery(rowsFor: (table: unknown) => unknown[]) {
  let table: unknown;
  const query: any = {
    from(value: unknown) {
      table = value;
      return query;
    },
    where() {
      return query;
    },
    for(mode: string) {
      if (table === orders && mode === 'update') orderLockRequested = true;
      return query;
    },
    limit() {
      return Promise.resolve(rowsFor(table));
    },
    then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve(rowsFor(table)).then(resolve, reject);
    },
  };
  return query;
}

describe('KOT duplicate submission protection (isolated database mock)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    await registerKotRoutes(app);
    await app.ready();
  });

  beforeEach(() => {
    cachedCommands.length = 0;
    insertedCommands.length = 0;
    transactionCount = 0;
    insertKotCount = 0;
    orderLockRequested = false;
    emitRealtimeEvent.mockClear();

    fakeDb.select.mockImplementation(() =>
      selectQuery((table) => (table === syncCommands ? cachedCommands : [])),
    );
    fakeDb.transaction.mockImplementation(async (run: (tx: typeof fakeTx) => Promise<unknown>) => {
      transactionCount += 1;
      return run(fakeTx);
    });
    fakeTx.select.mockImplementation(() =>
      selectQuery((table) => {
        if (table === orders) return [existingOrder];
        if (table === orderItems) return [existingOrderItem];
        if (table === kots) return [existingKot];
        if (table === kotItems) return [existingKotItem];
        if (table === syncCommands) return cachedCommands;
        return [];
      }),
    );
    fakeTx.insert.mockImplementation((table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === kots) insertKotCount += 1;
        if (table === syncCommands) {
          insertedCommands.push(value);
          cachedCommands.push(value);
        }
        return { returning: async () => [] };
      },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  const sendDuplicate = (key: string) =>
    app.inject({
      method: 'POST',
      url: `/orders/${existingOrder.id}/kots`,
      headers: { 'idempotency-key': key },
      payload: { provisionalLabel: 'P-0007' },
    });

  it('acknowledges a repeated KOT without inserting another KOT or notifying kitchen as new', async () => {
    const response = await sendDuplicate('duplicate-kot-request-1');
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ success: true, duplicate: true, kot: { id: existingKot.id } });
    expect(body.kot.items).toEqual([existingKotItem]);
    expect(orderLockRequested).toBe(true);
    expect(insertKotCount).toBe(0);
    expect(insertedCommands).toHaveLength(1);
    expect(transactionCount).toBe(1);
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('replays the cached acknowledgment for a retry with the same idempotency key', async () => {
    const key = 'duplicate-kot-request-2';
    const first = await sendDuplicate(key);
    const second = await sendDuplicate(key);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Each request now enters a transaction to take pg_advisory_xact_lock and safely check/replay idempotency
    expect(transactionCount).toBe(2);
    expect(insertKotCount).toBe(0);
    expect(insertedCommands).toHaveLength(1);
  });
});
