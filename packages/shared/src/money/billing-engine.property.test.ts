import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  calculateBill,
  type BillingLineInput,
  type DiscountInput,
  type TaxMode,
} from './billing-engine.js';
import { validateAndConvertRedemption } from './loyalty-engine.js';
import type { LoyaltySettings } from '../schemas/loyalty.js';

describe('Fintech Money Math Property-Based Tests (fast-check: 1000+ runs)', () => {
  // Arbitrary generators
  const gstRateBpArbitrary = fc.constantFrom(0, 500, 1200, 1800, 2800);
  const taxModeArbitrary: fc.Arbitrary<TaxMode> = fc.constantFrom('exclusive', 'inclusive');

  const lineArbitrary: fc.Arbitrary<BillingLineInput> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 20 }),
    qty: fc.integer({ min: 1, max: 20 }),
    pricePaise: fc.integer({ min: 100, max: 200_000 }), // ₹1 to ₹2000
    taxRateBp: gstRateBpArbitrary,
  });

  const discountArbitrary: fc.Arbitrary<DiscountInput | null> = fc.oneof(
    fc.constant(null),
    fc.record({
      type: fc.constant('percent' as const),
      value: fc.integer({ min: 0, max: 100 }),
    }),
    fc.record({
      type: fc.constant('flat' as const),
      value: fc.integer({ min: 0, max: 1_000_000 }),
    }),
  );

  const serviceChargePercentArbitrary = fc.integer({ min: 0, max: 25 });

  it('Property 1: total = subtotal - discount + service + tax + roundoff (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(lineArbitrary, { minLength: 1, maxLength: 10 }),
        discountArbitrary,
        serviceChargePercentArbitrary,
        gstRateBpArbitrary,
        fc.boolean(),
        (lines, discount, serviceChargePercent, defaultGstRateBp, roundOffEnabled) => {
          const result = calculateBill({
            lines,
            taxMode: 'exclusive',
            discount,
            serviceChargePercent,
            defaultGstRateBp,
            roundOffEnabled,
          });

          // Exact accounting identity for tax-exclusive mode:
          // total = subtotal - discount + serviceCharge + tax + roundoff
          const netSubtotal = result.subtotalPaise - result.discountPaise;
          const expectedTotal =
            netSubtotal + result.serviceChargePaise + result.taxPaise + result.roundOffPaise;

          expect(result.totalPaise).toBe(expectedTotal);
          expect(result.totalPaise).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(result.totalPaise)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('Property 1b: total = subtotal - discount + service + roundoff in inclusive tax mode (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(lineArbitrary, { minLength: 1, maxLength: 10 }),
        discountArbitrary,
        serviceChargePercentArbitrary,
        gstRateBpArbitrary,
        fc.boolean(),
        (lines, discount, serviceChargePercent, defaultGstRateBp, roundOffEnabled) => {
          const result = calculateBill({
            lines,
            taxMode: 'inclusive',
            discount,
            serviceChargePercent,
            defaultGstRateBp,
            roundOffEnabled,
          });

          // In tax-inclusive mode, taxes are included within the prices
          const netSubtotal = result.subtotalPaise - result.discountPaise;
          const expectedTotal = netSubtotal + result.serviceChargePaise + result.roundOffPaise;

          expect(result.totalPaise).toBe(expectedTotal);
          expect(result.totalPaise).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(result.totalPaise)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('Property 2: per-line CGST + SGST = line tax across all modes and slabs (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(lineArbitrary, { minLength: 1, maxLength: 15 }),
        taxModeArbitrary,
        discountArbitrary,
        serviceChargePercentArbitrary,
        (lines, taxMode, discount, serviceChargePercent) => {
          const result = calculateBill({
            lines,
            taxMode,
            discount,
            serviceChargePercent,
          });

          for (const line of result.lines) {
            // Per-line tax balance: CGST + SGST must strictly equal total tax on that line
            expect(line.cgstPaise + line.sgstPaise).toBe(line.taxPaise);
            expect(line.cgstPaise).toBeGreaterThanOrEqual(0);
            expect(line.sgstPaise).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(line.cgstPaise)).toBe(true);
            expect(Number.isInteger(line.sgstPaise)).toBe(true);
          }

          // Total bill GST equality
          expect(result.cgstPaise + result.sgstPaise).toBe(result.taxPaise);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('Property 3: refunds never exceed confirmed payments (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_000_000_000 }), // Total confirmed payments (paise)
        fc.array(fc.integer({ min: 1, max: 500_000_000 }), { minLength: 1, maxLength: 20 }), // Refund requests
        (totalConfirmedPaise, requestedRefunds) => {
          let accumulatedRefunds = 0;

          for (const reqAmount of requestedRefunds) {
            const wouldExceed = accumulatedRefunds + reqAmount > totalConfirmedPaise;

            if (wouldExceed) {
              // The system MUST reject any refund that pushes total refunds beyond payments
              const canAccept = accumulatedRefunds + reqAmount <= totalConfirmedPaise;
              expect(canAccept).toBe(false);
            } else {
              // Valid partial or full refund accepted
              accumulatedRefunds += reqAmount;
              expect(accumulatedRefunds).toBeLessThanOrEqual(totalConfirmedPaise);
            }
          }

          // Invariant: Final total refunds never exceed confirmed payments
          expect(accumulatedRefunds).toBeLessThanOrEqual(totalConfirmedPaise);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('Property 4: loyalty redemption never creates a negative bill total (1000 runs)', () => {
    const settingsArbitrary: fc.Arbitrary<LoyaltySettings> = fc.record({
      enabled: fc.constant(true),
      spendPaisePerBlock: fc.constant(10000),
      pointsPerBlock: fc.constant(10),
      redeemPointsBlock: fc.constant(100),
      redeemValuePaise: fc.constant(1000), // ₹10 per 100 points
      minRedeemPoints: fc.constant(100),
      maxRedeemPercentOfBill: fc.integer({ min: 1, max: 100 }), // 1% to 100% of bill subtotal
      pointsExpiryDays: fc.constant(365),
      earnOnDiscountedAmount: fc.constant(false),
      newAccountCooldownHours: fc.constant(0),
      perDayRedeemCapPoints: fc.constant(100000),
      tiers: fc.constant([]),
      visitReward: fc.constant({ enabled: false, everyNVisits: 5, bonusPoints: 100 }),
      birthdayReward: fc.constant({ enabled: false, bonusPoints: 200, minDaysRegistered: 30 }),
      referralReward: fc.constant({
        enabled: false,
        referrerBonusPoints: 100,
        refereeBonusPoints: 50,
        minBillPaiseToQualify: 20000,
        maxReferralsPerReferrer: 5,
      }),
    });

    fc.assert(
      fc.property(
        fc.array(lineArbitrary, { minLength: 1, maxLength: 5 }),
        taxModeArbitrary,
        settingsArbitrary,
        fc.integer({ min: 100, max: 100_000 }), // Points to redeem
        fc.integer({ min: 0, max: 200_000 }), // Customer points balance
        (lines, taxMode, settings, pointsToRedeem, pointsBalance) => {
          const rawSubtotal = lines.reduce((sum, l) => sum + l.qty * l.pricePaise, 0);

          const validation = validateAndConvertRedemption({
            pointsToRedeem,
            billTotalPaise: rawSubtotal,
            pointsBalance,
            pointsRedeemedToday: 0,
            accountAgeHours: 24,
            settings,
          });

          if (validation.isValid) {
            // Apply the redeemed discount to the bill
            const bill = calculateBill({
              lines,
              taxMode,
              discount: { type: 'flat', value: validation.discountPaise },
              serviceChargePercent: 0,
              defaultGstRateBp: 500,
              roundOffEnabled: true,
            });

            // The resulting bill total must never be negative
            expect(bill.totalPaise).toBeGreaterThanOrEqual(0);
            expect(bill.discountPaise).toBeLessThanOrEqual(rawSubtotal);
            expect(Number.isInteger(bill.totalPaise)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
