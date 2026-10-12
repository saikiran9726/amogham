# Restaurant OS release-readiness checklist

Updated 2026-10-11. Final audit status: **NOT READY FOR PILOT**.

## Verified in this workspace

- [x] Monorepo scripts, API/web/shared packages, route structure, existing schema/migration inventory, and environment-variable names inspected. Secret values were not read into output.
- [x] Existing working-tree changes preserved; no reset, database reset, migration, or operational-record write performed.
- [x] Web unit tests: 21 files / 86 tests passed.
- [x] Shared unit tests: 14 files / 97 tests passed.
- [x] Isolated API regression tests passed after the current changes: 7 files / 36 tests (settlement, sync-engine payment safety, KOT idempotency/table state, printing authorization, customer request validation, and tax mode). These tests use mocks; they are not database integration tests.
- [x] Workspace TypeScript checks and production builds passed after the current changes.
- [x] Lint completed with zero errors and 631 warnings repository-wide; the pre-existing warning backlog has not been mass-edited.
- [x] `git diff --check` passed after the current changes.
- [x] Windows metadata inspection initially failed in the restricted shell because Service Control Manager, CIM, and loopback sockets were denied. Read-only elevated checks succeeded; no project configuration fault caused that denial.
- [x] Native PostgreSQL 18 service `postgresql-x64-18` is running from `C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe` with data directory `C:\Program Files\PostgreSQL\18\data`. API is already listening on 4000 and Vite on 5173; no duplicate production-like dev servers were started.
- [x] Fresh API `GET /health`: HTTP 200, `status=ok`, `db=connected`. Fresh frontend GET on its IPv6 localhost binding: HTTP 200.
- [x] Docker is unavailable; the optional Compose file specifies PostgreSQL 16. The active native PostgreSQL 18 service was used for isolation.
- [x] A uniquely named empty PostgreSQL 18 test database, `restaurant_os_codex_test_1791730780050`, was created after verifying the source connection identified `restaurant_os` and confirming the test target identity. All 15 project migrations were applied only to this test database.
- [x] API KOT, sync, and billing integration tests: 3 files / 32 tests passed against the isolated DB; post-test SELECT counts were 0 orders, 0 KOTs, 0 bills, and 0 payments.
- [x] Real DB workflow regression tests: duplicate KOT submission created one KOT, KOT completion emitted one ready-status Socket.IO event and appeared Ready to both waiter/kitchen feed requests; concurrent online same-key payment retried idempotently; concurrent UPI confirmation settled once; offline same-key retry and distinct-key overpayment behaved safely. These tests ran against the isolated database.
- [x] Combined API verification: 11 files / 72 tests passed against the isolated PostgreSQL 18 database. The test database now contains test-only fixtures; it was retained and not reset or dropped.
- [x] Full existing Playwright suite: 48 tests passed using separate Vite/API ports (5174/4400), with API connected only to the isolated test database. These tests exercise portal shells, responsiveness/accessibility, and limited UI scenarios; they do not complete the authenticated waiter-to-kitchen business workflow.
- [x] Real database payment regressions also verified concurrent distinct-key overpayment rejection and protection against releasing a table reassigned to another order; fixtures remained confined to the isolated test database.
- [x] Earlier read-only live API snapshots showed Ready KOTs #7–#10 in kitchen and waiter feed, including takeaway KOT #10. No current user browser tab was attached for console/network inspection.
- [x] Acceptance-session availability checked: the built-in browser initially had no open tabs or connected app session. A new tab was opened on the isolated `/login` page; it did not attach the user's authenticated session, so no authenticated UI actions were attempted.
- [x] Payment integration inventory checked without reading environment values: the root environment contains no payment-provider configuration keys, and the source contains no external payment gateway/webhook integration. The app records supported payment methods internally; there is no configured provider sandbox to test.
- [x] Physical printer validation remains pending until the supported printer hardware is available.
- [x] Acceptance stack started only because ports 4400 and 5174 were free. API port 4400 uses the isolated test database; web port 5174 targets API 4400. Existing live services on 4000/5173 were left running.
- [x] Isolated stack checks: read-only PostgreSQL identity check confirmed `restaurant_os_codex_test_1791730780050`, PostgreSQL 18, port 5432 before API launch; `GET http://127.0.0.1:4400/health` returned HTTP 200 with `db=connected`; `GET http://127.0.0.1:5174/login` returned HTTP 200. A new browser tab displayed the isolated login page, but it was not the existing authenticated session.
- [x] Read-only isolated account inventory found 8 user rows, 0 roles, and 0 active password accounts with a role assignment. Existing integration fixtures issue JWTs directly and do not create browser-login accounts. No credentials were present to use; no seed or user creation was performed.
- [x] Acceptance follow-up re-inspected the additive seed, login flow, role/permission schema, Owner Staff UI, waiter/KOT, kitchen status, notification, and reconnect flows. A temporary hidden-password runner was prepared to verify the isolated DB identity, seed one owner, create waiter/kitchen accounts through Owner Staff, and test only isolated data. The prompt ran in an exec PTY that the Codex terminal panel could not attach to, so no passwords were entered and the runner was stopped before database verification or writes. Temporary runner files were removed. No seed, account, table, order, or KOT was created in this attempt.

