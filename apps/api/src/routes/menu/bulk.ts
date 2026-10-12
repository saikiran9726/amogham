import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import {
  Permissions,
  bulkVegToggleSchema,
  reorderItemsSchema,
  commitCsvImportSchema,
  csvImportRowSchema,
  AppError,
  generateUuidV7,
  type CsvImportPreviewResponse,
  type CsvImportRowResult,
} from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { menuItems } from '../../db/schema/menu-items.js';
import { menuCategories } from '../../db/schema/menu-categories.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerMenuBulkRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/menu/items/bulk-veg',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'PUT',
    url: '/menu/items/reorder',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/menu/import',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });

  /**
   * POST /menu/items/bulk-veg - Bulk veg/non-veg toggle
   */
  app.post(
    '/menu/items/bulk-veg',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = bulkVegToggleSchema.parse(request.body);

      if (body.itemIds.length === 0) {
        return reply.status(200).send({ success: true, count: 0 });
      }

      await tenant.db
        .update(menuItems)
        .set({ isVeg: body.isVeg, updatedAt: new Date() })
        .where(
          and(
            eq(menuItems.restaurantId, authUser.restaurantId),
            inArray(menuItems.id, body.itemIds),
          ),
        );

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu_item.bulk_veg_toggle',
        entity: 'menu_item',
        entityId: 'bulk',
        after: body,
        request,
      });

      return reply.status(200).send({ success: true, count: body.itemIds.length });
    },
  );

  /**
   * PUT /menu/items/reorder - Reorder menu items
   */
  app.put(
    '/menu/items/reorder',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = reorderItemsSchema.parse(request.body);

      for (let i = 0; i < body.itemIds.length; i++) {
        await tenant.db
          .update(menuItems)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(
            and(
              eq(menuItems.id, body.itemIds[i]!),
              eq(menuItems.restaurantId, authUser.restaurantId),
            ),
          );
      }

      return reply.status(200).send({ success: true });
    },
  );

  /**
   * POST /menu/import - CSV Import
   */
  app.post(
    '/menu/import',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = commitCsvImportSchema.parse(request.body);

      const rawLines = body.csvContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (rawLines.length < 2) {
        throw AppError.badRequest('CSV must contain a header line and at least one data row.');
      }

      const rowResults: CsvImportRowResult[] = [];
      const validRowsToCommit: Array<{
        category: string;
        name: string;
        isVeg: boolean;
        pricePaise: number;
        aliases: string[];
        modifierGroups: string[];
      }> = [];

      for (let i = 1; i < rawLines.length; i++) {
        const line = rawLines[i]!;
        const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));

        const category = cols[0] || '';
        const name = cols[1] || '';
        const vegNonVeg = cols[2] || 'veg';
        const price = cols[3] || '0';
        const aliases = cols[4] || '';
        const modGroups = cols[5] || '';

        const errors: string[] = [];
        let parsedData: {
          category: string;
          name: string;
          vegNonVeg: boolean;
          price: number;
          aliases: string[];
          modifierGroups: string[];
        } | null = null;

        try {
          parsedData = csvImportRowSchema.parse({
            category,
            name,
            vegNonVeg,
            price,
            aliases,
            modifierGroups: modGroups,
          });
        } catch (err: unknown) {
          const zErr = err as { errors?: Array<{ message: string }>; message?: string };
          if (zErr.errors) {
            errors.push(...zErr.errors.map((e) => e.message));
          } else if (zErr.message) {
            errors.push(zErr.message);
          }
        }

        const isValid = errors.length === 0 && parsedData !== null;
        rowResults.push({
          rowNumber: i + 1,
          data: {
            category: parsedData?.category || category,
            name: parsedData?.name || name,
            isVeg: parsedData?.vegNonVeg ?? true,
            pricePaise: parsedData?.price || 0,
            aliases: parsedData?.aliases || [],
            modifierGroups: parsedData?.modifierGroups || [],
          },
          errors,
          isValid,
        });

        if (isValid && parsedData) {
          validRowsToCommit.push({
            category: parsedData.category,
            name: parsedData.name,
            isVeg: parsedData.vegNonVeg,
            pricePaise: parsedData.price,
            aliases: parsedData.aliases,
            modifierGroups: parsedData.modifierGroups,
          });
        }
      }

      const totalRows = rowResults.length;
      const validRows = rowResults.filter((r) => r.isValid).length;
      const invalidRows = totalRows - validRows;

      if (body.dryRun) {
        const previewResponse: CsvImportPreviewResponse = {
          totalRows,
          validRows,
          invalidRows,
          preview: rowResults,
        };
        return reply.status(200).send(previewResponse);
      }

      if (validRowsToCommit.length === 0) {
        throw AppError.badRequest('No valid rows found in CSV import.');
      }

      const categoryMap = new Map<string, string>();
      const existingCategories = await tenant.db
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.restaurantId, authUser.restaurantId));

      for (const cat of existingCategories) {
        categoryMap.set(cat.name.toLowerCase(), cat.id);
      }

      for (const row of validRowsToCommit) {
        const lowerCat = row.category.toLowerCase();
        if (!categoryMap.has(lowerCat)) {
          const newCatId = generateUuidV7();
          await tenant.db.insert(menuCategories).values({
            id: newCatId,
            restaurantId: authUser.restaurantId,
            name: row.category,
            sortOrder: categoryMap.size,
          });
          categoryMap.set(lowerCat, newCatId);
        }
      }

      let createdCount = 0;
      for (const row of validRowsToCommit) {
        const categoryId = categoryMap.get(row.category.toLowerCase())!;
        const itemId = generateUuidV7();

        await tenant.db.insert(menuItems).values({
          id: itemId,
          restaurantId: authUser.restaurantId,
          categoryId,
          name: row.name,
          isVeg: row.isVeg,
          pricePaise: row.pricePaise,
          aliases: row.aliases,
          taxRateBp: 500,
          active: true,
          available: true,
        });
        createdCount++;
      }

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu.import_csv',
        entity: 'menu_items',
        entityId: 'bulk',
        after: { totalImported: createdCount },
        request,
      });

      return reply.status(200).send({
        success: true,
        importedCount: createdCount,
        skippedCount: invalidRows,
      });
    },
  );
}
