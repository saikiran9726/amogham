# Feature Completeness Pass: Claims vs. Implementation

**Date**: 2026-10-12  
**Monorepo**: `@restaurant-os/monorepo`  
**Purpose**: Line-by-line audit comparing documentation claims (`README.md`, `docs/*.md`) against real code implementations, verifying tests, and identifying complete vs refined mechanisms.

---

## 1. Feature Claims & Verification Matrix

| Claimed Feature | Document | Code Implementation | Test Verification | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Multi-Tenant Scoping (Anti-IDOR)** | `docs/security-review.md`, `docs/tenancy.md` | `apps/api/src/db/tenant.ts` (`forTenant`), every route uses `tenant.db` with tenant filters | `tests/security-regression.test.ts` (all ROUTE_REGISTRY endpoints assert tenant isolation) | **Verified Complete** |
| **Token Versioning & Global Revoke** | `docs/security-review.md` | `apps/api/src/auth/jwt.ts`, `apps/api/src/auth/token-cache.ts` | `tests/auth.test.ts`, `tests/security-regression.test.ts` | **Verified Complete** |
| **Approver PIN Lockout & Argon2** | `docs/security-review.md` | `apps/api/src/auth/pin.ts` (Argon2 verification + atomic attempts lockout) | `tests/auth.test.ts` | **Verified Complete** |
| **Centralized Route Registry & Guards** | `docs/security-review.md` | `apps/api/src/auth/middleware.ts` (`ROUTE_REGISTRY`, `registerRouteGuard`) | `tests/security-regression.test.ts` (fails if route uncatalogued) | **Verified Complete** |
| **Customer Data Portability (`GET /export`)** | `docs/privacy.md` | `apps/api/src/routes/customers/manage.ts` (`GET /customers/:id/export`) | `tests/security-regression.test.ts`, `tests/customers.test.ts` | **Verified Complete** |
| **Customer Right to Erasure / Anonymization**| `docs/privacy.md` | `apps/api/src/routes/customers/manage.ts` (`DELETE /customers/:id`) | `tests/customers.test.ts` | **Verified Complete** |
| **Printer Control Code Injection Sanitization**| `docs/hardware-matrix.md` | `packages/shared/src/escpos/escpos-builder.ts` (`EscPosBuilder.sanitize`) | `packages/shared/src/escpos/escpos-builder.test.ts` | **Verified Complete** |
| **LAN Printer SSRF & Loopback Protection** | `docs/hardware-matrix.md` | `packages/shared/src/schemas/printer.ts` (`isValidLanPrinterAddress`) | `packages/shared/src/escpos/escpos-builder.test.ts` | **Verified Complete** |
| **UPI QR VPA & Cap Validation** | `docs/tax-and-billing.md` | `packages/shared/src/upi/upi-qr.ts` (VPA regex, NPCI Rs 1,00,000 cap) | `packages/shared/src/upi/upi-qr.test.ts` | **Verified Complete** |
| **CSV Formula Injection Defense** | `docs/security-review.md` | `packages/shared/src/serializers/csv.ts` (`escapeCsvCell`) used in all owner export portals | `packages/shared/src/serializers/csv.test.ts` | **Verified Complete** |
| **Menu Import & Inventory CSV Limits** | `docs/inventory-and-stock.md` | 2MB payload cap in `commitCsvImportSchema`, 5,000 row cap in `commitInventoryCsvImportSchema` | `packages/shared` typecheck & test suite | **Verified Complete** |
| **N+1 Query Elimination in Modifier Groups** | `docs/performance.md` | `apps/api/src/routes/modifiers.ts` (`inArray(modifiers.modifierGroupId, groupIds)`) | `tests/security-regression.test.ts` | **Verified Complete** |
| **Dexie Customer PII Purge on Logout** | `docs/privacy.md` | `apps/web/src/db/dexie.ts` (`purgeCustomerPiiAndReceipts`) | `apps/web/src/db/__tests__/dexie-privacy.test.ts` | **Verified Complete** |
| **Single-Writer Hub & Push/Pull Sync** | `docs/hub-setup.md`, `docs/offline.md` | `apps/api/src/services/hub/` (`HubSyncWorker`, machine routes `/hub/push`, `/hub/pull`) | `tests/hub-sync-dual-instance.integration.test.ts` | **Verified Complete** |
| **Atomic Database Backup & Verification** | `docs/hub-setup.md` | `docker/backup.sh`, `docker/restore-test.sh` | Bash runbook, checksum & gzip verification | **Verified Complete** |
| **Prometheus Observability Metrics** | `docs/hub-setup.md` | `apps/api/src/services/metrics.ts`, `apps/api/src/routes/metrics.ts` | `tests/security-regression.test.ts` | **Verified Complete** |
| **Axe Accessibility Zero Serious/Critical** | `docs/bundle-performance.md` | `apps/web/src/components/__tests__/axe-accessibility.test.tsx` | Vitest + Axe-core unit tests | **Verified Complete** |

---

## 2. Refinements Made During Audit

1. **Customer Data Export**:
   - `docs/privacy.md` detailed data portability, but `GET /customers/:id/export` was missing an endpoint implementation.
   - Added endpoint returning structured JSON of customer profile, loyalty transactions, and orders.
2. **Modifier Group N+1 Query**:
   - `GET /modifier-groups` previously executed a nested query per group. Replaced with single batched in-memory join using `inArray`.
3. **CSV Formula Injection**:
   - Several owner export buttons concatenated raw strings. Added RFC 4180 escaping with `'` prepending for formula trigger characters (`=`, `+`, `-`, `@`, `\t`, `\r`).
4. **LAN Printer Addressing**:
   - Hardware printer schema now strictly rejects loopbacks (`127.0.0.1`, `localhost`) and cloud metadata services (`169.254.169.254`).
