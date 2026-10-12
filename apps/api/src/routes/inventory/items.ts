import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InventoryService } from '../../services/inventory.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import {
  Permissions,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  recordStockCountSchema,
  commitInventoryCsvImportSchema,
} from '@restaurant-os/shared';

export async function registerInventoryItemRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/items',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/items',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/items/:id',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/inventory/items/:id',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/stock-count',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/reorder',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/import-csv',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/verify-consistency',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });

  app.get(
    '/inventory/items',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const query = request.query as { lowStockOnly?: string; search?: string };

      const items = await InventoryService.listInventoryItems({
        restaurantId,
        lowStockOnly: query.lowStockOnly === 'true',
        search: query.search,
      });

      return { items };
    },
  );

  app.get(
    '/inventory/items/:id',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const { id } = request.params as { id: string };

      const detail = await InventoryService.getInventoryItemDetail(restaurantId, id);
      return detail;
    },
  );

  app.post(
    '/inventory/items',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { restaurantId, userId } = request.user!;
      const body = createInventoryItemSchema.parse(request.body);

      const item = await InventoryService.createInventoryItem(restaurantId, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.item_created',
        entity: 'inventory_item',
        entityId: item.id,
        after: item as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ item });
    },
  );

  app.patch(
    '/inventory/items/:id',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId, userId } = request.user!;
      const { id } = request.params as { id: string };
      const body = updateInventoryItemSchema.parse(request.body);

      const updated = await InventoryService.updateInventoryItem(restaurantId, id, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.item_updated',
        entity: 'inventory_item',
        entityId: id,
        after: updated as unknown as Record<string, unknown>,
        request,
      });

      return { item: updated };
    },
  );

  app.post(
    '/inventory/stock-count',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId, userId } = request.user!;
      const body = recordStockCountSchema.parse(request.body);

      const summary = await InventoryService.recordStockCount(restaurantId, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.stock_count_recorded',
        entity: 'stock_count',
        entityId: restaurantId,
        after: { counts: summary } as Record<string, unknown>,
        request,
      });

      return { summary };
    },
  );

  app.get(
    '/inventory/reorder',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const reorderItems = await InventoryService.getReorderList(restaurantId);
      return { reorderItems };
    },
  );

  app.post(
    '/inventory/import-csv',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId, userId } = request.user!;
      const body = commitInventoryCsvImportSchema.parse(request.body);

      const result = await InventoryService.commitCsvImport(restaurantId, userId, body.rows);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.csv_imported',
        entity: 'inventory_import',
        entityId: restaurantId,
        after: result as unknown as Record<string, unknown>,
        request,
      });

      return result;
    },
  );

  app.get(
    '/inventory/verify-consistency',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const check = await InventoryService.verifyStockConsistency(restaurantId);
      return check;
    },
  );
}