## Outstanding before pilot

- [ ] Complete authenticated browser acceptance of a separate test order: waiter create/save and submit KOT → kitchen sees it and marks Ready → waiter receives one visible notification and refreshed feed. Existing Playwright portal tests cover shells/responsiveness/accessibility; they do not complete this workflow. API and Socket.IO integration behavior is verified separately. This attempt did not reach account setup because the hidden password prompt could not be exposed in the Codex terminal panel.
- [ ] Complete owner-portal operational acceptance (including a test-only owner action and its persistence) using the isolated test stack. Current owner component tests use mocked API responses. No owner login or write action was attempted.
- [ ] Complete offline/reconnect browser acceptance on isolated data. Current Playwright scenario pages do not toggle network state or verify outbox replay; `docs/offline.md` documents the direct-cloud and Local Hub behavior. No browser network emulation was attempted.
- [ ] No payment-provider sandbox is configured or integrated. If a provider is later configured, test its sandbox only with isolated test bills and sandbox credentials; no provider payment was attempted in this audit.
- [ ] Validate thermal printing on the actual supported printer hardware; automated printing tests mock the device.

## Minimum safe browser acceptance procedure

Run this only against a separate test stack. Do not use the existing API on port 4000 or the restaurant database for test writes.

The package scripts are `pnpm --filter @restaurant-os/api dev` and `pnpm --filter @restaurant-os/web exec vite --host 127.0.0.1 --port 5174`. For the API process, set `PORT=4400`, `HOST=127.0.0.1`, `CORS_ORIGIN=http://127.0.0.1:5174`, and a `DATABASE_URL` derived in memory from the root `.env` by changing only its database path to `/restaurant_os_codex_test_1791730780050`. Never print the URL. For the web process, set `VITE_API_BASE_URL=http://127.0.0.1:4400`. The API must pass the identity check in step 1 before any write.

1. Start the API using only the retained isolated database `restaurant_os_codex_test_1791730780050` on port 4400 and the web app on port 5174, with its API base URL set to port 4400. Verify the API reports the isolated database identity before signing in or making changes.
2. Set up temporary test identities only in that isolated database. The existing seed script creates roles and permissions and can create an owner only when `SEED_OWNER_PASSWORD` is provided; it does not create waiter or kitchen users. Use a user-supplied password entered locally, then create waiter and kitchen identities through the seeded test Owner Staff UI. Do not reuse restaurant credentials or put passwords in shell arguments/history. Sign the waiter into `http://127.0.0.1:5174/login`, open `/waiter`, create one clearly labeled test order, save it, and submit its KOT once. Expected result: the isolated DB has one order and one KOT for that order.
3. Sign the kitchen identity into a separate browser context at `http://127.0.0.1:5174/login`, open `/kitchen`, and confirm the test KOT appears. Move its items through Preparing to Ready. Expected result: kitchen and waiter feeds show Ready, and the waiter sees exactly one visible Food Ready notification; after backgrounding/refocusing the waiter tab, the state remains Ready without a second notification. For duplicate-send protection, retry only the same logical request with its original idempotency key; expected result: same KOT ID and one KOT row. A second deliberate KOT is not a retry.
4. In another browser context, sign into the isolated owner identity and open `/owner`. Verify owner pages load, then perform one clearly labeled test-only action (for example, add a test table) and confirm it persists after navigation. Keep the resulting fixture in the isolated database; do not use the production-like restaurant database.
5. For offline/reconnect, use browser automation's network emulation against the test stack: take the test browser offline, create a disposable draft/test command, restore connectivity, and verify sync resolves it once and the outbox no longer retries it, with no duplicate order/KOT rows. Do not perform payment actions as part of this check.
6. Do not test payment-provider flows unless an external provider integration and sandbox credentials are explicitly configured. Printer verification requires the actual printer; mocked print tests are not hardware acceptance.

## Safety record

- No migrations or writes targeted the configured `restaurant_os` database. All 15 migrations and all generated order/KOT/bill/payment fixtures were confined to the named isolated test database.
- The isolated test database was retained with its test fixtures; neither database was reset, truncated, dropped, or reseeded.
- No payment endpoint or existing restaurant order was acted on. The built-in browser is now open only on the isolated unauthenticated login page; it did not attach to the previously absent authenticated application session.
- No authenticated browser acceptance, owner write action, or network-emulated offline/reconnect acceptance was run in this turn because no existing authenticated browser session or usable test identities were available. The prescribed procedure above keeps such writes confined to the isolated database.
- Current acceptance status: the isolated API/web startup and unauthenticated login-page display are browser/HTTP verified; database KOT, Socket.IO, payment concurrency, and sync behaviors remain automated integration-test evidence; authenticated waiter/kitchen/owner UI and browser network-emulated offline/reconnect remain unverified because the required local password prompt could not be provided to the user through the available terminal interface. No password was entered; the seed was not run; no identity setup, KOT submission, owner mutation, payment, or real-database write occurred in this acceptance attempt.
