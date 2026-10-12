import type { FastifyInstance } from 'fastify';
import { eq, and, asc, desc, gte, sql, inArray } from 'drizzle-orm';
import { Permissions } from '@restaurant-os/shared';
import { forTenant } from '../../db/tenant.js';
import { orders, orderItems } from '../../db/schema/orders.js';
import { tables } from '../../db/schema/tables.js';
import { menuItems } from '../../db/schema/menu-items.js';
import { kots } from '../../db/schema/kots.js';
import { bills, payments } from '../../db/schema/bills.js';
import { requirePermission, registerRouteGuard } from '../../auth/middleware.js';

export async function registerOrderRecentRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'GET',
    url: '/menu/frequent',
    isPublic: false,
    permission: Permissions.MENU_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/menu/popular-today',
    isPublic: false,
    permission: Permissions.MENU_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/orders/recent',
    isPublic: false,
    permission: Permissions.ORDER_READ,
  });

  /**
   * GET /menu/frequent - Top 8 items sold over the last 30 days
   */
  app.get(
    '/menu/frequent',
    { preHandler: [requirePermission(Permissions.MENU_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const rows = await tenant.db
        .select({
          itemId: orderItems.itemId,
          name: menuItems.name,
          isVeg: menuItems.isVeg,
          pricePaise: menuItems.pricePaise,
          totalSold: sql<number>`SUM(${orderItems.qty})::int`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .innerJoin(menuItems, eq(orderItems.itemId, menuItems.id))
        .where(
          and(
            eq(orders.restaurantId, authUser.restaurantId),
            sql`${orders.status} != 'cancelled'`,
            gte(orderItems.createdAt, thirtyDaysAgo),
            eq(menuItems.active, true),
            eq(menuItems.available, true),
          ),
        )
        .groupBy(orderItems.itemId, menuItems.name, menuItems.isVeg, menuItems.pricePaise)
        .orderBy(desc(sql`SUM(${orderItems.qty})`))
        .limit(8);

      return reply.status(200).send(rows);
    },
  );

  /**
   * GET /menu/popular-today - Top items sold today (since midnight)
   */
  app.get(
    '/menu/popular-today',
    { preHandler: [requirePermission(Permissions.MENU_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const rows = await tenant.db
        .select({
          itemId: orderItems.itemId,
          name: menuItems.name,
          isVeg: menuItems.isVeg,
          pricePaise: menuItems.pricePaise,
          totalSold: sql<number>`SUM(${orderItems.qty})::int`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .innerJoin(menuItems, eq(orderItems.itemId, menuItems.id))
        .where(
          and(
            eq(orders.restaurantId, authUser.restaurantId),
            sql`${orders.status} != 'cancelled'`,
            gte(orderItems.createdAt, todayStart),
            eq(menuItems.active, true),
            eq(menuItems.available, true),
          ),
        )
        .groupBy(orderItems.itemId, menuItems.name, menuItems.isVeg, menuItems.pricePaise)
        .orderBy(desc(sql`SUM(${orderItems.qty})`))
        .limit(8);

      return reply.status(200).send(rows);
    },
  );

  /**
   * GET /orders/recent - Last 10 orders with item snapshots and availability
   */
  app.get(
    '/orders/recent',
    { preHandler: [requirePermission(Permissions.ORDER_READ)] },
    async (request, reply) => {
      const authUser = request.user!;
      const tenant = forTenant(authUser.restaurantId);
      const query = request.query as { myOrders?: string; tableId?: string };

      const conditions = [
        eq(orders.restaurantId, authUser.restaurantId),
        sql`${orders.status} != 'cancelled'`,
      ];

      if (query.myOrders === 'true') {
        conditions.push(eq(orders.createdBy, authUser.userId));
      }
      if (query.tableId) {
        conditions.push(eq(orders.tableId, query.tableId));
      }

      const recentOrders = await tenant.db
        .select({
          id: orders.id,
          tableId: orders.tableId,
          tableLabel: tables.label,
          type: orders.type,
          status: orders.status,
          totalPaise: orders.totalPaise,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .leftJoin(tables, eq(orders.tableId, tables.id))
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(10);

      const recentOrderIds = recentOrders.map((order) => order.id);
      const recentKots = recentOrderIds.length
        ? await tenant.db
            .select({ orderId: kots.orderId, status: kots.status })
            .from(kots)
            .where(inArray(kots.orderId, recentOrderIds))
        : [];
      const kotStatusesByOrder = new Map<string, string[]>();
      for (const kot of recentKots) {
        const statuses = kotStatusesByOrder.get(kot.orderId) || [];
        statuses.push(kot.status);
        kotStatusesByOrder.set(kot.orderId, statuses);
      }

      const recentBills = recentOrderIds.length
        ? await tenant.db
            .select({
              id: bills.id,
              orderId: bills.orderId,
              status: bills.status,
              totalPaise: bills.totalPaise,
            })
            .from(bills)
            .where(
              and(
                eq(bills.restaurantId, authUser.restaurantId),
                inArray(bills.orderId, recentOrderIds),
                inArray(bills.status, ['draft', 'unpaid', 'partially_paid', 'paid']),
              ),
            )
            .orderBy(desc(bills.createdAt))
        : [];
      const billByOrderId = new Map<string, (typeof recentBills)[number]>();
      for (const bill of recentBills) {
        if (!billByOrderId.has(bill.orderId)) billByOrderId.set(bill.orderId, bill);
      }

      const recentBillIds = recentBills.map((bill) => bill.id);
      const recentPayments = recentBillIds.length
        ? await tenant.db
            .select({
              billId: payments.billId,
              amountPaise: payments.amountPaise,
              status: payments.status,
            })
            .from(payments)
            .where(
              and(
                eq(payments.restaurantId, authUser.restaurantId),
                inArray(payments.billId, recentBillIds),
              ),
            )
        : [];
      const paymentTotalsByBill = new Map<
        string,
        { paidPaise: number; pendingPaymentPaise: number }
      >();
      for (const payment of recentPayments) {
        const totals = paymentTotalsByBill.get(payment.billId) || {
          paidPaise: 0,
          pendingPaymentPaise: 0,
        };
        if (payment.status === 'confirmed' || payment.status === 'recorded') {
          totals.paidPaise += payment.amountPaise;
        } else if (payment.status === 'pending_confirmation') {
          totals.pendingPaymentPaise += payment.amountPaise;
        }
        paymentTotalsByBill.set(payment.billId, totals);
      }

      const result = await Promise.all(
        recentOrders.map(async (ord) => {
          const lines = await tenant.db
            .select({
              itemId: orderItems.itemId,
              name: orderItems.nameSnapshot,
              qty: orderItems.qty,
              pricePaise: orderItems.pricePaiseSnapshot,
              modifiers: orderItems.modifiers,
              available: menuItems.available,
            })
            .from(orderItems)
            .leftJoin(menuItems, eq(orderItems.itemId, menuItems.id))
            .where(eq(orderItems.orderId, ord.id))
            .orderBy(asc(orderItems.lineNo));

          const itemSummary = lines.map((l) => `${l.qty}x ${l.name}`).join(', ');

          return {
            ...ord,
            kotStatuses: kotStatusesByOrder.get(ord.id) || [],
            billStatus: billByOrderId.get(ord.id)?.status || null,
            paidPaise: paymentTotalsByBill.get(billByOrderId.get(ord.id)?.id || '')?.paidPaise || 0,
            pendingPaymentPaise:
              paymentTotalsByBill.get(billByOrderId.get(ord.id)?.id || '')?.pendingPaymentPaise ||
              0,
            itemSummary,
            items: lines.map((l) => ({
              ...l,
              available: l.available ?? false,
            })),
          };
        }),
      );

      return reply.status(200).send(result);
    },
  );
}
