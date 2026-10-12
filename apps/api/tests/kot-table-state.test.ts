import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb, emitRealtimeEvent } = vi.hoisted(() => ({
  fakeDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
  emitRealtimeEvent: vi.fn(),
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
import { orders } from '../src/db/schema/orders.js';
import { kots, kotItems } from '../src/db/schema/kots.js';
import { tables } from '../src/db/schema/tables.js';

type Fixture = {
  order: { id: string; status: string; tableId: string };
  table: { id: string; status: string; currentOrderId: string | null };
  kot: { id: string; orderId: string; restaurantId: string; status: string; kotNumber: number };
  kotItem: { id: string; kotId: string; action: string; status: string };
};

let fixture: Fixture;
let app: ReturnType<typeof Fastify>;

function selectRows(table: unknown): any[] {
  if (table === orders) return [fixture.order];
  if (table === tables) return [fixture.table];
  if (table === kots) return [fixture.kot];
  if (table === kotItems) return [fixture.kotItem];
  return [];
}

function selectQuery(projection?: Record<string, unknown>) {
  let selectedTable: unknown;
  const projectedRows = () =>
    selectRows(selectedTable).map((row) => {
      if (!projection) return row;
      return Object.fromEntries(Object.keys(projection).map((key) => [key, row[key]]));
    });
  const query: any = {
    from(table: unknown) {
      selectedTable = table;
      return query;
    },
    where() {
      return query;
    },
    for() {
      return query;
    },
    limit() {
      return Promise.resolve(projectedRows());
    },
    then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve(projectedRows()).then(resolve, reject);
    },
  };
  return query;
}

function updateQuery(table: unknown) {
  let values: Record<string, unknown> = {};
  const apply = () => {
    if (table === kots) Object.assign(fixture.kot, values);
    if (table === orders) Object.assign(fixture.order, values);
    if (table === tables && fixture.table.currentOrderId === fixture.order.id) {
      Object.assign(fixture.table, values);
    }
    return table === kots ? [fixture.kot] : [];
  };
  const query: any = {
    set(data: Record<string, unknown>) {
      values = data;
      return query;
    },
    where() {
      return query;
    },
    returning() {
      return Promise.resolve(apply());
    },
    then(resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) {
      return Promise.resolve(apply()).then(resolve, reject);
    },
  };
  return query;
}

describe('KOT status synchronization and table ownership (isolated database mock)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorateRequest('user', null);
    await registerKotRoutes(app);
    await app.ready();
  });

  beforeEach(() => {
    fixture = {
      order: { id: 'order-1', status: 'saved', tableId: 'table-1' },
      table: { id: 'table-1', status: 'occupied', currentOrderId: 'order-1' },
      kot: {
        id: 'kot-1',
        orderId: 'order-1',
        restaurantId: 'restaurant-1',
        status: 'ready',
        kotNumber: 7,
      },
      kotItem: { id: 'kot-item-1', kotId: 'kot-1', action: 'add', status: 'done' },
    };
    fakeDb.select.mockImplementation(selectQuery);
    fakeDb.update.mockImplementation(updateQuery);
    emitRealtimeEvent.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  async function markKotServed() {
    return app.inject({
      method: 'PATCH',
      url: '/kots/kot-1/status',
      payload: { status: 'served' },
    });
  }

  async function markKotReady() {
    return app.inject({
      method: 'PATCH',
      url: '/kots/kot-1/status',
      payload: { status: 'ready' },
    });
  }

  it('persists a ready KOT as a ready order and emits the waiter-facing event', async () => {
    fixture.kot.status = 'preparing';
    fixture.kotItem.status = 'done';
    fixture.order.status = 'preparing';
    fixture.table.status = 'preparing';

    const response = await markKotReady();

    expect(response.statusCode).toBe(200);
    expect(fixture.kot.status).toBe('ready');
    expect(fixture.order.status).toBe('ready');
    expect(fixture.table.status).toBe('ready');
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'restaurant-1',
      'kot.statusChanged',
      { kotId: 'kot-1', orderId: 'order-1', kotNumber: 7, status: 'ready' },
      'all',
    );
  });

  it('does not revive a released table for a billed order', async () => {
    fixture.order.status = 'billed';
    fixture.table.status = 'available';
    fixture.table.currentOrderId = null;

    const response = await markKotServed();

    expect(response.statusCode).toBe(200);
    expect(fixture.kot.status).toBe('served');
    expect(fixture.table).toEqual({
      id: 'table-1',
      status: 'available',
      currentOrderId: null,
    });
    expect(emitRealtimeEvent).not.toHaveBeenCalledWith(
      'restaurant-1',
      'table.statusChanged',
      expect.anything(),
      'all',
    );
  });

  it('does not change a table now linked to another order', async () => {
    fixture.table.status = 'preparing';
    fixture.table.currentOrderId = 'order-2';

    const response = await markKotServed();

    expect(response.statusCode).toBe(200);
    expect(fixture.kot.status).toBe('served');
    expect(fixture.table).toEqual({
      id: 'table-1',
      status: 'preparing',
      currentOrderId: 'order-2',
    });
    expect(emitRealtimeEvent).not.toHaveBeenCalledWith(
      'restaurant-1',
      'table.statusChanged',
      expect.anything(),
      'all',
    );
  });

  it('keeps the existing served behavior for an active order that still owns the table', async () => {
    fixture.table.status = 'ready';

    const response = await markKotServed();

    expect(response.statusCode).toBe(200);
    expect(fixture.kot.status).toBe('served');
    expect(fixture.table.status).toBe('occupied');
    expect(fixture.table.currentOrderId).toBe('order-1');
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'restaurant-1',
      'table.statusChanged',
      { tableId: 'table-1', status: 'occupied' },
      'all',
    );
  });
});
