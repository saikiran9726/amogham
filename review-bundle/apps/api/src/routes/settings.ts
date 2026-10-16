import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Permissions, updateRestaurantSettingsSchema, generateUuidV7 } from '@restaurant-os/shared';
import { forTenant } from '../db/tenant.js';
import { restaurantSettings } from '../db/schema/restaurant-settings.js';
import { restaurants } from '../db/schema/restaurants.js';
import { requirePermission, registerRouteGuard } from '../auth/middleware.js';
import { recordAuditLog } from '../services/audit.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/settings',
    isPublic: false,
    permission: Permissions.SETTINGS_MANAGE,
  });
  registerRouteGuard({
    method: 'PUT',
    url: '/settings',
    isPublic: false,
    permission: Permissions.SETTINGS_MANAGE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/restaurant/tax-mode',
    isPublic: false,
    permission: Permissions.ORDER_READ,
  });

  /**
   * GET /restaurant/tax-mode - Read effective tax mode without initializing settings.
   */
  app.get(
    '/restaurant/tax-mode',
    { preHandler: [requirePermission(Permissions.ORDER_READ)] },
    async (request, reply) => {
      const tenant = forTenant(request.user!.restaurantId);
      const [settings] = await tenant.db
        .select({ taxMode: restaurantSettings.taxMode })
        .from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, request.user!.restaurantId))
        .limit(1);

      return reply.status(200).send({
        taxMode: settings?.taxMode === 'inclusive' ? 'inclusive' : 'exclusive',
      });
    },
  );

  /**
   * GET /settings - Fetch current restaurant settings & profile
   */
  app.get(
    '/settings',
    { preHandler: [requirePermission(Permissions.SETTINGS_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);

      let [settings] = await tenant.db
        .select()
        .from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, authUser.restaurantId))
        .limit(1);

      // If not yet initialized, initialize with defaults
      if (!settings) {
        const [restaurant] = await tenant.db
          .select()
          .from(restaurants)
          .where(eq(restaurants.id, authUser.restaurantId))
          .limit(1);

        const newSettingsId = generateUuidV7();
        await tenant.db.insert(restaurantSettings).values({
          id: newSettingsId,
          restaurantId: authUser.restaurantId,
          name: restaurant?.name || 'Restaurant OS',
          address: '',
          phone: '',
          gstin: null,
          taxMode: 'exclusive',
          defaultGstRateBp: 500,
          serviceChargePercent: '0.00',
          billFooter: 'Thank you for dining with us!',
          kitchenLateThresholdMinutes: 15,
          kitchenOverdueThresholdMinutes: 30,
          discountCapOwnerPercent: 100,
          discountCapManagerPercent: 25,
          discountCapCashierPercent: 10,
        });

        [settings] = await tenant.db
          .select()
          .from(restaurantSettings)
          .where(eq(restaurantSettings.id, newSettingsId))
          .limit(1);
      }

      return reply.status(200).send({
        ...settings,
        serviceChargePercent: parseFloat(settings!.serviceChargePercent),
      });
    },
  );

  /**
   * PUT /settings - Update restaurant profile, tax parameters, and thresholds
   */
  app.put(
    '/settings',
    { preHandler: [requirePermission(Permissions.SETTINGS_MANAGE)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const body = updateRestaurantSettingsSchema.parse(request.body);

      const [existing] = await tenant.db
        .select()
        .from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, authUser.restaurantId))
        .limit(1);

      const updateValues = {
        name: body.name,
        address: body.address,
        phone: body.phone,
        gstin: body.gstin || null,
        taxMode: body.taxMode,
        defaultGstRateBp: body.defaultGstRateBp,
        serviceChargePercent: body.serviceChargePercent.toFixed(2),
        billFooter: body.billFooter,
        kitchenLateThresholdMinutes: body.kitchenLateThresholdMinutes,
        kitchenOverdueThresholdMinutes: body.kitchenOverdueThresholdMinutes,
        discountCapOwnerPercent: body.discountCapOwnerPercent,
        discountCapManagerPercent: body.discountCapManagerPercent,
        discountCapCashierPercent: body.discountCapCashierPercent,
        upiVpa: body.upiVpa || null,
        upiPayeeName: body.upiPayeeName || null,
        receiptHeaderLines: body.receiptHeaderLines ?? existing?.receiptHeaderLines ?? [],
        receiptFooterLines: body.receiptFooterLines ?? existing?.receiptFooterLines ?? [],
        receiptShowGstin: body.receiptShowGstin ?? existing?.receiptShowGstin ?? true,
        receiptShowCustomer: body.receiptShowCustomer ?? existing?.receiptShowCustomer ?? true,
        receiptShowItemNotes: body.receiptShowItemNotes ?? existing?.receiptShowItemNotes ?? false,
        receiptShowServiceCharge:
          body.receiptShowServiceCharge ?? existing?.receiptShowServiceCharge ?? true,
        receiptShowQr: body.receiptShowQr ?? existing?.receiptShowQr ?? true,
        rupeeSymbolMode: body.rupeeSymbolMode ?? existing?.rupeeSymbolMode ?? 'text_rs',
        updatedAt: new Date(),
      };

      let updatedId = existing?.id;

      if (!existing) {
        updatedId = generateUuidV7();
        await tenant.db.insert(restaurantSettings).values({
          id: updatedId,
          restaurantId: authUser.restaurantId,
          ...updateValues,
        });
      } else {
        await tenant.db
          .update(restaurantSettings)
          .set(updateValues)
          .where(eq(restaurantSettings.id, existing.id));
      }

      // Also keep restaurant root table name synchronized
      await tenant.db
        .update(restaurants)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(restaurants.id, authUser.restaurantId));

      // Audit log for tax, thresholds, profile, and UPI VPA change
      await recordAuditLog({
        restaurantId: authUser.restaurantId,
        userId: authUser.userId,
        action: 'settings.update',
        entity: 'restaurant_settings',
        entityId: updatedId!,
        before: existing
          ? {
              name: existing.name,
              taxMode: existing.taxMode,
              defaultGstRateBp: existing.defaultGstRateBp,
              serviceChargePercent: existing.serviceChargePercent,
              upiVpa: existing.upiVpa,
              upiPayeeName: existing.upiPayeeName,
            }
          : null,
        after: {
          name: body.name,
          taxMode: body.taxMode,
          defaultGstRateBp: body.defaultGstRateBp,
          serviceChargePercent: body.serviceChargePercent,
          upiVpa: body.upiVpa || null,
          upiPayeeName: body.upiPayeeName || null,
        },
        request,
      });

      const [final] = await tenant.db
        .select()
        .from(restaurantSettings)
        .where(eq(restaurantSettings.id, updatedId!))
        .limit(1);

      return reply.status(200).send({
        ...final,
        serviceChargePercent: parseFloat(final!.serviceChargePercent),
      });
    },
  );
}
