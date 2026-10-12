import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const root = process.cwd();
const dbName = 'restaurant_os_codex_test_1791730780050';
const api = 'http://127.0.0.1:4400';
const web = 'http://127.0.0.1:5174';
const rootRequire = createRequire(path.join(root, 'package.json'));
const apiRequire = createRequire(path.join(root, 'apps/api/package.json'));
const dotenv = apiRequire('dotenv');
const { Pool } = apiRequire('pg');
const { chromium } = rootRequire('@playwright/test');

// This secure fallback is used because the interactive terminal cannot be attached.
// These one-run credentials stay in process memory and are never printed or persisted.
const ownerPassword = randomBytes(32).toString('base64url');
const waiterPassword = randomBytes(32).toString('base64url');
const kitchenPassword = randomBytes(32).toString('base64url');
const rootEnv = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
const dbUrl = new URL(rootEnv.DATABASE_URL || '');
assert.ok(['127.0.0.1', 'localhost'].includes(dbUrl.hostname), 'Refusing non-local PostgreSQL host.');
assert.equal(dbUrl.port, '5432', 'Refusing unexpected PostgreSQL port.');
assert.equal(decodeURIComponent(dbUrl.username), 'postgres', 'Refusing unexpected PostgreSQL role.');
dbUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = dbUrl.toString();
process.env.PORT = '4400';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = web;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const browser = await chromium.launch({ headless: true });
const contexts = [];
const results = [];
const tag = `C${Date.now().toString(36).toUpperCase()}`;
const ownerUsername = `codex_owner_${tag.toLowerCase()}`;
const waiterUsername = `codex_waiter_${tag.toLowerCase()}`;
const kitchenUsername = `codex_kitchen_${tag.toLowerCase()}`;
const onlineNote = `ACCEPTANCE-${tag}-ONLINE`;
const offlineNote = `ACCEPTANCE-${tag}-OFFLINE`;
const tableLabel = `CODEX-${tag}`;

