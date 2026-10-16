# Tenancy Architecture & Isolation Model

## 1. Core Architectural Principle: Single-Tenant Strict Enforcement

Restaurant OS is engineered, evaluated, and deployed under a **strict single-tenant architecture**:

- **Physical Store Topology**: Each physical restaurant deployment operates on a dedicated Edge Hub appliance (e.g., local mini-PC or fanless server) or a dedicated database instance per physical location (`MULTI_TENANT=false`).
- **Physical & Process Isolation**: Complete database and host isolation provides the highest operational resilience and security boundary for mission-critical operations (POS, KOTs, billing, payments, and offline resilience during internet WAN dropouts).
- **No Shared Database Multi-Tenancy**: Restaurant OS does **not** rely on shared multi-tenant database catalogs or row-level multi-tenant pooling.

---

## 2. Application-Enforced Tenancy Scoping

Within the application and service layers, data isolation is strictly application-enforced:

1. **Tenant Context Helper (`forTenant`)**:
   - All tenant-scoped operations must flow through `forTenant(restaurantId)` in `apps/api/src/db/tenant.ts`.
   - `TenantContext` automatically and deterministically bounds all `SELECT`, `INSERT`, `UPDATE`, and `DELETE` queries to `restaurant_id = :restaurantId`.
2. **Architectural Boundary Enforcement**:
   - Direct, unscoped database client imports (`import { db } from '../db/client.js'`) are strictly prohibited in business routes and domain services via ESLint `no-restricted-imports` lint rules.
   - Authentication middleware validates cryptographic JWT claims, extracting `restaurant_id` and binding it immutably to Fastify request state (`request.user.restaurantId`).
3. **Defense Against Cross-Tenant Tampering**:
   - Route handlers reject any attempt by clients to supply or tamper with `restaurant_id` in headers, query parameters, or request bodies.
   - Route parameters identifying resources (`/bills/:id`, `/kots/:id`, `/customers/:id`) verify tenant ownership in their WHERE clauses and return 404 for non-owned entities.

---

## 3. Evaluation & Removal of Misleading Database RLS Flags

Earlier architectural designs evaluated feature-flagging PostgreSQL Row-Level Security (`ENABLE_RLS`) alongside application scoping using session-variable policies (`SET LOCAL app.restaurant_id`).

Thorough engineering evaluation demonstrated that database-level session-variable RLS introduces critical operational risks in high-concurrency Node.js database pool environments:

1. **Connection Pooling & Session Parameter Contamination**:
   - The API relies on connection pools (`pg-pool`) with long-lived pooled sockets.
   - Using session-level variables risks parameter bleeding across disparate requests if a connection is returned to the pool without explicit deallocation or reset.
   - Mitigating with `SET LOCAL` requires wrapping **every single read query** in an explicit `BEGIN ... COMMIT` transaction, introducing measurable database roundtrip latency and transaction lock contention on high-frequency POS read endpoints (`GET /menu`, `GET /kots`, `GET /bills`).
2. **Superuser & Migration Bypass**:
   - Drizzle ORM migrations and background database maintenance jobs connect using credentials that bypass RLS by default unless `FORCE ROW LEVEL SECURITY` is applied to all tables.
3. **Architectural Mismatch & False Security Sense**:
   - Because Restaurant OS is deployed as dedicated single-tenant Edge Hubs, database-level RLS provides no additional isolation while adding runtime latency and administrative complexity.
   - Maintaining phantom `ENABLE_RLS` flags created a false impression of multi-tenancy support when no underlying RLS policies existed in the database schema migrations.

**Decision**: The misleading `ENABLE_RLS` configuration flag and phantom `SET LOCAL` hooks have been completely removed from the repository. Tenancy is strictly single-tenant and application-enforced.

---

## 4. Startup Validation Guards

To guarantee that deployments conform strictly to this architectural model, the API entry point (`apps/api/src/index.ts` via `verifyTenancyStartupGuards` in `apps/api/src/db/tenant.ts`) executes strict boot-time validation:

### A. Single-Tenant Mode Guard (`MULTI_TENANT=false`, Default)

- In production (`NODE_ENV=production`), the server verifies at startup that exactly **one** restaurant record exists in the database (`existingRestaurants.length === 1`).
- If 0 or more than 1 restaurant row exists, startup is immediately halted with a fatal error to prevent multi-tenant contamination or invalid cluster state.

### B. Multi-Tenant Mode Guard (`MULTI_TENANT=true`)

- If an operator attempts to configure `MULTI_TENANT=true`, the startup guard queries PostgreSQL catalog tables:
  ```sql
  SELECT count(*)::int AS count FROM pg_policy;
  ```
- Because Restaurant OS does not maintain or support database-level RLS migrations, the server verifies whether valid policies exist. If 0 policies are found in `pg_policy`, startup is immediately aborted with a fatal error:
  > `MULTI_TENANT=true requires verified database-level RLS policies in PostgreSQL, but 0 policies were found in pg_policy. Tenancy isolation is application-enforced and structured for single-tenant deployments. Halting startup to prevent cross-tenant data leakage.`
- This fail-fast guard guarantees that Restaurant OS can never be erroneously exposed as a shared multi-tenant cluster without verified database-level RLS policies in place.
