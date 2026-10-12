import type { FastifyInstance } from 'fastify';
import { eq, and, sql, inArray, or } from 'drizzle-orm';
import { Permissions, generateUuidV7 } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { menuItems, itemModifierGroups } from '../../db/schema/menu-items.js';
import { menuCategories } from '../../db/schema/menu-categories.js';
import { orderItems } from '../../db/schema/orders.js';
import { billLines } from '../../db/schema/bills.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';
import { recordAuditLog } from '../../services/audit.js';

export async function registerMenuSampleRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/menu/seed-sample',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });
  registerRouteGuard({
    method: 'DELETE',
    url: '/menu/clear-sample',
    isPublic: false,
    permission: Permissions.MENU_MANAGE,
  });

  /**
   * POST /menu/seed-sample - Load sample Indian restaurant menu
   */
  app.post(
    '/menu/seed-sample',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const sampleCategories = [
        { name: 'Biryani (Sample)', desc: 'Fragrant dum biryanis' },
        { name: 'Starters (Sample)', desc: 'Crispy and savory appetizers' },
        { name: 'Kebabs & Tandoor (Sample)', desc: 'Clay oven specials' },
        { name: 'Main Course (Sample)', desc: 'Traditional gravies and curries' },
        { name: 'Breads (Sample)', desc: 'Tandoori rotis and naans' },
        { name: 'Drinks (Sample)', desc: 'Coolers and beverages' },
        { name: 'Desserts (Sample)', desc: 'Sweet treats' },
      ];

      const sampleItems = [
        {
          cat: 'Biryani (Sample)',
          name: 'Hyderabadi Dum Biryani',
          veg: false,
          price: 34000,
          aliases: ['biryani', 'biriyani', 'briyani', 'mutton biryani'],
        },
        {
          cat: 'Biryani (Sample)',
          name: 'Paneer Tikka Biryani',
          veg: true,
          price: 28000,
          aliases: ['veg biryani', 'paneer biryani'],
        },
        {
          cat: 'Starters (Sample)',
          name: 'Crispy Corn Salt & Pepper',
          veg: true,
          price: 21000,
          aliases: ['corn', 'crispy corn'],
        },
        {
          cat: 'Starters (Sample)',
          name: 'Chicken 65',
          veg: false,
          price: 26000,
          aliases: ['chilli chicken', 'chicken sixty five'],
        },
        {
          cat: 'Kebabs & Tandoor (Sample)',
          name: 'Murgh Malai Tikka',
          veg: false,
          price: 32000,
          aliases: ['malai tikka', 'chicken tikka'],
        },
        {
          cat: 'Kebabs & Tandoor (Sample)',
          name: 'Dahi Ke Kebab',
          veg: true,
          price: 24000,
          aliases: ['dahi kabab', 'hung curd kebab'],
        },
        {
          cat: 'Main Course (Sample)',
          name: 'Butter Chicken Masala',
          veg: false,
          price: 36000,
          aliases: ['murgh makhani', 'butter chicken'],
        },
        {
          cat: 'Main Course (Sample)',
          name: 'Paneer Butter Masala',
          veg: true,
          price: 29000,
          aliases: ['pbm', 'paneer makhani'],
        },
        {
          cat: 'Main Course (Sample)',
          name: 'Dal Makhani',
          veg: true,
          price: 23000,
          aliases: ['black dal', 'maa ki dal'],
        },
        {
          cat: 'Breads (Sample)',
          name: 'Butter Naan',
          veg: true,
          price: 6000,
          aliases: ['naan', 'butter roti'],
        },
        {
          cat: 'Breads (Sample)',
          name: 'Garlic Roti',
          veg: true,
          price: 5000,
          aliases: ['lasooni roti'],
        },
        {
          cat: 'Drinks (Sample)',
          name: 'Mango Lassi',
          veg: true,
          price: 12000,
          aliases: ['sweet lassi', 'lassi'],
        },
        {
          cat: 'Drinks (Sample)',
          name: 'Fresh Lime Soda',
          veg: true,
          price: 8000,
          aliases: ['nimbu soda', 'lime water'],
        },
        {
          cat: 'Desserts (Sample)',
          name: 'Gulab Jamun (2 pcs)',
          veg: true,
          price: 11000,
          aliases: ['jamun', 'sweet'],
        },
      ];

      const categoryMap = new Map<string, string>();

      await tenant.withTx(async (_tenantTx, tx) => {
        const catRows = sampleCategories.map((c, i) => {
          const catId = generateUuidV7();
          categoryMap.set(c.name, catId);
          return {
            id: catId,
            restaurantId: authUser.restaurantId,
            name: c.name,
            description: c.desc,
            sortOrder: i,
            active: true,
            isSample: true,
          };
        });

        await tx.insert(menuCategories).values(catRows);

        const itemRows = sampleItems.map((item, j) => ({
          id: generateUuidV7(),
          restaurantId: authUser.restaurantId,
          categoryId: categoryMap.get(item.cat)!,
          name: item.name,
          aliases: item.aliases,
          isVeg: item.veg,
          pricePaise: item.price,
          taxRateBp: 500,
          sortOrder: j,
          available: true,
          active: true,
          isSample: true,
        }));

        await tx.insert(menuItems).values(itemRows);
      });

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu.seed_sample',
        entity: 'menu',
        entityId: 'sample',
        after: { categoriesCount: sampleCategories.length, itemsCount: sampleItems.length },
        request,
      });

      return reply.status(200).send({
        success: true,
        message: 'Sample Indian restaurant menu loaded successfully (Sample data, edit freely).',
      });
    },
  );

  /**
   * DELETE /menu/clear-sample - Clear all sample data in one single action
   */
  app.delete(
    '/menu/clear-sample',
    { preHandler: [requirePermission(Permissions.MENU_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      const result = await tenant.withTx(async (_tenantTx, tx) => {
        const sampleCats = await tx
          .select({ id: menuCategories.id })
          .from(menuCategories)
          .where(
            and(
              eq(menuCategories.restaurantId, authUser.restaurantId),
              or(
                eq(menuCategories.isSample, true),
                sql`lower(${menuCategories.name}) LIKE '%(sample)%'`,
              ),
            ),
          );

        const catIds = sampleCats.map((c) => c.id);

        const itemFilter = [eq(menuItems.restaurantId, authUser.restaurantId)];
        if (catIds.length > 0) {
          itemFilter.push(
            or(
              eq(menuItems.isSample, true),
              inArray(menuItems.categoryId, catIds),
              sql`lower(${menuItems.name}) LIKE '%(sample)%'`,
            )!,
          );
        } else {
          itemFilter.push(
            or(eq(menuItems.isSample, true), sql`lower(${menuItems.name}) LIKE '%(sample)%'`)!,
          );
        }

        const sampleItemList = await tx
          .select({ id: menuItems.id, categoryId: menuItems.categoryId })
          .from(menuItems)
          .where(and(...itemFilter));

        const itemIds = sampleItemList.map((i) => i.id);
        const referencedItemIds = new Set<string>();

        if (itemIds.length > 0) {
          const orderRefs = await tx
            .select({ itemId: orderItems.itemId })
            .from(orderItems)
            .where(inArray(orderItems.itemId, itemIds));
          for (const r of orderRefs) referencedItemIds.add(r.itemId);

          const billRefs = await tx
            .select({ itemId: billLines.itemId })
            .from(billLines)
            .where(inArray(billLines.itemId, itemIds));
          for (const r of billRefs) referencedItemIds.add(r.itemId);
        }

        const itemsToSoftDelete = sampleItemList.filter((i) => referencedItemIds.has(i.id));
        const itemsToHardDelete = sampleItemList.filter((i) => !referencedItemIds.has(i.id));

        if (itemsToSoftDelete.length > 0) {
          const softIds = itemsToSoftDelete.map((i) => i.id);
          await tx
            .update(menuItems)
            .set({ active: false, available: false, updatedAt: new Date() })
            .where(inArray(menuItems.id, softIds));
        }

        if (itemsToHardDelete.length > 0) {
          const hardIds = itemsToHardDelete.map((i) => i.id);
          await tx.delete(itemModifierGroups).where(inArray(itemModifierGroups.itemId, hardIds));
          await tx.delete(menuItems).where(inArray(menuItems.id, hardIds));
        }

        const softDeletedCategoryIds = new Set(itemsToSoftDelete.map((i) => i.categoryId));
        const categoriesToSoftDelete = catIds.filter((cid) => softDeletedCategoryIds.has(cid));
        const categoriesToHardDelete = catIds.filter((cid) => !softDeletedCategoryIds.has(cid));

        if (categoriesToSoftDelete.length > 0) {
          await tx
            .update(menuCategories)
            .set({ active: false, updatedAt: new Date() })
            .where(inArray(menuCategories.id, categoriesToSoftDelete));
        }

        if (categoriesToHardDelete.length > 0) {
          await tx.delete(menuCategories).where(inArray(menuCategories.id, categoriesToHardDelete));
        }

        return {
          clearedCategoriesCount: catIds.length,
          softDeletedCount: itemsToSoftDelete.length,
          hardDeletedCount: itemsToHardDelete.length,
        };
      });

      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'menu.clear_sample',
        entity: 'menu',
        entityId: 'sample',
        after: result,
        request,
      });

      return reply.status(200).send({
        success: true,
        ...result,
      });
    },
  );
}
