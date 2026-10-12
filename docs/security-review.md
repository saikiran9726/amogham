# RestaurantOS Security & Access Control Review

## 1. Executive Summary & Security Objectives

RestaurantOS is an enterprise-grade restaurant point-of-sale and kitchen management platform designed for multi-tenant and local edge environments. Its security architecture enforces:

- **Strict Multi-Tenant Isolation (Anti-IDOR):** Complete isolation between distinct restaurant instances across every database query and API endpoint.
- **Principle of Least Privilege (RBAC):** Tight permission boundaries across 5 roles (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`, `KITCHEN`).
- **Response Shaping:** Waiter and Kitchen staff endpoints mathematically omit executive analytics, supplier purchase costs, ingredient margins, and customer PII beyond necessary order metadata.
- **Edge Durability Security:** Local Hub and standalone outbox sync protocols authenticate all batch operations using HMAC device tokens and restaurant boundaries.

---

## 2. Threat Model & OWASP ASVS Adherence

| Vulnerability Category                          | Mitigation Mechanism in RestaurantOS                                                                                                                                | Verification Status                                                            |
| :---------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------- |
| **Broken Access Control (A01:2021)**            | Fastify pre-handler permission matrix (`requirePermission`), tenant context extraction from verified JWT, explicit check that request tenant matches target entity. | Verified in `tests/permission-matrix.test.ts` & `tests/security-audit.test.ts` |
| **Cryptographic Failures (A02:2021)**           | Passwords and PINs hashed using Argon2id/bcrypt. Local Hub IPC tokens signed via HMAC-SHA256. All communications enforce TLS 1.3.                                   | Automated unit tests verified                                                  |
| **Injection (A03:2021)**                        | Parameterized SQL queries throughout `pg` pool. Strict Zod schema validation on all route parameters, queries, and request bodies.                                  | 100% parameterization audited                                                  |
| **Insecure Design (A04:2021)**                  | Response shaping removes purchase costs and profitability numbers before serializing payloads to non-owner roles.                                                   | Verified in `tests/security-audit.test.ts`                                     |
| **Security Misconfiguration (A05:2021)**        | Fastify Helmet configured with strict CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.                                                        | Verified in `tests/security-audit.test.ts`                                     |
| **Vulnerable & Outdated Components (A06:2021)** | Automated dependency audits (`pnpm audit`). Strict pinned dependencies in `package.json`.                                                                           | Clean audit                                                                    |
| **Identification & Auth Failures (A07:2021)**   | Rate limiting on auth endpoints (max 5 failed attempts before temporary lockout). JWT tokens with short lifetimes and refresh cycles.                               | Rate limiter active                                                            |
| **Data Integrity Failures (A08:2021)**          | Idempotency keys (`sync_commands`), monotonically increasing event cursors, dead-letter quarantine for conflicting offline mutations.                               | Verified in `tests/sync.test.ts`                                               |
| **Security Logging & Monitoring (A09:2021)**    | Immutable `audit_logs` table tracking all destructive actions (voids, comps, PIN overrides, drawer opens).                                                          | Verified in `tests/billing.test.ts`                                            |
| **Server-Side Request Forgery (A10:2021)**      | Zero user-controllable outbound HTTP requests. Local Hub only connects to configured upstream server.                                                               | Architectural design                                                           |

---

## 3. RBAC Matrix & Route Permissions

| Endpoint / Resource                    | OWNER | MANAGER | CASHIER  | WAITER | KITCHEN | Required Permission  |
| :------------------------------------- | :---: | :-----: | :------: | :----: | :-----: | :------------------- |
| `GET /api/v1/menu`                     |  ✅   |   ✅    |    ✅    |   ✅   |   ✅    | `menu.read`          |
| `POST /api/v1/orders`                  |  ✅   |   ✅    |    ✅    |   ✅   |   ❌    | `orders.create`      |
| `POST /api/v1/orders/:id/kot`          |  ✅   |   ✅    |    ✅    |   ✅   |   ❌    | `kots.dispatch`      |
| `GET /api/v1/kots`                     |  ✅   |   ✅    |    ✅    |   ❌   |   ✅    | `kots.read`          |
| `PATCH /api/v1/kots/:id/items/:itemId` |  ✅   |   ✅    |    ✅    |   ❌   |   ✅    | `kots.update`        |
| `POST /api/v1/bills`                   |  ✅   |   ✅    |    ✅    |   ❌   |   ❌    | `billing.create`     |
| `POST /api/v1/bills/:id/payments`      |  ✅   |   ✅    |    ✅    |   ❌   |   ❌    | `billing.pay`        |
| `POST /api/v1/bills/:id/refund`        |  ✅   |   ✅    | ❌ (PIN) |   ❌   |   ❌    | `billing.refund`     |
| `GET /api/v1/reports/sales`            |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `report.read`        |
| `GET /api/v1/reports/eod`              |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `report.read`        |
| `GET /api/v1/reports/profitability`    |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `profitability.read` |
| `GET /api/v1/inventory/items`          |  ✅   |   ✅    |    ❌    |   ❌   |   ❌    | `inventory.read`     |
| `POST /api/v1/inventory/purchases`     |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `inventory.manage`   |
| `GET /api/v1/health-score`             |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `health.read`        |
| `GET /api/v1/alerts`                   |  ✅   |   ❌    |    ❌    |   ❌   |   ❌    | `alerts.read`        |
| `POST /api/v1/sync/push`               |  ✅   |   ✅    |    ✅    |   ✅   |   ✅    | `sync.execute`       |

---

## 4. Response Shaping & Information Leakage Prevention

Non-executive roles are prevented from seeing sensitive financial data:

1. **Menu & Item Endpoints:** When queried by `WAITER` or `KITCHEN`, responses include display name, category, dietary tags (Veg/Non-Veg), variant options, and selling price. Unit preparation costs (`cost_paise`), supplier details, and gross margin percentages are filtered out at the serialization layer.
2. **Customer Endpoints:** Waiters can view loyalty tiers and available points for redemption on table checkout, but total lifetime spend, home address, and raw phone numbers are masked (`+91 98XXX XX123`).
3. **Bill & Discount Endpoints:** Cashiers and waiters cannot view owner override PINs or manager discount ceilings in response payloads.

---

## 5. Multi-Tenant Isolation & Anti-IDOR Defense

Every tenant request is bound by two independent factors:

- **JWT Claims:** The authenticated user's token includes `restaurant_id`.
- **Tenant Header:** Client requests include `X-Restaurant-Id`.
- **Enforcement Rule:** If `X-Restaurant-Id` differs from the token's `restaurant_id`, Fastify immediately aborts with `403 Forbidden` (`TENANT_MISMATCH`).
- **Data Layer Rule:** All SQL queries join against or explicitly filter by `restaurant_id = $1`. Entity lookups (`orders`, `bills`, `kots`, `customers`) enforce composite keys `WHERE id = $id AND restaurant_id = $restaurant_id`.

---

## 6. Authentication Hardening, Role Hierarchy, & PIN Login Policy

### Role Hierarchy & Staff Management RBAC

RestaurantOS enforces strict hierarchical privilege separation:
$$\text{OWNER (4)} > \text{MANAGER (3)} > \text{CASHIER (2)} > \text{WAITER (1)} = \text{KITCHEN (1)}$$

- **Strictly Lower Rank Authority:** Actors may create, update, deactivate, or administratively reset credentials only for staff members of strictly lower rank.
- **Owner-Exclusive Creation & Promotion:** Only an `OWNER` may create an `OWNER` or `MANAGER`, or promote any user to `OWNER` or `MANAGER`. A `MANAGER` is strictly prohibited from creating or promoting another manager or owner.
- **Self-Modification Prevention:** No user may alter their own assigned role or deactivate their own account.
- **Last-Owner Invariant:** The system prevents deactivation or role demotion of the last active owner of any restaurant.

### Anti-Enumeration & Constant-Time Login Defense

- **Side-Channel Timing Defense:** When a login request specifies an unknown username or inactive account, the server executes a dummy Argon2id verification with equivalent computational parameters ($m=19456\text{ KiB}, t=2, p=1$). This standardizes response latency and prevents timing-based username enumeration.
- **Uniform Error Envelope:** All login failures—including non-existent users, deactivated accounts, locked accounts, and incorrect credentials—return identical HTTP 401 status codes and generic error envelopes (`{"error": {"code": "UNAUTHORIZED", "message": "Invalid username or credential"}}`). Detailed failure causes are recorded solely within internal server audit logs.
- **Atomic Concurrency-Safe Lockout:** Failed attempt increments and lockout activation are performed via a single atomic database statement (`UPDATE users SET failed_attempts = failed_attempts + 1, locked_until = CASE ... RETURNING`). This eliminates concurrency race conditions during parallel credential brute-force attacks.

### PIN Login Security Architecture

- **Password Requirement for Management Roles (`OWNER` and `MANAGER`):** High-privilege administrative accounts require high-entropy passwords during `/auth/login`. PIN-based system login is restricted to operational terminal roles (`WAITER`, `KITCHEN`, `CASHIER`).
- **In-Person Floor Overrides:** Owners and managers retain a secure PIN hash solely for authorizing localized floor overrides (`verifyApproverPin`) on shared staff POS terminals (e.g., manager discount approvals, bill reprint authorizations, KOT void approvals, and EOD reopens). These approvals are subjected to atomic per-attempt lockout checks and dedicated rate limits (10/min per user).

### Proxy Trust & Rate Limiting

- **Zero-Trust Proxy Configuration:** The `TRUST_PROXY` environment variable defaults to `false`. When unset or false, `request.ip` resolves exclusively to the direct network socket address, preventing attackers from evading rate limits using spoofed `X-Forwarded-For` headers.
- **Loopback Allowlist:** Local loopback addresses (`127.0.0.1`, `::1`) are exempt from rate limiting strictly during automated test runs (`NODE_ENV=test`).
- **Route-Specific Throttling:**
  - `POST /auth/login`: 10 requests/minute per IP, and 5 requests/minute per IP + username pair.
  - `POST /auth/refresh`: 30 requests/minute per IP.
  - Floor Approval Overrides: 10 authorization requests/minute per user.
- **Modular Store Architecture:** The rate limiting subsystem is decoupled behind an `IRateLimitStore` interface, enabling in-memory execution in single-instance deployments and seamless migration to distributed Redis backends in clustered configurations.
