import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Roles,
  ROLE_DEFAULT_PERMISSIONS,
  calculateBill,
  type BillingLineInput,
} from '@restaurant-os/shared';
import { buildServer } from '../src/server.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { pool, closeDatabaseConnection, db } from '../src/db/client.js';
import { bills, billLines, payments } from '../src/db/schema/bills.js';
import { loyaltyAccounts, loyaltyTransactions } from '../src/db/schema/loyalty.js';
import { dailySummaries } from '../src/db/schema/daily-summaries.js';
import { inventoryItems } from '../src/db/schema/inventory.js';
import { eq, and, sql } from 'drizzle-orm';
import { processBillPaidLoyaltyEarn } from '../src/services/loyalty.js';
import { InventoryService } from '../src/services/inventory.js';

const expectedDatabase = process.env.RESTAURANT_OS_ISOLATED_TEST_DB;
const isDedicatedTestDatabase =
  Boolean(expectedDatabase) &&
  (new URL(process.env.DATABASE_URL || 'postgres://localhost/').pathname === `/${expectedDatabase}` ||
   process.env.DATABASE_URL?.includes(expectedDatabase));

describe.skipIf(!isDedicatedTestDatabase)(
  'Loyalty Redemption and Money Math Integration Tests',
  () => {
    const restaurantId = randomUUID();
    const userId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);

    const token = signAccessToken({
      userId,
      restaurantId,
      username: `owner_${suffix}`,
      name: 'Owner Tester',
      role: Roles.OWNER,
      permissions: ROLE_DEFAULT_PERMISSIONS[Roles.OWNER],
    });

    let app: Awaited<ReturnType<typeof buildServer>>;
    let customerId: string;
    let accountId: string;
    let categoryId: string;
    let itemId: string;

    beforeAll(async () => {
      // 1. Seed restaurant & user
      await pool.query('INSERT INTO restaurants (id, name) VALUES ($1, $2)', [
        restaurantId,
        'Loyalty Test Restaurant',
      ]);
      await pool.query(
        `INSERT INTO users (id, restaurant_id, username, password_hash, name, active)
       VALUES ($1, $2, $3, 'hash', 'Owner', true)`,
        [userId, restaurantId, `owner_${suffix}`],
      );

      // 2. Seed restaurant settings with 5% service charge, exclusive tax, 5% GST
      await pool.query(
        `INSERT INTO restaurant_settings (
        restaurant_id, name, tax_mode, service_charge_percent, default_gst_rate_bp, business_day_start_hour, timezone
       ) VALUES ($1, 'Loyalty Test Restaurant', 'exclusive', 5.00, 500, 5, 'Asia/Kolkata')
       ON CONFLICT (restaurant_id) DO UPDATE SET
        name = 'Loyalty Test Restaurant', tax_mode = 'exclusive', service_charge_percent = 5.00, default_gst_rate_bp = 500`,
        [restaurantId],
      );

      // 3. Seed loyalty settings
      await pool.query(
        `INSERT INTO loyalty_settings (
        restaurant_id, enabled, spend_paise_per_block, points_per_block,
        redeem_points_block, redeem_value_paise, min_redeem_points,
        max_redeem_percent_of_bill, per_day_redeem_cap_points, new_account_cooldown_hours
       ) VALUES ($1, true, 10000, 10, 100, 1000, 100, 50, 5000, 0)
       ON CONFLICT (restaurant_id) DO UPDATE SET
        enabled = true, min_redeem_points = 100, new_account_cooldown_hours = 0`,
        [restaurantId],
      );

      // 4. Seed menu item (Price ₹500 = 50000 paise, 5% GST)
      categoryId = randomUUID();
      itemId = randomUUID();
      await pool.query(
        'INSERT INTO menu_categories (id, restaurant_id, name) VALUES ($1, $2, $3)',
        [categoryId, restaurantId, 'Main Course'],
      );
      await pool.query(
        `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, tax_rate_bp, active, available)
       VALUES ($1, $2, $3, 'Paneer Butter Masala', 50000, 500, true, true)`,
        [itemId, restaurantId, categoryId],
      );

      // 5. Seed Customer & Loyalty Account with 1000 initial points
      customerId = randomUUID();
      accountId = randomUUID();
      await pool.query(
        `INSERT INTO customers (id, restaurant_id, name, phone, consent_recorded)
       VALUES ($1, $2, 'Test Customer', $3, true)`,
        [customerId, restaurantId, `9876${suffix.slice(0, 6)}`],
      );
      await pool.query(
        `INSERT INTO loyalty_accounts (id, restaurant_id, customer_id, points_balance, tier, created_at)
       VALUES ($1, $2, $3, 1000, 'Silver', NOW() - INTERVAL '2 days')`,
        [accountId, restaurantId, customerId],
      );

      // Record initial ledger transaction so ledger sum matches 1000
      await pool.query(
        `INSERT INTO loyalty_transactions (restaurant_id, account_id, customer_id, type, points, reason)
       VALUES ($1, $2, $3, 'bonus', 1000, 'Initial test balance')`,
        [restaurantId, accountId, customerId],
      );

      app = await buildServer({ logger: false });
    });

    afterAll(async () => {
      if (app) await app.close();
      await pool.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurantId]);
      await pool.query(
        'DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE restaurant_id = $1)',
        [restaurantId],
      );
      await pool.query('DELETE FROM bills WHERE restaurant_id = $1', [restaurantId]);
      await pool.query(
        'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id = $1)',
        [restaurantId],
      );
      await pool.query('DELETE FROM orders WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM loyalty_transactions WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM loyalty_accounts WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM customers WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM users WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM restaurant_settings WHERE restaurant_id = $1', [restaurantId]);
      await pool.query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
      await closeDatabaseConnection();
    });

    async function createOrderAndBill(options?: {
      qty?: number;
      customCustomerId?: string;
    }): Promise<{ orderId: string; billId: string; billNumber: string }> {
      const custId = options?.customCustomerId ?? customerId;
      const qty = options?.qty ?? 2; // 2 x 50000 = 100000 paise (₹1000)

      // Create order
      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          id: randomUUID(),
          type: 'dine_in',
          customerId: custId,
          items: [{ itemId, qty }],
        },
      });
      expect([200, 201]).toContain(orderRes.statusCode);
      const orderData = JSON.parse(orderRes.payload);
      const orderId = orderData.id ?? orderData.order?.id;

      // Generate bill
      const billRes = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/bill`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(billRes.statusCode).toBe(201);
      const billData = JSON.parse(billRes.payload);
      return {
        orderId,
        billId: billData.bill.id,
        billNumber: billData.bill.billNumber,
      };
    }

    it('redeems twice on one bill: credits back prior points via reversal ledger, applies new redemption', async () => {
      const { billId } = await createOrderAndBill();

      // Initial account balance
      const [accBefore] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      const startBalance = accBefore!.pointsBalance;

      // 1st Redemption: 100 points = ₹10 off (1000 paise)
      const redeem1 = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(redeem1.statusCode).toBe(200);
      const body1 = JSON.parse(redeem1.payload);
      expect(body1.success).toBe(true);
      expect(body1.redeemedPoints).toBe(100);
      expect(body1.discountPaise).toBe(1000);
      expect(body1.bill.loyaltyPointsRedeemed).toBe(100);
      expect(body1.bill.loyaltyDiscountPaise).toBe(1000);

      const [accAfter1] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      expect(accAfter1!.pointsBalance).toBe(startBalance - 100);

      // 2nd Redemption on the SAME bill: 200 points = ₹20 off (2000 paise)
      const redeem2 = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 200 },
      });
      expect(redeem2.statusCode).toBe(200);
      const body2 = JSON.parse(redeem2.payload);
      expect(body2.success).toBe(true);
      expect(body2.redeemedPoints).toBe(200);
      expect(body2.discountPaise).toBe(2000);

      // Bill loyalty tracking always reflects only currently applied redemption
      expect(body2.bill.loyaltyPointsRedeemed).toBe(200);
      expect(body2.bill.loyaltyDiscountPaise).toBe(2000);
      expect(body2.bill.discountPaise).toBe(2000);

      // Customer balance: started at startBalance, -100, then +100 reversed, then -200 = startBalance - 200
      const [accAfter2] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      expect(accAfter2!.pointsBalance).toBe(startBalance - 200);

      // Verify ledger entries on this bill: 1 redeem (-100), 1 reversal (+100), 1 redeem (-200)
      const txRows = await db
        .select()
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.billId, billId));

      const types = txRows.map((t) => t.type).sort();
      expect(types).toEqual(['redeem', 'redeem', 'reversal']);

      const reversalTx = txRows.find((t) => t.type === 'reversal');
      expect(reversalTx?.points).toBe(100);

      // Verify ledger sum matches account balance
      const [ledgerSum] = await db
        .select({ total: sql<number>`COALESCE(SUM(${loyaltyTransactions.points}), 0)` })
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.accountId, accountId));
      expect(Number(ledgerSum!.total)).toBe(accAfter2!.pointsBalance);

      // Verify bill totals match calculateBill with bill stored parameters
      const [storedBill] = await db.select().from(bills).where(eq(bills.id, billId));
      const lines = await db.select().from(billLines).where(eq(billLines.billId, billId));
      const expectedCalc = calculateBill({
        lines: lines.map((l) => ({
          itemId: l.itemId,
          name: l.name,
          qty: l.qty,
          pricePaise: l.pricePaise,
          taxRateBp: l.taxRateBp,
        })),
        taxMode: storedBill!.taxMode as any,
        discount: { type: 'flat', value: 2000 },
        serviceChargePercent: Number(storedBill!.serviceChargePercent),
        defaultGstRateBp: storedBill!.defaultGstRateBp,
        roundOffEnabled: storedBill!.roundOffEnabled,
      });

      expect(storedBill!.subtotalPaise).toBe(expectedCalc.subtotalPaise);
      expect(storedBill!.discountPaise).toBe(expectedCalc.discountPaise);
      expect(storedBill!.serviceChargePaise).toBe(expectedCalc.serviceChargePaise);
      expect(storedBill!.taxPaise).toBe(expectedCalc.taxPaise);
      expect(storedBill!.roundOffPaise).toBe(expectedCalc.roundOffPaise);
      expect(storedBill!.totalPaise).toBe(expectedCalc.totalPaise);
    });

    it('redeems then pays: payment succeeds and further redemption is rejected on paid bill', async () => {
      const { billId } = await createOrderAndBill();

      // Redeem 100 points
      const redeemRes = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(redeemRes.statusCode).toBe(200);

      const [billBeforePay] = await db.select().from(bills).where(eq(bills.id, billId));
      const requiredTotal = billBeforePay!.totalPaise;

      // Pay the bill in full
      const payRes = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/payments`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          amountPaise: requiredTotal,
          method: 'cash',
        },
      });
      expect([200, 201]).toContain(payRes.statusCode);
      const payData = JSON.parse(payRes.payload);
      expect(payData.bill.status).toBe('paid');

      // Attempt to redeem on paid bill -> must fail with 400
      const failRedeem = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(failRedeem.statusCode).toBe(400);
      const err = JSON.parse(failRedeem.payload);
      expect(err.error?.message || err.message).toContain(
        'Cannot redeem loyalty points on bill with status "paid"',
      );
    });

    it('redeem concurrent with payment: serialized cleanly via bill row lock', async () => {
      const { billId } = await createOrderAndBill();

      const [freshBill] = await db.select().from(bills).where(eq(bills.id, billId));
      const initialTotal = freshBill!.totalPaise;

      // Fire redeem (100 pts) and payment (for initialTotal) simultaneously
      const [redeemPromise, payPromise] = [
        app.inject({
          method: 'POST',
          url: `/bills/${billId}/redeem`,
          headers: { authorization: `Bearer ${token}` },
          payload: { pointsToRedeem: 100 },
        }),
        app.inject({
          method: 'POST',
          url: `/bills/${billId}/payments`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            amountPaise: initialTotal,
            method: 'cash',
          },
        }),
      ];

      const [redeemResult, payResult] = await Promise.all([redeemPromise, payPromise]);

      // One of two valid serializations occurred:
      // A) Redeem won lock -> bill discounted -> payment for initialTotal exceeds new remaining balance -> 400
      // B) Pay won lock -> bill became paid (201) -> redeem on paid bill rejected -> 400
      if (redeemResult.statusCode === 200) {
        expect(payResult.statusCode).toBe(400);
      } else {
        expect(redeemResult.statusCode).toBe(400);
        expect([200, 201]).toContain(payResult.statusCode);
      }

      // Ledger sum matches account balance
      const [acc] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      const [lSum] = await db
        .select({ total: sql<number>`COALESCE(SUM(${loyaltyTransactions.points}), 0)` })
        .from(loyaltyTransactions)
        .where(eq(loyaltyTransactions.accountId, accountId));
      expect(Number(lSum!.total)).toBe(acc!.pointsBalance);
    });

    it('preserves snapshotted tax parameters during recalculation even when settings change', async () => {
      // 1. Create a bill with original settings (5% service charge)
      const { billId } = await createOrderAndBill();
      const [originalBill] = await db.select().from(bills).where(eq(bills.id, billId));
      expect(originalBill!.serviceChargePercent).toBe('5.00');
      expect(originalBill!.taxMode).toBe('exclusive');
      expect(originalBill!.defaultGstRateBp).toBe(500);
      expect(originalBill!.roundOffEnabled).toBe(true);

      // 2. Change restaurant settings to 15% service charge and 1800 bp GST
      await pool.query(
        `UPDATE restaurant_settings
       SET service_charge_percent = 15.00, default_gst_rate_bp = 1800
       WHERE restaurant_id = $1`,
        [restaurantId],
      );

      // 3. Redeem points on the existing bill
      const redeemRes = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(redeemRes.statusCode).toBe(200);

      // 4. Verify the recalculated bill used the snapshotted 5% service charge and 500 bp GST, NOT 15% / 1800
      const [recalculatedBill] = await db.select().from(bills).where(eq(bills.id, billId));
      expect(recalculatedBill!.serviceChargePercent).toBe('5.00');
      expect(recalculatedBill!.defaultGstRateBp).toBe(500);

      // Verify recalculation matches calculateBill with snapshotted params
      const lines = await db.select().from(billLines).where(eq(billLines.billId, billId));
      const expected = calculateBill({
        lines: lines.map((l) => ({
          itemId: l.itemId,
          name: l.name,
          qty: l.qty,
          pricePaise: l.pricePaise,
          taxRateBp: l.taxRateBp,
        })),
        taxMode: 'exclusive',
        discount: { type: 'flat', value: 1000 },
        serviceChargePercent: 5.0,
        defaultGstRateBp: 500,
        roundOffEnabled: true,
      });

      expect(recalculatedBill!.totalPaise).toBe(expected.totalPaise);
      expect(recalculatedBill!.serviceChargePaise).toBe(expected.serviceChargePaise);
      expect(recalculatedBill!.taxPaise).toBe(expected.taxPaise);

      // Revert settings back to 5.00
      await pool.query(
        `UPDATE restaurant_settings
       SET service_charge_percent = 5.00, default_gst_rate_bp = 500
       WHERE restaurant_id = $1`,
        [restaurantId],
      );
    });

    it('rejects redemption that would push bill total below zero', async () => {
      // Create an order with a low price (e.g. qty 1, price 500 = ₹5)
      const cheapItemId = randomUUID();
      await pool.query(
        `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, tax_rate_bp, active, available)
       VALUES ($1, $2, $3, 'Small Chai', 500, 0, true, true)`,
        [cheapItemId, restaurantId, categoryId],
      );

      const orderRes = await app.inject({
        method: 'POST',
        url: '/orders',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          id: randomUUID(),
          type: 'dine_in',
          customerId,
          items: [{ itemId: cheapItemId, qty: 1 }],
        },
      });
      const parsedOrder = JSON.parse(orderRes.payload);
      const orderId = parsedOrder.id ?? parsedOrder.order?.id;

      const billRes = await app.inject({
        method: 'POST',
        url: `/orders/${orderId}/bill`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      const billId = JSON.parse(billRes.payload).bill.id;

      // Apply manual discount that leaves bill total near zero
      await app.inject({
        method: 'PATCH',
        url: `/bills/${billId}/discount`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          type: 'flat',
          value: 400,
          reason: 'Promo',
        },
      });

      // Try to redeem 100 points (= 1000 paise discount), but bill subtotal is only 500 paise!
      const redeemRes = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(redeemRes.statusCode).toBe(400);
    });

    it('handles tax-inclusive restaurant bills and correctly recalculates upon loyalty redemption', async () => {
      // 1. Temporarily switch settings to tax_mode = inclusive, service_charge = 10%
      await pool.query(
        `UPDATE restaurant_settings
       SET tax_mode = 'inclusive', service_charge_percent = 10.00
       WHERE restaurant_id = $1`,
        [restaurantId],
      );

      // 2. Create an order and bill in tax-inclusive mode
      const { billId } = await createOrderAndBill();
      const [inclusiveBill] = await db.select().from(bills).where(eq(bills.id, billId));
      expect(inclusiveBill!.taxMode).toBe('inclusive');
      expect(inclusiveBill!.serviceChargePercent).toBe('10.00');

      // 3. Redeem 100 loyalty points
      const redeemRes = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(redeemRes.statusCode).toBe(200);

      // 4. Verify totals match calculateBill with inclusive tax mode and 10% service charge
      const [recalculatedBill] = await db.select().from(bills).where(eq(bills.id, billId));
      const lines = await db.select().from(billLines).where(eq(billLines.billId, billId));

      const expected = calculateBill({
        lines: lines.map((l) => ({
          itemId: l.itemId,
          name: l.name,
          qty: l.qty,
          pricePaise: l.pricePaise,
          taxRateBp: l.taxRateBp,
        })),
        taxMode: 'inclusive',
        discount: { type: 'flat', value: 1000 },
        serviceChargePercent: 10.0,
        defaultGstRateBp: 500,
        roundOffEnabled: true,
      });

      expect(recalculatedBill!.taxMode).toBe('inclusive');
      expect(recalculatedBill!.subtotalPaise).toBe(expected.subtotalPaise);
      expect(recalculatedBill!.discountPaise).toBe(expected.discountPaise);
      expect(recalculatedBill!.serviceChargePaise).toBe(expected.serviceChargePaise);
      expect(recalculatedBill!.taxPaise).toBe(expected.taxPaise);
      expect(recalculatedBill!.roundOffPaise).toBe(expected.roundOffPaise);
      expect(recalculatedBill!.totalPaise).toBe(expected.totalPaise);

      // Revert settings back to exclusive, 5.00
      await pool.query(
        `UPDATE restaurant_settings
       SET tax_mode = 'exclusive', service_charge_percent = 5.00
       WHERE restaurant_id = $1`,
        [restaurantId],
      );
    });

    it('retried payment confirmation never accrues duplicate loyalty points', async () => {
      const { billId } = await createOrderAndBill();

      // Mark bill paid
      await db.update(bills).set({ status: 'paid' }).where(eq(bills.id, billId));

      const [accBefore] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      const balanceBefore = accBefore!.pointsBalance;

      // First call to processBillPaidLoyaltyEarn
      const earn1 = await db.transaction(async (tx) => {
        return processBillPaidLoyaltyEarn({ restaurantId, billId, userId }, tx);
      });
      expect(earn1).not.toBeNull();
      const earnedPoints = earn1!.points;
      expect(earnedPoints).toBeGreaterThan(0);

      const [accAfter1] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      expect(accAfter1!.pointsBalance).toBe(balanceBefore + earnedPoints);

      // Retried call (e.g. duplicate webhook / retry callback)
      const earn2 = await db.transaction(async (tx) => {
        return processBillPaidLoyaltyEarn({ restaurantId, billId, userId }, tx);
      });

      // Returns existing transaction without duplicating
      expect(earn2).not.toBeNull();
      expect(earn2!.id).toBe(earn1!.id);

      // Balance remains exactly the same
      const [accAfter2] = await db
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.id, accountId));
      expect(accAfter2!.pointsBalance).toBe(balanceBefore + earnedPoints);

      // Exactly one earn transaction exists for this bill
      const earns = await db
        .select()
        .from(loyaltyTransactions)
        .where(and(eq(loyaltyTransactions.billId, billId), eq(loyaltyTransactions.type, 'earn')));
      expect(earns.length).toBe(1);
    });

    it('negative-stock prevention: recordUsage atomically rejects when quantity exceeds available stock', async () => {
      const invItemId = randomUUID();
      await pool.query(
        `INSERT INTO inventory_items (id, restaurant_id, name, unit, current_stock, reorder_level, avg_cost_paise_per_unit, active)
       VALUES ($1, $2, 'Test Paneer', 'kg', '5.000', '1.000', 30000, true)`,
        [invItemId, restaurantId],
      );

      // Attempting to record usage of 6.000 kg when only 5.000 kg is available
      await expect(
        InventoryService.recordUsage(restaurantId, userId, {
          itemId: invItemId,
          quantity: 6.0,
          reason: 'Kitchen prep',
        }),
      ).rejects.toThrow();

      // Verify stock remains exactly 5.000 kg and was not decremented to negative
      const [item] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, invItemId));
      expect(Number(item!.currentStock)).toBe(5);

      // Clean up
      await pool.query('DELETE FROM inventory_items WHERE id = $1', [invItemId]);
    });

    it('strictly blocks loyalty redemption when bill business date is locked', async () => {
      const { billId } = await createOrderAndBill();
      const [billRow] = await db.select().from(bills).where(eq(bills.id, billId));
      const bDate = billRow!.businessDate || '2026-10-12';

      // Lock the day in daily_summaries
      await pool.query(
        `INSERT INTO daily_summaries (id, restaurant_id, business_date, locked)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (restaurant_id, business_date) DO UPDATE SET locked = true`,
        [randomUUID(), restaurantId, bDate],
      );

      // Attempt redemption -> must fail with locked error
      const res = await app.inject({
        method: 'POST',
        url: `/bills/${billId}/redeem`,
        headers: { authorization: `Bearer ${token}` },
        payload: { pointsToRedeem: 100 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error?.message || body.message).toContain('locked');

      // Unlock day to avoid affecting other tests
      await pool.query(
        'UPDATE daily_summaries SET locked = false WHERE restaurant_id = $1 AND business_date = $2',
        [restaurantId, bDate],
      );
    });
  },
);
