# Fintech-Grade Billing, Loyalty Redemption, Money Math & Concurrency Hardening Report

**Date**: 2026-10-12  
**Monorepo**: `@restaurant-os/monorepo` (Fastify 5 + Drizzle + PostgreSQL 18 | React 18 | Shared)  
**Database**: Isolated Scratch DB `restaurant_os_codex_test_1791778027846` on Local PostgreSQL 18.0  
**Audit Scope**: Financial precision, snapshotting, concurrency locking, loyalty ledger integrity, inventory race safety, property-based testing (1000+ iterations), and zero hardcoded recalculation parameters.

---

## 1. Executive Summary

All financial math in Restaurant OS operates strictly in integer paise (1 INR = 100 paise) to prevent IEEE 754 floating-point inaccuracies. Prior to this hardening cycle, several architectural risks were identified:

1. **Unsnapshotted Bill Parameters**: During recalculation (discount PATCH, loyalty redemption, refund), the billing engine relied on current restaurant settings or hardcoded defaults (`defaultGstRateBp: 500`, `roundOffEnabled: true`), altering historical tax calculations if settings changed.
2. **Loyalty Re-Redemption Failures**: A legacy global unique constraint `UNIQUE (bill_id, type)` on `loyalty_transactions` triggered PostgreSQL duplicate key errors if a customer attempted to re-redeem or reverse points on the same bill.
3. **Concurrency Races**:
   - In-flight loyalty redemption concurrent with full payment could result in overpayment or inconsistent state without row-level locks.
   - Inventory stock decrements read stock into memory and wrote it back without atomic SQL guards, allowing stock to go negative under concurrent usage.
4. **Unbounded Payment & Refund Payloads**: Zod schemas allowed arbitrary integer sizes without upper bounds.
5. **Duplicate Loyalty Accrual**: Retried payment confirmations could attempt duplicate loyalty earn transactions.

All identified vulnerabilities have been remediated, verified via integration tests on real PostgreSQL 18, and validated through property-based fuzzing with `fast-check` over 1,000 runs per invariant.

---

## 2. Architecture & Implementation Changes

### 2.1 Database Migration `0018_bill_tax_and_rounding_snapshots`

- **Bill Snapshot Columns**: Added `tax_mode` (text default 'exclusive'), `service_charge_percent` (numeric(5,2) default 0), `default_gst_rate_bp` (integer default 500), and `round_off_enabled` (boolean default true) to the `bills` table.
- **Backfill**: Existing bills backfilled from `restaurant_settings` to preserve integrity for historical records.
- **Loyalty Ledger Index Fix**: Dropped constraint `uq_loyalty_tx_bill_type` (`UNIQUE (bill_id, type)`) on `loyalty_transactions`. Replaced with partial unique index:
  ```sql
  CREATE UNIQUE INDEX uq_loyalty_tx_bill_earn ON loyalty_transactions(bill_id) WHERE type = 'earn';
  ```
  This guarantees that a bill earns loyalty points at most once, while allowing multiple `redeem` and `reversal` records as an append-only audit ledger.
- **Round-Trip Cleanliness**: Verified `pnpm db:migrate` up and down migrations; all 47 migration tests in `migrations.test.ts` pass.

### 2.2 Extraction of `LoyaltyRedemptionService`

Extracted from `apps/api/src/routes/bills.ts` (~L796-1015) into `apps/api/src/services/billing/LoyaltyRedemptionService.ts`:

- **Concurrency Row Locking**: Acquired `SELECT ... FOR UPDATE` on `bills` within an isolated PostgreSQL transaction before calculating or mutating totals.
- **Replaceable Discount Architecture**:
  - `otherDiscount = discountPaise - loyaltyDiscountPaise`
  - When re-redeeming on an unpaid bill:
    1. Prior points credited back via an append-only `reversal` ledger entry.
    2. Account points balance incremented by prior points.
    3. New points verified against available balance and daily caps.
    4. New `redeem` ledger entry written.
    5. Active snapshot fields updated: `loyaltyPointsRedeemed = newPoints`, `loyaltyDiscountPaise = newDiscount`.
- **Negative Bill Total Rejection**: Redemptions that would push `totalPaise < 0` are rejected immediately with HTTP 400.
- **Business Date Cap Window**: Daily customer redemption caps are calculated using `getBusinessDateStartUtc(currentBusinessDate, dayStartHour, timezone)` instead of server-local midnight.
- **Batched Statement Updates**: Bill lines are updated by primary key in a single batch statement via `batchUpdateBillLines`.

### 2.3 Elimination of Hardcoded Recalculation Defaults

Every recalculation path across the API now strictly references snapshotted columns from the locked `bills` row:

- `apps/api/src/routes/bills.ts` (discount modification):
  ```ts
  const calculated = calculateBill({
    lines: billingLines,
    taxMode: bill.taxMode,
    discount: { type: 'flat', value: totalDiscountPaise, reason: body.reason },
    serviceChargePercent: Number(bill.serviceChargePercent) || 0,
    defaultGstRateBp: bill.defaultGstRateBp,
    roundOffEnabled: bill.roundOffEnabled,
  });
  ```
- `apps/api/src/services/billing/LoyaltyRedemptionService.ts` (loyalty redemption):
  ```ts
  const calculated = calculateBill({
    lines: billingLines,
    taxMode: bill.taxMode,
    discount: { type: 'flat', value: totalCombinedDiscountPaise, ... },
    serviceChargePercent: Number(bill.serviceChargePercent) || 0,
    defaultGstRateBp: bill.defaultGstRateBp,
    roundOffEnabled: bill.roundOffEnabled,
  });
  ```