async function checkTarget() {
  const id = await pool.query(
    'SELECT current_database() AS db, current_user AS role, inet_server_port() AS port, version() AS version',
  );
  const row = id.rows[0];
  assert.equal(row.db, dbName);
  assert.equal(row.role, 'postgres');
  assert.equal(Number(row.port), 5432);
  assert.match(row.version, /^PostgreSQL 18\./);
  const health = await fetch(`${api}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).db, 'connected');
  assert.equal((await fetch(`${web}/login`)).status, 200);
  const collision = await pool.query(
    'SELECT count(*)::int AS count FROM users WHERE username = ANY($1::text[])',
    [[ownerUsername, waiterUsername, kitchenUsername]],
  );
  assert.equal(collision.rows[0].count, 0);
  results.push('Isolated PostgreSQL 18 identity and isolated API/web health verified before writes.');
}

function seedOwner() {
  process.env.SEED_OWNER_USERNAME = ownerUsername;
  process.env.SEED_OWNER_PASSWORD = ownerPassword;
  const result = rootRequire('node:child_process').spawnSync(
    'pnpm --filter @restaurant-os/api db:seed',
    { cwd: root, env: process.env, shell: true, encoding: 'utf8', windowsHide: true },
  );
  delete process.env.SEED_OWNER_PASSWORD;
  if (result.error || result.status !== 0) throw new Error(`Isolated seed failed (exit ${result.status ?? 'unknown'}).`);
  results.push('Existing additive role/permission seed and temporary owner creation succeeded; no migrations were run.');
}

async function newSession(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  let errors = 0;
  page.on('pageerror', () => { errors += 1; });
  return { context, page, role, errors: () => errors };
}

async function login(session, username, password, route) {
  await session.page.goto(`${web}/login`);
  await session.page.locator('#username').fill(username);
  await session.page.locator('#password').fill(password);
  await session.page.getByRole('button', { name: 'Sign In' }).click();
  await session.page.waitForURL((url) => url.pathname.startsWith(route), { timeout: 15000 });
}

async function createStaff(owner, name, username, role, password) {
  const page = owner.page;
  if (new URL(page.url()).pathname !== '/owner/staff') {
    await page.goto(`${web}/owner/staff`, { waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('heading', { name: 'Staff Management' }).waitFor({ timeout: 15000 });
  const addStaff = page.getByRole('button', { name: 'Add Staff Member' });
  try {
    await addStaff.waitFor({ timeout: 10000 });
  } catch {
    const headings = await page.getByRole('heading').allTextContents();
    const buttons = (await page.locator('button').allTextContents()).map((value) => value.trim()).filter(Boolean);
    throw new Error(`Owner Staff control unavailable on ${new URL(page.url()).pathname}; headings=${headings.join('|')}; buttons=${buttons.join('|')}`);
  }
  await addStaff.click();
  const dialog = page.getByRole('dialog').last();
  await dialog.getByPlaceholder('e.g. Rahul Sharma').fill(name);
  await dialog.getByPlaceholder('e.g. rahul_waiter').fill(username);
  await dialog.locator('select').nth(0).selectOption(role);
  await dialog.locator('select').nth(1).selectOption('password');
  await dialog.locator('input[type="password"]').fill(password);
  await dialog.getByRole('button', { name: 'Create Staff' }).click();
  await page.getByRole('heading', { name: 'Staff Credential Generated' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Done' }).click(); // Never read or expose the one-time credential.
  const row = page.getByRole('row').filter({ hasText: username });
  await row.waitFor({ timeout: 15000 });
  assert.match(await row.innerText(), new RegExp(`\\b${role}\\b`));
}

async function assertRole(username, role, expectedPermissions) {
  const user = await pool.query(
    'SELECT r.name AS role, u.active FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1',
    [username],
  );
  assert.equal(user.rowCount, 1);
  assert.equal(user.rows[0].role, role);
  assert.equal(user.rows[0].active, true);
  const grants = await pool.query(
    `SELECT p.name FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
     JOIN permissions p ON p.id = rp.permission_id WHERE u.username = $1`,
    [username],
  );
  const names = new Set(grants.rows.map((grant) => grant.name));
  for (const permission of expectedPermissions) assert.ok(names.has(permission), `${role} lacks ${permission}.`);
}

async function assertOrder(waiterId, note, status, kotStatus) {
  const result = await pool.query(
    `SELECT o.id, o.type, o.status, k.id AS kot_id, k.status AS kot_status
     FROM orders o JOIN users u ON u.id = o.created_by LEFT JOIN kots k ON k.order_id = o.id
     WHERE u.id = $1 AND o.special_instructions = $2`,
    [waiterId, note],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].type, 'takeaway');
  assert.equal(result.rows[0].status, status);
  assert.equal(result.rows[0].kot_status, kotStatus);
  return result.rows[0];
}

async function waitKotStatus(kotId, status) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const row = await pool.query('SELECT status FROM kots WHERE id = $1', [kotId]);
    if (row.rows[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`KOT did not persist status ${status}.`);
}

async function kitchenCard(kitchenPage, restaurantId, kotId, kotNumber, status) {
  const labels = { new: 'New KOTs', preparing: 'Preparing KOTs', ready: 'Ready KOTs' };
  const rows = await pool.query(
    `SELECT id, kot_number FROM kots WHERE restaurant_id=$1 AND status=$2
     ORDER BY created_at ASC`,
    [restaurantId, status],
  );
  const sameNumber = rows.rows.filter((row) => Number(row.kot_number) === kotNumber);
  const index = sameNumber.findIndex((row) => row.id === kotId);
  assert.ok(index >= 0, `Test KOT is not present in the ${status} state.`);
  const section = kitchenPage.getByRole('region', { name: labels[status] });
  const cards = section.getByRole('region', { name: `KOT #${kotNumber}` });
  return cards.nth(index);
}

async function addFirstMenuItem(page) {
  const addButton = page.getByRole('button', { name: 'Add', exact: true }).first();
  await addButton.waitFor({ timeout: 15000 });
  await addButton.click();
  const addToCart = page.getByRole('button', { name: 'Add to Cart' });
  if (await addToCart.isVisible().catch(() => false)) {
    // The isolated sample dish requires modifier choices; select the first valid choice per group.
    const groups = page.locator('div.max-h-60 > div');
    for (let index = 0; index < await groups.count(); index += 1) {
      const options = groups.nth(index).getByRole('button');
      if (await options.count()) await options.first().click();
    }
    await addToCart.click();
  }
  await page.getByRole('button', { name: /Open order, 1 items/ }).waitFor({ timeout: 10000 });
}

try {
  await checkTarget();
  seedOwner();
  const owner = await newSession('owner');
  await login(owner, ownerUsername, ownerPassword, '/owner');
  await createStaff(owner, `Test Waiter ${tag}`, waiterUsername, 'WAITER', waiterPassword);
  await createStaff(owner, `Test Kitchen ${tag}`, kitchenUsername, 'KITCHEN', kitchenPassword);
  await assertRole(ownerUsername, 'OWNER', ['staff.manage', 'table.manage']);
  await assertRole(waiterUsername, 'WAITER', ['order.create', 'kot.create']);
  await assertRole(kitchenUsername, 'KITCHEN', ['kot.read', 'kot.update_status', 'item.complete']);
  results.push('Owner, waiter, and kitchen accounts were authenticated in separate contexts; role grants verified read-only.');

  const ownerPage = owner.page;
  await ownerPage.getByRole('link', { name: 'Floor Tables' }).click();
  await ownerPage.getByRole('button', { name: 'Add Table' }).click();
  const tableDialog = ownerPage.getByRole('dialog').last();
  await tableDialog.getByPlaceholder('e.g. T-01, Rooftop-4').fill(tableLabel);
  await tableDialog.locator('input[type="number"]').fill('2');
  await tableDialog.locator('input').nth(2).fill('Acceptance');
  await tableDialog.getByRole('button', { name: 'Save Table' }).click();
  await ownerPage.getByText(tableLabel, { exact: true }).waitFor({ timeout: 15000 });
  await ownerPage.getByRole('link', { name: 'Overview' }).click();
  await ownerPage.getByRole('link', { name: 'Floor Tables' }).click();
  await ownerPage.getByText(tableLabel, { exact: true }).waitFor({ timeout: 15000 });
  const tableCount = await pool.query('SELECT count(*)::int AS count FROM tables WHERE label = $1', [tableLabel]);
  assert.equal(tableCount.rows[0].count, 1);
  results.push('Owner Staff and table-management action passed through UI; the test table persisted after navigation.');

  const waiter = await newSession('waiter');
  const kitchen = await newSession('kitchen');
  await login(waiter, waiterUsername, waiterPassword, '/waiter');
  await login(kitchen, kitchenUsername, kitchenPassword, '/kitchen');
  const taxModeResponses = [];
  waiter.page.on('response', async (response) => {
    if (new URL(response.url()).pathname.endsWith('/restaurant/tax-mode')) {
      let mode = null;
      try { mode = (await response.json()).taxMode ?? null; } catch { /* only retain status metadata */ }
      taxModeResponses.push({ status: response.status(), mode });
    }
  });
  const waiterRow = await pool.query('SELECT id FROM users WHERE username = $1', [waiterUsername]);
  const waiterId = waiterRow.rows[0].id;
  const waiterRestaurant = await pool.query('SELECT restaurant_id FROM users WHERE id = $1', [waiterId]);
  const restaurantId = waiterRestaurant.rows[0].restaurant_id;

  await waiter.page.getByRole('button', { name: 'Takeaway Order' }).click();
  await addFirstMenuItem(waiter.page);
  const reviewButton = waiter.page.getByRole('button', { name: /Review & Save Order/ });
  await reviewButton.waitFor({ timeout: 10000 });
  if (await reviewButton.isDisabled()) {
    const alerts = (await waiter.page.getByRole('alert').allTextContents()).map((value) => value.trim());
    const statuses = (await waiter.page.getByRole('status').allTextContents()).map((value) => value.trim());
    const cartSummary = await waiter.page.getByRole('button', { name: /Open order/ }).getAttribute('aria-label').catch(() => 'missing');
    const menuItems = (await waiter.page.locator('h4').allTextContents()).map((value) => value.trim());
    const addButtons = await waiter.page.locator('button').filter({ hasText: /^Add$/ }).count();
    throw new Error(`Waiter cart remained disabled; tax-mode responses=${JSON.stringify(taxModeResponses)}; cart=${cartSummary}; menu=${menuItems.join('|')}; addButtons=${addButtons}; alert=${alerts.join('|')}; status=${statuses.join('|')}`);
  }
  await reviewButton.click();
  await waiter.page.getByPlaceholder('Kitchen note (e.g. Serve starters first, allergy note)...').fill(onlineNote);
  let originalRequest;
  waiter.page.on('request', (request) => {
    if (request.method() === 'POST' && /\/orders\/[^/]+\/kots$/.test(new URL(request.url()).pathname)) originalRequest = request;
  });
  const responsePromise = waiter.page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === 'POST' && /\/orders\/[^/]+\/kots$/.test(new URL(response.url()).pathname);
  }, { timeout: 30000 });
  await waiter.page.getByRole('button', { name: /Send KOT/ }).click();
  const response = await responsePromise;
  assert.ok([200, 201].includes(response.status()));
  const first = await response.json();
  const kotId = first?.kot?.id;
  const kotNumber = first?.kot?.kotNumber;
  assert.ok(kotId && kotNumber);
  assert.ok(originalRequest);
  const headers = await originalRequest.allHeaders();
  assert.ok(headers.authorization && headers['idempotency-key']);
  const retry = await waiter.context.request.post(originalRequest.url(), {
    headers: { authorization: headers.authorization, 'content-type': headers['content-type'] || 'application/json', 'idempotency-key': headers['idempotency-key'] },
    data: originalRequest.postData() || '{}',
  });
  assert.equal(retry.status(), 200);
  const replay = await retry.json();
  assert.equal(replay?.kot?.id, kotId);
  assert.equal(replay?.duplicate, false);
  const savedOrder = await assertOrder(waiterId, onlineNote, 'saved', 'new');
  assert.equal(savedOrder.kot_id, kotId);
  results.push('Waiter created a test takeaway order and KOT; exact same-key request retry returned the same KOT with one database record.');

  // KOT numbers reset by business date, so correlate the rendered card by ID and API ordering.
  await (await kitchenCard(kitchen.page, restaurantId, kotId, kotNumber, 'new')).getByRole('button', { name: 'Start Preparing' }).click();
  await waitKotStatus(kotId, 'preparing');
  await (await kitchenCard(kitchen.page, restaurantId, kotId, kotNumber, 'preparing')).getByRole('button', { name: 'Mark Food Ready' }).click();
  await waitKotStatus(kotId, 'ready');
  await (await kitchenCard(kitchen.page, restaurantId, kotId, kotNumber, 'ready')).getByText('Food Ready · Waiter Pickup').waitFor({ timeout: 15000 });
  await assertOrder(waiterId, onlineNote, 'saved', 'ready');
  const notification = waiter.page.getByRole('status').filter({ hasText: `KOT #${kotNumber} is ready to serve.` });
  await notification.waitFor({ timeout: 15000 });
  assert.equal(await notification.count(), 1);
  await waiter.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waiter.page.waitForTimeout(500);
  assert.equal(await notification.count(), 1);
  await waiter.page.getByRole('link', { name: 'Active Orders' }).click();
  const waiterReady = waiter.page
    .getByRole('article', { name: new RegExp(`KOT ${kotNumber}, ready`) })
    .filter({ hasText: savedOrder.id.slice(0, 8) });
  await waiterReady.waitFor({ timeout: 15000 });
  results.push('Kitchen Ready action persisted; waiter saw one Food Ready notification and the refreshed feed showed Ready.');

  await waiter.page.getByRole('link', { name: 'Tables' }).click();
  await waiter.context.setOffline(true);
  await waiter.page.getByRole('button', { name: 'Takeaway Order' }).click();
  await addFirstMenuItem(waiter.page);
  await waiter.page.getByRole('button', { name: /Review & Save Order/ }).click();
  await waiter.page.getByPlaceholder('Kitchen note (e.g. Serve starters first, allergy note)...').fill(offlineNote);
  await waiter.page.getByRole('button', { name: 'Send KOT' }).click();
  await waiter.page.getByText('KOT fired to kitchen!', { exact: true }).waitFor({ timeout: 10000 });
  await waiter.context.setOffline(false);
  const until = Date.now() + 45000;
  let offlineOrder;
  while (Date.now() < until) {
    offlineOrder = await pool.query(
      `SELECT o.id, k.id AS kot_id FROM orders o JOIN users u ON u.id = o.created_by
       LEFT JOIN kots k ON k.order_id = o.id WHERE u.id = $1 AND o.special_instructions = $2`,
      [waiterId, offlineNote],
    );
    if (offlineOrder.rowCount === 1 && offlineOrder.rows[0].kot_id) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(offlineOrder?.rowCount, 1);
  assert.ok(offlineOrder.rows[0].kot_id);
  const counts = await pool.query(
    'SELECT count(*)::int AS orders, (SELECT count(*)::int FROM kots WHERE order_id=$1) AS kots FROM orders WHERE id=$1',
    [offlineOrder.rows[0].id],
  );
  assert.deepEqual(counts.rows[0], { orders: 1, kots: 1 });
  const offlineOutbox = await waiter.page.evaluate(async (orderId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('RestaurantOS_DB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction('outbox', 'readonly');
      const commands = await new Promise((resolve, reject) => {
        const request = transaction.objectStore('outbox').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return commands
        .filter((command) => command.payload?.id === orderId || command.payload?.orderId === orderId)
        .map(({ type, status, attempts }) => ({ type, status, attempts }));
    } finally {
      db.close();
    }
  }, offlineOrder.rows[0].id);
  assert.equal(offlineOutbox.length, 2);
  assert.ok(offlineOutbox.every((command) => command.status === 'synced' && command.attempts >= 1));
  assert.deepEqual(new Set(offlineOutbox.map((command) => command.type)), new Set(['order.create', 'kot.send']));
  results.push('Offline/reconnect browser test synced one labeled test order and KOT exactly once.');
  results.push('Read-only IndexedDB inspection confirmed its order.create and kot.send commands are both synced with attempts recorded.');

  for (const session of [owner, waiter, kitchen]) assert.equal(session.errors(), 0);
  results.push('No uncaught page errors were observed.');
  console.log(JSON.stringify({ result: 'PASS', ownerUsername, waiterUsername, kitchenUsername, kotNumber, results }, null, 2));
} finally {
  delete process.env.SEED_OWNER_PASSWORD;
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser.close().catch(() => {});
  await pool.end().catch(() => {});
}
