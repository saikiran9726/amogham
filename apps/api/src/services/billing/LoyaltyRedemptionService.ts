import { eq, and, sql, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  AppError,
  validateAndConvertRedemption,
  calculateBill,
  type BillingLineInput,
  getBusinessDate,
  getBusinessDateStartUtc,
} from '@restaurant-os/shared';
import { bills, billLines } from '../../db/schema/bills.js';
import { orders } from '../../db/schema/orders.js';
import { customers } from '../../db/schema/customers.js';
import { paymentRequests } from '../../db/schema/payment-requests.js';
import { loyaltyAccounts, loyaltyTransactions } from '../../db/schema/loyalty.js';
import { restaurantSettings } from '../../db/schema/restaurant-settings.js';
import { recordAuditLog } from '../audit.js';
import { getOrCreateLoyaltySettings } from '../loyalty.js';
import { assertBusinessDateNotLocked, type DbOrTx } from './PaymentService.js';

export interface BatchBillLineUpdate {
  id: string;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

/**
 * Updates multiple bill lines by primary key in one batched SQL statement.
 */
export async function batchUpdateBillLines(
  tx: DbOrTx,
  lineUpdates: BatchBillLineUpdate[],
): Promise<void> {
  if (lineUpdates.length === 0) return;

  if (lineUpdates.length === 1) {
    const l = lineUpdates[0]!;
    await tx
      .update(billLines)
      .set({
        discountPaise: l.discountPaise,
        taxablePaise: l.taxablePaise,
        taxPaise: l.taxPaise,
        cgstPaise: l.cgstPaise,
        sgstPaise: l.sgstPaise,
      })
      .where(eq(billLines.id, l.id));
    return;
  }

  const idList = lineUpdates.map((l) => sql`${l.id}::uuid`);
  const discountCases = lineUpdates.map(
    (l) => sql`WHEN ${l.id}::uuid THEN ${l.discountPaise}::int`,
  );
  const taxableCases = lineUpdates.map((l) => sql`WHEN ${l.id}::uuid THEN ${l.taxablePaise}::int`);
  const taxCases = lineUpdates.map((l) => sql`WHEN ${l.id}::uuid THEN ${l.taxPaise}::int`);
  const cgstCases = lineUpdates.map((l) => sql`WHEN ${l.id}::uuid THEN ${l.cgstPaise}::int`);
  const sgstCases = lineUpdates.map((l) => sql`WHEN ${l.id}::uuid THEN ${l.sgstPaise}::int`);

  await tx.execute(sql`
    UPDATE bill_lines
    SET
      discount_paise = CASE id ${sql.join(discountCases, sql` `)} END,
      taxable_paise = CASE id ${sql.join(taxableCases, sql` `)} END,
      tax_paise = CASE id ${sql.join(taxCases, sql` `)} END,
      cgst_paise = CASE id ${sql.join(cgstCases, sql` `)} END,
      sgst_paise = CASE id ${sql.join(sgstCases, sql` `)} END
    WHERE id IN (${sql.join(idList, sql`, `)})
  `);
}

export interface RedeemLoyaltyParams {
  restaurantId: string;
  billId: string;
  pointsToRedeem: number;
  userId?: string;
  request?: FastifyRequest;
}

export interface RedeemLoyaltyResult {
  bill: typeof bills.$inferSelect;
  account: typeof loyaltyAccounts.$inferSelect;
  pointsRedeemed: number;
  discountPaise: number;
  reversalTx: typeof loyaltyTransactions.$inferSelect | null;
  redeemTx: typeof loyaltyTransactions.$inferSelect;
}

export class LoyaltyRedemptionService {
  /**
   * Redeems loyalty points against a bill with concurrency locks, daily cap window,
   * re-redemption reversal handling, and snapshotted tax parameters.
   */
  static async redeem(tx: DbOrTx, params: RedeemLoyaltyParams): Promise<RedeemLoyaltyResult> {
    const { restaurantId, billId, pointsToRedeem, userId, request } = params;

    // 1. Lock the bill FOR UPDATE before computing
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.restaurantId, restaurantId)))
      .for('update')
      .limit(1);

    if (!bill) {
      throw AppError.notFound('Bill not found');
    }

    await assertBusinessDateNotLocked(restaurantId, bill.businessDate, tx);

    if (bill.status === 'paid' || bill.status === 'cancelled' || bill.status === 'refunded') {
      throw AppError.badRequest(
        `Cannot redeem loyalty points on bill with status "${bill.status}"`,
      );
    }

    // 2. Validate Order & Customer
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, bill.orderId), eq(orders.restaurantId, restaurantId)))
      .limit(1);

    if (!order || !order.customerId) {
      throw AppError.badRequest(
        'No customer attached to this order. Attach customer before redeeming loyalty points.',
      );
    }

    const customerId = order.customerId;
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.restaurantId, restaurantId)))
      .limit(1);

    if (!customer) {
      throw AppError.notFound('Customer not found');
    }

    // 3. Fetch Settings
    const [restaurantSet] = await tx
      .select()
      .from(restaurantSettings)
      .where(eq(restaurantSettings.restaurantId, restaurantId))
      .limit(1);

    const dayStartHour = restaurantSet?.businessDayStartHour ?? 5;
    const timezone = restaurantSet?.timezone ?? 'Asia/Kolkata';

    const lSettings = await getOrCreateLoyaltySettings(restaurantId, tx);
    if (!lSettings.enabled) {
      throw AppError.badRequest('Loyalty program is currently disabled');
    }

    // 4. Lock customer loyalty account FOR UPDATE
    const [account] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(
        and(
          eq(loyaltyAccounts.restaurantId, restaurantId),
          eq(loyaltyAccounts.customerId, customerId),
        ),
      )
      .for('update')
      .limit(1);

    if (!account) {
      throw AppError.badRequest('Customer does not have a loyalty account yet');
    }

    // 5. Treat loyalty discount as one replaceable component:
    // When re-redeeming on the same bill, credit back prior points via a ledger entry,
    // then apply the new redemption.
    const priorPoints = bill.loyaltyPointsRedeemed || 0;
    const priorDiscount = bill.loyaltyDiscountPaise || 0;
    let reversalTx: typeof loyaltyTransactions.$inferSelect | null = null;
    let currentEffectiveBalance = account.pointsBalance;

    if (priorPoints > 0) {
      const [rev] = await tx
        .insert(loyaltyTransactions)
        .values({
          restaurantId,
          accountId: account.id,
          customerId,
          type: 'reversal',
          points: priorPoints,
          billId,
          reason: `Reversal of prior loyalty redemption (${priorPoints} pts) on Bill #${bill.billNumber}`,
          createdBy: userId || null,
        })
        .returning();
      reversalTx = rev ?? null;

      await tx
        .update(loyaltyAccounts)
        .set({
          pointsBalance: sql`${loyaltyAccounts.pointsBalance} + ${priorPoints}`,
          updatedAt: new Date(),
        })
        .where(eq(loyaltyAccounts.id, account.id));

      currentEffectiveBalance += priorPoints;
    }

    // 6. Calculate points redeemed today within business date window
    // Window starts from getBusinessDate(businessDayStartHour, timezone), not server-local midnight
    const currentBusinessDate = getBusinessDate(new Date(), dayStartHour, timezone);
    const startOfBusinessDay = getBusinessDateStartUtc(currentBusinessDate, dayStartHour, timezone);

    const todayRedemptions = await tx
      .select({
        points: loyaltyTransactions.points,
        type: loyaltyTransactions.type,
      })
      .from(loyaltyTransactions)
      .where(
        and(
          eq(loyaltyTransactions.customerId, customerId),
          inArray(loyaltyTransactions.type, ['redeem', 'reversal']),
          sql`${loyaltyTransactions.createdAt} >= ${startOfBusinessDay}`,
        ),
      );

    let pointsRedeemedToday = 0;
    for (const r of todayRedemptions) {
      if (r.type === 'redeem') {
        pointsRedeemedToday += Math.abs(r.points);
      } else if (r.type === 'reversal') {
        pointsRedeemedToday -= Math.abs(r.points);
      }
    }
    if (pointsRedeemedToday < 0) pointsRedeemedToday = 0;

    const accountAgeHours = (Date.now() - new Date(account.createdAt).getTime()) / (1000 * 60 * 60);

    // 7. Validate and convert redemption points to discount paise
    const validation = validateAndConvertRedemption({
      pointsToRedeem,
      billTotalPaise: bill.subtotalPaise,
      pointsBalance: currentEffectiveBalance,
      pointsRedeemedToday,
      accountAgeHours,
      settings: lSettings,
    });

    if (!validation.isValid) {
      throw AppError.badRequest(validation.error || 'Redemption conditions not met');
    }

    const newLoyaltyDiscountPaise = validation.discountPaise;

    // 8. Calculate new totals with snapshotted bill parameters
    // otherDiscount = discountPaise - loyaltyDiscountPaise
    const otherDiscountPaise = Math.max(0, (bill.discountPaise || 0) - priorDiscount);
    const totalCombinedDiscountPaise = otherDiscountPaise + newLoyaltyDiscountPaise;

    const lines = await tx.select().from(billLines).where(eq(billLines.billId, billId));
    const billingLines: BillingLineInput[] = lines.map((l) => ({
      orderItemId: l.orderItemId ?? undefined,
      itemId: l.itemId,
      name: l.name,
      qty: l.qty,
      pricePaise: l.pricePaise,
      taxRateBp: l.taxRateBp,
      modifiers: Array.isArray(l.modifiers)
        ? (l.modifiers as unknown as BillingLineInput['modifiers'])
        : [],
      note: l.note,
    }));

    const calculated = calculateBill({
      lines: billingLines,
      taxMode: (bill.taxMode as 'inclusive' | 'exclusive') || 'exclusive',
      discount: {
        type: 'flat',
        value: totalCombinedDiscountPaise,
        reason: bill.discountReason
          ? `${bill.discountReason} + Loyalty Redemption`
          : `Loyalty: ${pointsToRedeem} points`,
      },
      serviceChargePercent: Number(bill.serviceChargePercent) || 0,
      defaultGstRateBp: bill.defaultGstRateBp,
      roundOffEnabled: bill.roundOffEnabled,
    });

    // Reject a redemption that would push the total below zero
    if (calculated.totalPaise < 0) {
      throw AppError.badRequest(
        `Redemption would result in negative bill total (${calculated.totalPaise} paise). Total must be non-negative.`,
      );
    }

    // 9. Record Redeem ledger entry (debit: negative points)
    const [redeemTx] = await tx
      .insert(loyaltyTransactions)
      .values({
        restaurantId,
        accountId: account.id,
        customerId,
        type: 'redeem',
        points: -pointsToRedeem,
        billId,
        reason: `Redeemed ${pointsToRedeem} points for ₹${(newLoyaltyDiscountPaise / 100).toFixed(2)} off on Bill #${bill.billNumber}`,
        createdBy: userId || null,
      })
      .returning();

    // Update account points balance
    const [updatedAccount] = await tx
      .update(loyaltyAccounts)
      .set({
        pointsBalance: sql`${loyaltyAccounts.pointsBalance} - ${pointsToRedeem}`,
        updatedAt: new Date(),
      })
      .where(eq(loyaltyAccounts.id, account.id))
      .returning();

    // 10. Update bill lines in one batched statement
    const lineUpdates: BatchBillLineUpdate[] = calculated.lines
      .map((cl) => {
        const match = lines.find((l) => l.orderItemId === cl.orderItemId && l.name === cl.name);
        if (!match) return null;
        return {
          id: match.id,
          discountPaise: cl.discountPaise,
          taxablePaise: cl.taxablePaise,
          taxPaise: cl.taxPaise,
          cgstPaise: cl.cgstPaise,
          sgstPaise: cl.sgstPaise,
        };
      })
      .filter((x): x is BatchBillLineUpdate => x !== null);

    await batchUpdateBillLines(tx, lineUpdates);

    // 11. Update bill: loyaltyPointsRedeemed and loyaltyDiscountPaise always equal what is currently applied
    const [updatedBill] = await tx
      .update(bills)
      .set({
        loyaltyPointsRedeemed: pointsToRedeem,
        loyaltyDiscountPaise: newLoyaltyDiscountPaise,
        discountPaise: calculated.discountPaise,
        discountType: 'flat',
        discountValue: calculated.discountValue,
        discountReason: calculated.discountReason,
        serviceChargePaise: calculated.serviceChargePaise,
        taxPaise: calculated.taxPaise,
        roundOffPaise: calculated.roundOffPaise,
        totalPaise: calculated.totalPaise,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, bill.id))
      .returning();

    if (!updatedBill) {
      throw AppError.internal('Failed to update bill after loyalty redemption');
    }

    if (request) {
      await recordAuditLog({
        restaurantId,
        userId: userId || undefined,
        action: 'loyalty.redeem',
        entity: 'bill',
        entityId: bill.id,
        before: bill as unknown as Record<string, unknown>,
        after: updatedBill as unknown as Record<string, unknown>,
        request,
        tx,
      });
    }

    // Invalidate stale pending UPI QR payment requests since bill total has changed
    await tx
      .update(paymentRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(paymentRequests.billId, bill.id),
          eq(paymentRequests.restaurantId, restaurantId),
          eq(paymentRequests.status, 'pending'),
        ),
      );

    return {
      bill: updatedBill,
      account: updatedAccount!,
      pointsRedeemed: pointsToRedeem,
      discountPaise: newLoyaltyDiscountPaise,
      reversalTx,
      redeemTx: redeemTx!,
    };
  }
}