- **Audit Verification**: Zero instances of `roundOffEnabled: true` or hardcoded `500` exist in recalculation code.

### 2.4 Second-Pass Review Defect Fixes

1. **Inventory Stock Race Condition**:
   - In `apps/api/src/services/inventory.ts`, `recordUsage`, `recordWaste`, and `editPurchase` previously performed in-memory subtraction before updating.
   - Enforced atomic SQL update with stock floor guard:
     ```ts
     const [updated] = await tx
       .update(inventoryItems)
       .set({ currentStock: sql`${inventoryItems.currentStock} - ${qty}` })
       .where(and(eq(inventoryItems.id, itemId), sql`${inventoryItems.currentStock} >= ${qty}`))
       .returning();
     if (!updated) {
       throw AppError.badRequest('Insufficient inventory stock');
     }
     ```
2. **Loyalty Earn Retries**:
   - In `apps/api/src/services/loyalty.ts` (`processBillPaidLoyaltyEarn`), added `onConflictDoNothing()` on the earn transaction insert. Payment confirmation retries cannot generate duplicate earn records.
3. **Zod Money Caps**:
   - In `packages/shared/src/schemas/billing.ts`, added `.max(1_000_000_000)` (₹10,000,000.00 / ₹1 crore) to `RecordPaymentSchema` and `RefundBillSchema` to prevent integer overflow and runaway figures.

---

## 3. Property-Based Test Verification (`fast-check`)

Implemented in `packages/shared/src/money/billing-engine.property.test.ts`. 5 mathematical invariants verified across 1,000 executions each:

| Property       | Invariant Tested                                                                             | Configurations Covered                                                                                                                         |        Result         |
| :------------- | :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------: |
| **Property 1** | Accounting Identity: `total = subtotal - discount + serviceCharge + tax + roundoff`          | Arbitrary lines (1–10), flat & percent discounts, service charges (0–25%), GST slabs (0, 500, 1200, 1800, 2800 bp), round-off enabled/disabled | **PASS (1,000 runs)** |
| **Property 2** | Per-line Tax Balance: `cgstPaise + sgstPaise = line.taxPaise`                                | Inclusive & Exclusive tax modes, 1–15 line items, arbitrary price points (₹1–₹2,000), odd/even rounding                                        | **PASS (1,000 runs)** |
| **Property 3** | Refund Bounding: Line refund $\le$ line total; bill refund $\le$ bill total                  | Multi-line bills, partial refunds across items, arbitrary prices                                                                               | **PASS (1,000 runs)** |
| **Property 4** | Line Item Rounding Invariant: Integer paise consistency                                      | Quantities (1–100), price points (₹0.01–₹10,000.00), arbitrary GST slabs                                                                       | **PASS (1,000 runs)** |
| **Property 5** | Loyalty Redemption Balance: Resulting bill total is non-negative and discount $\le$ subtotal | Raw subtotals (₹10–₹1,000), redemption rates (10–100 pts per ₹), lifetime spend                                                                | **PASS (1,000 runs)** |

---

## 4. Real PostgreSQL Database Integration Tests

Executed against isolated test database `restaurant_os_codex_test_1791778027846`:

| Test Case                                          | Verification Details                                                                                                                           |  Result  |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :------: |
| `redeems twice on one bill`                        | Prior points credited back via reversal ledger entry; new redemption applied; points balance restored and re-debited; total updated accurately | **PASS** |
| `redeem then pay`                                  | Bill total reduced by loyalty discount; subsequent payment of exact reduced total marks bill `paid`                                            | **PASS** |
| `redeem concurrent with payment`                   | Concurrency row lock (`FOR UPDATE`) serializes operations; attempt to pay pre-discount total fails with remaining balance cap                  | **PASS** |
| `tax-inclusive and exclusive restaurants`          | Snapshotted `tax_mode` on bill respected during redemption recalculation regardless of altered restaurant settings                             | **PASS** |
| `non-default service charge`                       | Snapshotted service charge percent preserved accurately across multiple loyalty redemptions                                                    | **PASS** |
| `negative bill total rejection`                    | Rejection of redemption when discount exceeds total; bill left unmodified                                                                      | **PASS** |
| `retried payment loyalty earn idempotency`         | Retried payment confirmations on same bill do not create duplicate earn ledger entries                                                         | **PASS** |
| `negative stock prevention under concurrent usage` | Parallel usage requests attempting to exceed inventory stock fail atomically with 400                                                          | **PASS** |
| `business date cap window boundary`                | Cap resets at configured business day start hour (e.g. 05:00), not server-local midnight                                                       | **PASS** |

---

## 5. Monorepo Verification Matrix

All test suites and static analysis tools passed cleanly:

- **Typecheck**: `pnpm typecheck` (0 errors across `shared`, `web`, `api`)
- **Shared Tests**: `pnpm --filter @restaurant-os/shared test` (15/15 files, 103/103 passed)
- **API Tests**: `pnpm --filter @restaurant-os/api test` (34/34 files, 347/347 passed, 0 skipped)
- **Web Tests**: `pnpm --filter @restaurant-os/web test` (21/21 files, 88/88 passed)
- **Lint**: `pnpm lint` (0 errors)

---

## 6. Gate Compliance Statement

- **Property Tests**: Pass with 1000+ runs each across all 5 properties without failure or timeouts.
- **Snapshot Parameters**: Zero hardcoded `500` or `roundOffEnabled: true` remain in recalculation code. All recalculations derive configuration directly from snapshotted bill record columns.
- **Code Standards**: Zero `any` casts in property tests, zero mocks of crypto/database in integration tests.
