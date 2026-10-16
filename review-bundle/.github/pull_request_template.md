## Summary of Changes

<!-- Provide a concise description of what changed and why -->

## Security Checklist

Please verify the following requirements before merging:

- [ ] **Tenant Isolation**:
  - [ ] Every database query uses tenant scoping (`forTenant(restaurantId)` or `where(eq(..., restaurantId))`).
  - [ ] No endpoint accepts `restaurantId` in query parameters or request body from client callers.
  - [ ] Cross-tenant resource IDs return 404 (or 403 where forbidden).
  - [ ] RLS policies (if enabled) remain intact and enforced.

- [ ] **Authentication & Authorization**:
  - [ ] Every route is registered with appropriate guards (`requirePermission(...)` or `isPublic: true`) and logged in `ROUTE_REGISTRY`.
  - [ ] Unauthenticated requests return `401 Unauthorized`.
  - [ ] Missing required role permissions return `403 Forbidden`.
  - [ ] Sensitive actions (reprints, voids, manager discounts) require valid PIN approval and audit trail.

- [ ] **Financial & Concurrency Integrity**:
  - [ ] All money calculations use integer paise and shared engine math (no JavaScript floating point arithmetic).
  - [ ] Idempotency keys (`idempotency-key` / `syncCommands`) protect state-mutating requests against duplicate execution.
  - [ ] Concurrent operations (settlements, redemptions, KOT generations) use transactional locking (`FOR UPDATE` / advisory locks).

- [ ] **Testing & Quality Gates**:
  - [ ] All new logic is covered with automated tests (unit or integration with real database).
  - [ ] `apps/api/tests/security-regression.test.ts` passes.
  - [ ] `apps/api/tests/concurrency-chaos.integration.test.ts` passes.
  - [ ] `pnpm audit --prod --audit-level=high` reports zero high/critical vulnerabilities.
  - [ ] No secrets or unencrypted PII are logged or stored in Dexie/local storage.
