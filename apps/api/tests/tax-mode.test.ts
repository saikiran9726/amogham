import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { select, insert, update, queryLimit, registerRouteGuard } = vi.hoisted(() => {
  const queryLimit = vi.fn();
  const select = vi.fn(() => {
    const query: Record<string, any> = {};
    query.from = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.limit = queryLimit;
    return query;
  });
  return {
    select,
    insert: vi.fn(),
    update: vi.fn(),
    queryLimit,
    registerRouteGuard: vi.fn(),
  };
});

vi.mock('../src/db/client.js', () => ({ db: { select, insert, update } }));
vi.mock('../src/db/schema/restaurant-settings.js', () => ({
  restaurantSettings: { restaurantId: 'restaurant_id', taxMode: 'tax_mode' },
}));
vi.mock('../src/db/schema/restaurants.js', () => ({ restaurants: { id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: (column: unknown, value: unknown) => ({ column, value }) }));
vi.mock('../src/auth/middleware.js', () => ({
  registerRouteGuard,
  requirePermission: () => async (request: any) => {
    request.user = { restaurantId: 'test-restaurant' };
  },
}));
vi.mock('../src/services/audit.js', () => ({ recordAuditLog: vi.fn() }));

import { Permissions } from '@restaurant-os/shared';
import { registerSettingsRoutes } from '../src/routes/settings.js';

describe('GET /restaurant/tax-mode', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await registerSettingsRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the API exclusive default without creating a settings row', async () => {
    queryLimit.mockResolvedValue([]);

    const response = await app.inject({ method: 'GET', url: '/restaurant/tax-mode' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ taxMode: 'exclusive' });
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['inclusive', 'exclusive'] as const)(
    'returns an explicitly configured %s mode',
    async (taxMode) => {
      queryLimit.mockResolvedValue([{ taxMode }]);

      const response = await app.inject({ method: 'GET', url: '/restaurant/tax-mode' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ taxMode });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('registers the endpoint for the waiter-readable order permission', () => {
    expect(registerRouteGuard).toHaveBeenCalledWith({
      method: 'GET',
      url: '/restaurant/tax-mode',
      isPublic: false,
      permission: Permissions.ORDER_READ,
    });
  });
});
