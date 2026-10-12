import type { FastifyInstance } from 'fastify';
import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import crypto from 'node:crypto';
import { Permissions, serializeMenuForRole } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { menuItems, itemModifierGroups } from '../../db/schema/menu-items.js';
import { menuCategories } from '../../db/schema/menu-categories.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';

export async function registerMenuQueryRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/menu',
    isPublic: false,
    permission: Permissions.MENU_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/menu/search',
    isPublic: false,
    permission: Permissions.MENU_READ,
  });

  /**
   * GET /menu - Fetch menu for Waiter / Kitchen / Owner with ETag and role shaping
   */
  app.get(
    '/menu',
    { preHandler: [requirePermission(Permissions.MENU_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      // Fetch active categories
      const categories = await tenant.db
        .select()
        .from(menuCategories)
        .where(
          and(
            eq(menuCategories.restaurantId, authUser.restaurantId),
            eq(menuCategories.active, true),
          ),
        )
        .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name));

      // Fetch active items with their category name
      const items = await tenant.db
        .select({
          id: menuItems.id,
          categoryId: menuItems.categoryId,
          categoryName: menuCategories.name,
          name: menuItems.name,
          aliases: menuItems.aliases,
          isVeg: menuItems.isVeg,
          pricePaise: menuItems.pricePaise,
          available: menuItems.available,
          oosReason: menuItems.oosReason,
          sortOrder: menuItems.sortOrder,
          version: menuItems.version,
          updatedAt: menuItems.updatedAt,
        })
        .from(menuItems)
        .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
        .where(
          and(
            eq(menuItems.restaurantId, authUser.restaurantId),
            eq(menuItems.active, true),
            eq(menuCategories.active, true),
          ),
        )
        .orderBy(asc(menuCategories.sortOrder), asc(menuItems.sortOrder), asc(menuItems.name));

      // Fetch item modifier group links
      const itemIds = items.map((i) => i.id);
      const modifierGroupMap = new Map<string, string[]>();
      if (itemIds.length > 0) {
        const joins = await tenant.db
          .select({
            itemId: itemModifierGroups.itemId,
            modifierGroupId: itemModifierGroups.modifierGroupId,
          })
          .from(itemModifierGroups)
          .where(inArray(itemModifierGroups.itemId, itemIds));

        for (const j of joins) {
          const list = modifierGroupMap.get(j.itemId) || [];
          list.push(j.modifierGroupId);
          modifierGroupMap.set(j.itemId, list);
        }
      }

      const shapedItems = items.map((i) => ({
        ...i,
        modifierGroupIds: modifierGroupMap.get(i.id) || [],
      }));

      // Apply per-role data shaping (Kitchen role NEVER receives pricePaise)
      const sanitizedItems = serializeMenuForRole(shapedItems, authUser.role);

      const payload = {
        categories,
        items: sanitizedItems,
      };

      // Compute ETag for cheap client revalidation
      const contentHash = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
      const etag = `"${contentHash}"`;

      reply.header('ETag', etag);

      const clientEtag = request.headers['if-none-match'];
      if (clientEtag && clientEtag === etag) {
        return reply.status(304).send();
      }

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /menu/search?q=&veg=true - High-speed trigram/alias menu search with ranked results
   */
  app.get(
    '/menu/search',
    { preHandler: [requirePermission(Permissions.MENU_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const query = request.query as { q?: string; veg?: string };
      const q = (query.q || '').trim();
      const vegFilter = query.veg === 'true' ? true : query.veg === 'false' ? false : undefined;

      if (!q) {
        return reply.status(200).send({ items: [] });
      }

      const sanitizedQ = q.replace(/[%_]/g, '');

      const searchConditions = [
        eq(menuItems.restaurantId, authUser.restaurantId),
        eq(menuItems.active, true),
        eq(menuCategories.active, true),
      ];

      if (vegFilter !== undefined) {
        searchConditions.push(eq(menuItems.isVeg, vegFilter));
      }

      const rows = await tenant.db
        .select({
          id: menuItems.id,
          categoryId: menuItems.categoryId,
          categoryName: menuCategories.name,
          name: menuItems.name,
          aliases: menuItems.aliases,
          isVeg: menuItems.isVeg,
          pricePaise: menuItems.pricePaise,
          available: menuItems.available,
          oosReason: menuItems.oosReason,
          sortOrder: menuItems.sortOrder,
          rank: sql<number>`
            CASE
              WHEN lower(${menuItems.name}) = lower(${sanitizedQ}) THEN 100
              WHEN lower(${menuItems.name}) LIKE lower(${sanitizedQ || ''} || '%') THEN 80
              WHEN ${sanitizedQ} = ANY(lower(${menuItems.aliases}::text)::text[]) THEN 75
              WHEN lower(${menuItems.name}) LIKE lower('%' || ${sanitizedQ || ''} || '%') THEN 60
              WHEN similarity(${menuItems.name}, ${sanitizedQ}) > 0.25 THEN (similarity(${menuItems.name}, ${sanitizedQ}) * 50)::int
              WHEN similarity(array_to_string(${menuItems.aliases}, ' '), ${sanitizedQ}) > 0.25 THEN (similarity(array_to_string(${menuItems.aliases}, ' '), ${sanitizedQ}) * 45)::int
              ELSE 0
            END
          `,
        })
        .from(menuItems)
        .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
        .where(
          and(
            ...searchConditions,
            sql`(
              lower(${menuItems.name}) LIKE lower('%' || ${sanitizedQ} || '%')
              OR array_to_string(${menuItems.aliases}, ' ') ILIKE ('%' || ${sanitizedQ} || '%')
              OR similarity(${menuItems.name}, ${sanitizedQ}) > 0.2
              OR similarity(array_to_string(${menuItems.aliases}, ' '), ${sanitizedQ}) > 0.2
            )`,
          ),
        )
        .orderBy(desc(sql`rank`), asc(menuItems.name))
        .limit(50);

      const filtered = rows.filter((r) => r.rank > 0);
      const shaped = serializeMenuForRole(filtered, authUser.role);

      return reply.status(200).send({ items: shaped });
    },
  );
}
