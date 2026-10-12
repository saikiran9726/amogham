import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InventoryService } from '../../services/inventory.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';
import {
  Permissions,
  createSupplierSchema,
  createPurchaseSchema,
  updatePurchaseSchema,
  recordUsageSchema,
  recordWasteSchema,
} from '@restaurant-os/shared';

export async function registerInventoryPurchaseRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/suppliers',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/suppliers',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/inventory/purchases',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/purchases',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/inventory/purchases/:id',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/usage',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/inventory/waste',
    isPublic: false,
    permission: Permissions.INVENTORY_MANAGE,
  });

  // Suppliers
  app.get(
    '/inventory/suppliers',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const suppliers = await InventoryService.listSuppliers(restaurantId);
      return { suppliers };
    },
  );

  app.post(
    '/inventory/suppliers',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { restaurantId, userId } = request.user!;
      const body = createSupplierSchema.parse(request.body);

      const supplier = await InventoryService.createSupplier(restaurantId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.supplier_created',
        entity: 'supplier',
        entityId: supplier.id,
        after: supplier as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ supplier });
    },
  );

  // Purchases
  app.get(
    '/inventory/purchases',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId } = request.user!;
      const query = request.query as {
        supplierId?: string;
        paidStatus?: 'paid' | 'unpaid' | 'partial';
      };

      const purchases = await InventoryService.listPurchases({
        restaurantId,
        supplierId: query.supplierId,
        paidStatus: query.paidStatus,
      });

      return { purchases };
    },
  );

  app.post(
    '/inventory/purchases',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { restaurantId, userId } = request.user!;
      const body = createPurchaseSchema.parse(request.body);

      const purchase = await InventoryService.createPurchase(restaurantId, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.purchase_recorded',
        entity: 'purchase',
        entityId: purchase.id,
        after: purchase as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ purchase });
    },
  );

  app.patch(
    '/inventory/purchases/:id',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest) => {
      const { restaurantId, userId } = request.user!;
      const { id } = request.params as { id: string };
      const body = updatePurchaseSchema.parse(request.body);

      const updated = await InventoryService.updatePurchase(restaurantId, id, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.purchase_updated',
        entity: 'purchase',
        entityId: id,
        after: updated as unknown as Record<string, unknown>,
        request,
      });

      return { purchase: updated };
    },
  );

  // Usage & Waste
  app.post(
    '/inventory/usage',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { restaurantId, userId } = request.user!;
      const body = recordUsageSchema.parse(request.body);

      const movement = await InventoryService.recordUsage(restaurantId, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.usage_recorded',
        entity: 'stock_movement',
        entityId: movement.id,
        after: movement as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ movement });
    },
  );

  app.post(
    '/inventory/waste',
    { preHandler: [requirePermission(Permissions.INVENTORY_MANAGE)] },
    async (request: FastifyRequest, reply) => {
      const { restaurantId, userId } = request.user!;
      const body = recordWasteSchema.parse(request.body);

      const movement = await InventoryService.recordWaste(restaurantId, userId, body);

      await recordAuditLog({
        restaurantId,
        userId,
        action: 'inventory.waste_recorded',
        entity: 'stock_movement',
        entityId: movement.id,
        after: movement as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ movement });
    },
  );
}
