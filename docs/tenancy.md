# Tenancy & Row-Level Security Architecture

## 1. Overview & Evaluation

Restaurant OS was evaluated for multi-tenant data isolation approaches:
1. **Application-Layer Scoping**: Enforced via `forTenant(restaurantId)` context helpers in `apps/api/src/db/tenant.ts`, ensuring that all queries, inserts, updates, and deletes automatically scope predicates to `restaurant_id = restaurantId`.
2. **Postgres Row-Level Security (RLS)**: Enforced via PostgreSQL policies with session variables `SET LOCAL app.restaurant_id = $restaurantId` within transactional blocks.
3. **Physical Database Isolation (Single-Tenant Edge Hub)**: Dedicated database instance per physical store (`MULTI_TENANT=false`).

---

## 2. Row-Level Security (RLS) Evaluation

### Mechanism Evaluated
- Tables: `bills`, `bill_lines`, `payments`, `orders`, `order_items`, `customers`, `loyalty_accounts`, `loyalty_transactions`, `users`.
- Policy:
  ```sql
  ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation_policy ON bills
    USING (restaurant_id = NULLIF(current_setting('app.restaurant_id', true), '')::uuid);
  ```
- Fastify / Drizzle integration: Within `TenantContext.withTx`:
  ```ts
  if (env.ENABLE_RLS) {
    await tx.execute(sql`SET LOCAL app.restaurant_id = ${this.restaurantId}`);
  }
  ```

### Key Findings & Tradeoffs

1. **Connection Pooling & Session Parameter Leakage**:
   - The application relies on `pg-pool` with persistent connections.
   - Using session-level `SET app.restaurant_id` risks cross-request parameter contamination if a connection is returned to the pool without reset.
   - `SET LOCAL` mitigates this by scoping the parameter strictly to the current transaction. However, this necessitates that **every read query be wrapped in an explicit `BEGIN ... COMMIT` transaction**, introducing measurable connection lock contention and transaction overhead on read-heavy routes (`GET /menu`, `GET /kots`, `GET /bills`).

2. **Drizzle ORM & Superuser Bypass**:
   - Drizzle migrations and maintenance scripts run as the database owner, which bypasses RLS unless `FORCE ROW LEVEL SECURITY` is explicitly set.
   - Certain system-level jobs (e.g. background cleanup jobs, audit purges, superuser seeders) require bypassing tenant boundaries, necessitating careful role switching (`NOBYPASSRLS` vs `BYPASSRLS`).

3. **Edge Hub Single-Tenant Reality (`MULTI_TENANT=false`)**:
   - The primary deployment topology for Restaurant OS is local edge appliances (mini-PCs, N100 servers) installed directly inside the restaurant.
   - Under `MULTI_TENANT=false`, the entire database instance is dedicated to exactly one store. Physical isolation renders RLS redundant while imposing unnecessary query overhead.

---

## 3. Architecture Decision

- **Primary Defense**: Application-layer tenant isolation enforced via `forTenant(restaurantId)`. Routes and services are prohibited from importing the bare database client directly (`no-restricted-imports` lint rule).
- **Secondary Defense (Feature-Flagged RLS)**: Configured behind `ENABLE_RLS=false` (default). When enabled, `withTx` in `tenant.ts` dispatches `SET LOCAL app.restaurant_id` on all transactions.
- **Edge Hub Mode**: In production, `MULTI_TENANT=false` verifies at startup that exactly 1 restaurant exists, halting startup if multi-store contamination is detected.
