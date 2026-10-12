import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb, auth, auditLog } = vi.hoisted(() => ({
  fakeDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  auth: { permissions: [] as string[] },
  auditLog: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({ db: fakeDb }));
vi.mock('../src/auth/middleware.js', () => ({
  requirePermission: () => async (request: any) => {
    request.user = {
      restaurantId: 'restaurant-1',
      userId: 'cashier-1',
      permissions: auth.permissions,
    };
  },
  registerRouteGuard: vi.fn(),
}));
vi.mock('../src/services/audit.js', () => ({ recordAuditLog: auditLog }));
vi.mock('../src/realtime/socket.js', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('../src/services/loyalty.js', () => ({
  processBillPaidLoyaltyEarn: vi.fn(),
  processBillReversalLoyalty: vi.fn(),
  getOrCreateLoyaltySettings: vi.fn(),
  getOrCreateLoyaltyAccount: vi.fn(),
}));

import { billsRoutes } from '../src/routes/bills.js';
import { bills } from '../src/db/schema/bills.js';
import { printEvents } from '../src/db/schema/printers.js';
import { roles } from '../src/db/schema/roles.js';
import { users } from '../src/db/schema/users.js';
import { Permissions } from '@restaurant-os/shared';
import { hashPin } from '../src/auth/crypto.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';

let app: ReturnType<typeof Fastify>;
let billState: {
  id: string;
  restaurantId: string;
  status: string;
  printedCount: number;
  totalPaise: number;
};
let insertedEvents: Array<Record<string, unknown>>;
const ownerId = '018f2a16-7b5e-7abc-8def-0123456789a1';
let ownerRows: Array<{
  id: string;
  name: string;
  restaurantId: string;
  roleId: string;
  roleName: string;
  active: boolean;
  pinHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}>;
let realOwnerPinHash: string;

function selectQuery() {
  let selectedTable: unknown;
  const query: any = {
    from(table: unknown) {
      selectedTable = table;
      return query;
    },
    innerJoin() {
      return query;
    },
    where() {
      return query;
    },
    async limit() {
      if (selectedTable === bills) return [billState];
      if (selectedTable === users) return ownerRows;
      return [];
    },
    then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
      const result =
        selectedTable === bills ? [billState] : selectedTable === users ? ownerRows : [];
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

beforeEach(() => {
  billState = {
    id: 'bill-1',
    restaurantId: 'restaurant-1',
    status: 'paid',
    printedCount: 2,
    totalPaise: 69700,
  };
  insertedEvents = [];
  ownerRows = [
    {
      id: ownerId,
      name: 'Owner User',
      restaurantId: 'restaurant-1',
      roleId: 'role-owner',
      roleName: 'OWNER',
      active: true,
      pinHash: realOwnerPinHash,
      failedAttempts: 0,
      lockedUntil: null,
    },
  ];
  auth.permissions = [];
  auditLog.mockReset();
  fakeDb.select.mockImplementation(selectQuery);
  fakeDb.update.mockImplementation((table: unknown) => {
    const builder: any = {
      set: () => builder,
      where: () => builder,
      returning: async () => {
        if (table === bills) {
          billState = { ...billState, printedCount: billState.printedCount + 1 };
          return [{ printedCount: billState.printedCount }];
        }
        if (table === users) {
          return [{ failedAttempts: 1, lockedUntil: null }];
        }
        return [];
      },
    };
    return builder;
  });
  fakeDb.insert.mockClear();
  fakeDb.transaction.mockImplementation(async (callback: (tx: any) => unknown) => {
    const tx = {
      insert: (table: unknown) => {
        let values: Record<string, unknown>;
        const builder: any = {
          values(data: Record<string, unknown>) {
            values = data;
            return builder;
          },
          onConflictDoNothing() {
            return builder;
          },
          returning: async () => {
            if (table !== printEvents) return [];
            if (insertedEvents.some((event) => event.id === values.id)) return [];
            const event = { ...values, id: values.id || `event-${insertedEvents.length + 1}` };
            insertedEvents.push(event);
            return [event];
          },
        };
        return builder;
      },
      update: (table: unknown) => {
        const builder: any = {
          set: () => builder,
          where: () => builder,
          returning: async () => {
            if (table === bills) {
              billState = { ...billState, printedCount: billState.printedCount + 1 };
              return [{ printedCount: billState.printedCount }];
            }
            if (table === users) {
              return [{ failedAttempts: 1, lockedUntil: null }];
            }
            return [];
          },
        };
        return builder;
      },
      select: () => {
        let selectedTable: unknown;
        const builder: any = {
          from(table: unknown) {
            selectedTable = table;
            return builder;
          },
          where: () => builder,
          limit: async () => (selectedTable === printEvents ? insertedEvents : []),
        };
        return builder;
      },
    };
    return callback(tx);
  });
});

describe('bill receipt print authorization and auditing (mocked database)', () => {
  beforeAll(async () => {
    realOwnerPinHash = await hashPin('1234');
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorateRequest('user', null);
    await app.register(billsRoutes);
    await app.ready();
  });

  afterAll(async () => app.close());

  it('denies a paid-bill reprint before authorization and does not mutate printed count', async () => {
    const response = await app.inject({ method: 'POST', url: '/bills/bill-1/reprint' });

    expect(response.statusCode).toBe(403);
    expect(billState.printedCount).toBe(2);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('pre-authorizes a paid-bill reprint for a user with BILL_REPRINT without changing bill state', async () => {
    auth.permissions = [Permissions.BILL_REPRINT];

    const response = await app.inject({ method: 'POST', url: '/bills/bill-1/reprint' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authorized: true, printedCount: 2 });
    expect(billState).toMatchObject({ status: 'paid', printedCount: 2, totalPaise: 69700 });
  });

  it('allows an initial paid-bill print without elevated reprint permission', async () => {
    billState.printedCount = 0;

    const response = await app.inject({ method: 'POST', url: '/bills/bill-1/reprint' });

    expect(response.statusCode).toBe(200);
    expect(response.json().authorized).toBe(true);
    expect(billState.printedCount).toBe(0);
  });

  it('allows a valid owner PIN override without persisting the PIN', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bills/bill-1/reprint',
      payload: { ownerPin: '1234', approverUserId: ownerId },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(insertedEvents)).not.toContain('1234');
    expect(billState.printedCount).toBe(2);
  });

  it('rejects an invalid owner PIN before any print event or count change', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bills/bill-1/reprint',
      payload: { ownerPin: '9999', approverUserId: ownerId },
    });

    expect(response.statusCode).toBe(403);
    expect(insertedEvents).toHaveLength(0);
    expect(billState.printedCount).toBe(2);
  });

  it('records successful print outcome and increments printed count atomically, without changing bill finances', async () => {
    auth.permissions = [Permissions.BILL_REPRINT];

    const response = await app.inject({
      method: 'POST',
      url: '/bills/bill-1/print-events',
      payload: {
        eventId: '018f2a16-7b5e-7abc-8def-0123456789ab',
        type: 'reprint',
        result: 'success',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(insertedEvents).toHaveLength(1);
    expect(insertedEvents[0]).toMatchObject({ type: 'reprint', result: 'success' });
    expect(billState).toMatchObject({ status: 'paid', printedCount: 3, totalPaise: 69700 });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'bill.reprint' }));
  });

  it('makes ambiguous successful print-event retries idempotent by print-job id', async () => {
    auth.permissions = [Permissions.BILL_REPRINT];
    const payload = {
      eventId: '018f2a16-7b5e-7abc-8def-0123456789ac',
      type: 'reprint',
      result: 'success',
    };

    const first = await app.inject({ method: 'POST', url: '/bills/bill-1/print-events', payload });
    const retry = await app.inject({ method: 'POST', url: '/bills/bill-1/print-events', payload });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(first.json().duplicate).toBe(false);
    expect(retry.json().duplicate).toBe(true);
    expect(insertedEvents).toHaveLength(1);
    expect(billState.printedCount).toBe(3);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it('records failed print outcome without incrementing the successful print count', async () => {
    auth.permissions = [Permissions.BILL_REPRINT];

    const response = await app.inject({
      method: 'POST',
      url: '/bills/bill-1/print-events',
      payload: { type: 'reprint', result: 'failed', error: 'Printer offline' },
    });

    expect(response.statusCode).toBe(201);
    expect(insertedEvents[0]).toMatchObject({
      type: 'reprint',
      result: 'failed',
      error: 'Printer offline',
    });
    expect(billState).toMatchObject({ status: 'paid', printedCount: 2, totalPaise: 69700 });
  });

  it('cannot bypass paid-bill reprint authorization by labeling it as an initial print', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/bills/bill-1/print-events',
      payload: { type: 'print', result: 'success' },
    });

    expect(response.statusCode).toBe(403);
    expect(insertedEvents).toHaveLength(0);
    expect(billState.printedCount).toBe(2);
  });
});
