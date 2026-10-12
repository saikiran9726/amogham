import { pool } from './client.js';
import { generateUuidV7 } from '@restaurant-os/shared';

interface BenchmarkResult {
  name: string;
  query: string;
  executionTimeMs: number;
  planningTimeMs: number;
  plan: string;
}

export async function seedPerformanceData(targetBills = 100_000): Promise<{
  restaurantId: string;
  userId: string;
  billsCount: number;
  orderItemsCount: number;
}> {
  const client = await pool.connect();
  try {
    console.log(`[seed-perf] Setting up restaurant, user, and menu foundation...`);

    // 1. Get or create a benchmark restaurant
    const { rows: restRows } = await client.query<{ id: string }>(
      `SELECT id FROM restaurants LIMIT 1;`,
    );
    let restaurantId: string;
    if (restRows.length > 0) {
      restaurantId = restRows[0]!.id;
    } else {
      restaurantId = generateUuidV7();
      await client.query(
        `INSERT INTO restaurants (id, name, currency, timezone) VALUES ($1, $2, $3, $4);`,
        [restaurantId, 'Benchmark Bistro', 'INR', 'Asia/Kolkata'],
      );
    }

    // 2. Get or create a benchmark user
    const { rows: userRows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE restaurant_id = $1 LIMIT 1;`,
      [restaurantId],
    );
    let userId: string;
    if (userRows.length > 0) {
      userId = userRows[0]!.id;
    } else {
      userId = generateUuidV7();
      await client.query(
        `INSERT INTO users (id, restaurant_id, name, username, role, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [userId, restaurantId, 'Benchmark Manager', 'bench_mgr', 'MANAGER', 'hash123'],
      );
    }

    // 3. Get or create benchmark category and items
    const { rows: catRows } = await client.query<{ id: string }>(
      `SELECT id FROM menu_categories WHERE restaurant_id = $1 LIMIT 1;`,
      [restaurantId],
    );
    let categoryId: string;
    if (catRows.length > 0) {
      categoryId = catRows[0]!.id;
    } else {
      categoryId = generateUuidV7();
      await client.query(
        `INSERT INTO menu_categories (id, restaurant_id, name, active) VALUES ($1, $2, $3, true);`,
        [categoryId, restaurantId, 'Benchmark Dishes'],
      );
    }

    const { rows: itemRows } = await client.query<{ id: string }>(
      `SELECT id FROM menu_items WHERE restaurant_id = $1 LIMIT 5;`,
      [restaurantId],
    );
    let itemIds: string[] = itemRows.map((r) => r.id);
    if (itemIds.length < 5) {
      itemIds = [];
      for (let i = 1; i <= 5; i++) {
        const iId = generateUuidV7();
        itemIds.push(iId);
        await client.query(
          `INSERT INTO menu_items (id, restaurant_id, category_id, name, price_paise, tax_rate_bp, active)
           VALUES ($1, $2, $3, $4, $5, 500, true);`,
          [iId, restaurantId, categoryId, `Benchmark Item ${i}`, 25000 + i * 5000],
        );
      }
    }

    // 4. Get or create a benchmark table
    const { rows: tableRows } = await client.query<{ id: string }>(
      `SELECT id FROM tables WHERE restaurant_id = $1 LIMIT 1;`,
      [restaurantId],
    );
    let tableId: string;
    if (tableRows.length > 0) {
      tableId = tableRows[0]!.id;
    } else {
      tableId = generateUuidV7();
      await client.query(
        `INSERT INTO tables (id, restaurant_id, name, capacity, status) VALUES ($1, $2, $3, 4, 'available');`,
        [tableId, restaurantId, 'T-01'],
      );
    }

    // 5. Check existing bills count
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*)::text as count FROM bills WHERE restaurant_id = $1;`,
      [restaurantId],
    );
    const existingCount = parseInt(countRows[0]!.count, 10);
    const neededBills = targetBills - existingCount;

    if (neededBills <= 0) {
      console.log(
        `[seed-perf] Already have ${existingCount} bills for restaurant. Skipping insertion.`,
      );
      const { rows: oiCount } = await client.query<{ count: string }>(
        `SELECT count(*)::text as count FROM order_items;`,
      );
      return {
        restaurantId,
        userId,
        billsCount: existingCount,
        orderItemsCount: parseInt(oiCount[0]!.count, 10),
      };
    }

    console.log(
      `[seed-perf] Seeding ${neededBills} bills and ~${neededBills * 3} order items in bulk batches...`,
    );

    const BATCH_SIZE = 5_000;
    const statuses = ['paid', 'paid', 'paid', 'paid', 'unpaid', 'partially_paid', 'cancelled'];
    const businessDates: string[] = [];
    const baseDate = new Date('2026-10-12T00:00:00Z');
    for (let d = 0; d < 90; d++) {
      const cur = new Date(baseDate.getTime() - d * 86400000);
      businessDates.push(cur.toISOString().split('T')[0]!);
    }

    let insertedBills = 0;
    const startTime = Date.now();

    while (insertedBills < neededBills) {
      const batchCount = Math.min(BATCH_SIZE, neededBills - insertedBills);
      const batchStartIndex = existingCount + insertedBills + 1;

      // 1. Generate Orders
      const orderIds: string[] = [];
      const orderRowsSql: string[] = [];

      for (let i = 0; i < batchCount; i++) {
        const orderId = generateUuidV7();
        orderIds.push(orderId);
        const bDate = businessDates[(batchStartIndex + i) % businessDates.length]!;
        orderRowsSql.push(
          `('${orderId}', '${restaurantId}', '${tableId}', 'dine_in', 2, 'completed', 75000, 3750, 78750, 1, '${bDate} 12:00:00+00', '${bDate} 13:00:00+00')`,
        );
      }

      await client.query(`
        INSERT INTO orders (id, restaurant_id, table_id, type, guests, status, subtotal_paise, tax_paise, total_paise, version, created_at, updated_at)
        VALUES ${orderRowsSql.join(',\n')};
      `);

      // 2. Generate Order Items (3 per order = 15,000 per batch)
      const orderItemRowsSql: string[] = [];
      for (let i = 0; i < batchCount; i++) {
        const ordId = orderIds[i]!;
        for (let j = 0; j < 3; j++) {
          const itemId = itemIds[j % itemIds.length]!;
          const oiId = generateUuidV7();
          orderItemRowsSql.push(
            `('${oiId}', '${ordId}', '${itemId}', 'Benchmark Item ${j + 1}', 25000, 500, 1, '[]'::jsonb, ${j + 1}, 'served')`,
          );
        }
      }

      await client.query(`
        INSERT INTO order_items (id, order_id, item_id, name_snapshot, price_paise_snapshot, tax_rate_bp_snapshot, qty, modifiers, line_no, kot_state)
        VALUES ${orderItemRowsSql.join(',\n')};
      `);

      // 3. Generate Bills
      const billIds: string[] = [];
      const billRowsSql: string[] = [];

      for (let i = 0; i < batchCount; i++) {
        const bId = generateUuidV7();
        billIds.push(bId);
        const ordId = orderIds[i]!;
        const billNum = `B-${String(batchStartIndex + i).padStart(7, '0')}`;
        const status = statuses[(batchStartIndex + i) % statuses.length]!;
        const bDate = businessDates[(batchStartIndex + i) % businessDates.length]!;

        billRowsSql.push(
          `('${bId}', '${restaurantId}', '${ordId}', '${billNum}', 75000, 0, 0, 3750, 0, 78750, 'exclusive', 0.00, 500, true, '${status}', '${bDate}', '${userId}', '${bDate} 13:05:00+00', '${bDate} 13:05:00+00')`,
        );
      }

      await client.query(`
        INSERT INTO bills (id, restaurant_id, order_id, bill_number, subtotal_paise, discount_paise, service_charge_paise, tax_paise, round_off_paise, total_paise, tax_mode, service_charge_percent, default_gst_rate_bp, round_off_enabled, status, business_date, created_by, created_at, updated_at)
        VALUES ${billRowsSql.join(',\n')};
      `);

      // 4. Generate Bill Lines (3 per bill = 15,000 per batch)
      const billLineRowsSql: string[] = [];
      for (let i = 0; i < batchCount; i++) {
        const bId = billIds[i]!;
        for (let j = 0; j < 3; j++) {
          const blId = generateUuidV7();
          const itemId = itemIds[j % itemIds.length]!;
          billLineRowsSql.push(
            `('${blId}', '${bId}', '${itemId}', 'Benchmark Item ${j + 1}', 1, 25000, 25000, 0, 25000, 500, 1250, 625, 625, '[]'::jsonb)`,
          );
        }
      }

      await client.query(`
        INSERT INTO bill_lines (id, bill_id, item_id, name, qty, price_paise, subtotal_paise, discount_paise, taxable_paise, tax_rate_bp, tax_paise, cgst_paise, sgst_paise, modifiers)
        VALUES ${billLineRowsSql.join(',\n')};
      `);

      // 5. Generate Payments for paid bills
      const paymentRowsSql: string[] = [];
      for (let i = 0; i < batchCount; i++) {
        const bId = billIds[i]!;
        const status = statuses[(batchStartIndex + i) % statuses.length]!;
        if (status === 'paid') {
          const pId = generateUuidV7();
          const bDate = businessDates[(batchStartIndex + i) % businessDates.length]!;
          paymentRowsSql.push(
            `('${pId}', '${restaurantId}', '${bId}', 78750, 'upi', 'confirmed', '${userId}', '${bDate} 13:10:00+00')`,
          );
        }
      }

      if (paymentRowsSql.length > 0) {
        await client.query(`
          INSERT INTO payments (id, restaurant_id, bill_id, amount_paise, method, status, created_by, created_at)
          VALUES ${paymentRowsSql.join(',\n')};
        `);
      }

      insertedBills += batchCount;
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[seed-perf] Progress: ${insertedBills} / ${neededBills} bills (${((insertedBills / neededBills) * 100).toFixed(0)}%) in ${elapsedSec}s...`,
      );
    }

    // Refresh database statistics for query planner
    console.log(`[seed-perf] Running ANALYZE on modified tables...`);
    await client.query(`ANALYZE bills;`);
    await client.query(`ANALYZE bill_lines;`);
    await client.query(`ANALYZE orders;`);
    await client.query(`ANALYZE order_items;`);
    await client.query(`ANALYZE payments;`);

    const { rows: finalBills } = await client.query<{ count: string }>(
      `SELECT count(*)::text as count FROM bills WHERE restaurant_id = $1;`,
      [restaurantId],
    );
    const { rows: finalItems } = await client.query<{ count: string }>(
      `SELECT count(*)::text as count FROM order_items;`,
    );

    return {
      restaurantId,
      userId,
      billsCount: parseInt(finalBills[0]!.count, 10),
      orderItemsCount: parseInt(finalItems[0]!.count, 10),
    };
  } finally {
    client.release();
  }
}

export async function runQueryBenchmarks(
  restaurantId: string,
  userId: string,
): Promise<BenchmarkResult[]> {
  const client = await pool.connect();
  try {
    const queries: { name: string; sql: string; params: unknown[] }[] = [
      {
        name: 'Q1: GET /bills by restaurant_id, business_date, and status',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT * FROM bills
              WHERE restaurant_id = $1 AND business_date = '2026-10-10' AND status = 'paid'
              ORDER BY created_at DESC, id DESC LIMIT 30;`,
        params: [restaurantId],
      },
      {
        name: 'Q2: GET /bills search by bill_number with ILIKE (trigram GIN index)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT * FROM bills
              WHERE restaurant_id = $1 AND bill_number ILIKE '%5432%'
              ORDER BY created_at DESC, id DESC LIMIT 30;`,
        params: [restaurantId],
      },
      {
        name: 'Q3: GET /bills keyset pagination (createdAt, id)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT * FROM bills
              WHERE restaurant_id = $1 AND (created_at, id) < ('2026-10-01T00:00:00Z'::timestamptz, '018f0000-0000-7000-8000-000000000000'::uuid)
              ORDER BY created_at DESC, id DESC LIMIT 30;`,
        params: [restaurantId],
      },
      {
        name: 'Q4: Waiter recent bills filter (restaurant_id, created_by, created_at DESC)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT * FROM bills
              WHERE restaurant_id = $1 AND created_by = $2
              ORDER BY created_at DESC, id DESC LIMIT 30;`,
        params: [restaurantId, userId],
      },
      {
        name: 'Q5: Daily EOD sales summary (bills grouped by business_date and status)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT business_date, status, COUNT(*), SUM(total_paise), SUM(tax_paise), SUM(discount_paise)
              FROM bills
              WHERE restaurant_id = $1 AND business_date >= '2026-09-01'
              GROUP BY business_date, status;`,
        params: [restaurantId],
      },
      {
        name: 'Q6: Top-selling menu items (bills joined with bill_lines and menu_items)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT bl.item_id, mi.name, SUM(bl.qty) as total_qty, SUM(bl.subtotal_paise) as total_revenue
              FROM bill_lines bl
              JOIN bills b ON bl.bill_id = b.id
              JOIN menu_items mi ON bl.item_id = mi.id
              WHERE b.restaurant_id = $1 AND b.status = 'paid' AND b.business_date >= '2026-09-01'
              GROUP BY bl.item_id, mi.name
              ORDER BY total_qty DESC LIMIT 10;`,
        params: [restaurantId],
      },
      {
        name: 'Q7: Category sales breakdown (bills joined with bill_lines, menu_items, categories)',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT mc.id, mc.name, SUM(bl.subtotal_paise) as category_revenue, SUM(bl.qty) as category_qty
              FROM bill_lines bl
              JOIN bills b ON bl.bill_id = b.id
              JOIN menu_items mi ON bl.item_id = mi.id
              JOIN menu_categories mc ON mi.category_id = mc.id
              WHERE b.restaurant_id = $1 AND b.status = 'paid' AND b.business_date >= '2026-09-01'
              GROUP BY mc.id, mc.name
              ORDER BY category_revenue DESC;`,
        params: [restaurantId],
      },
      {
        name: 'Q8: Orders listing by restaurant_id, status, and created_at DESC',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT * FROM orders
              WHERE restaurant_id = $1 AND status = 'completed'
              ORDER BY created_at DESC LIMIT 50;`,
        params: [restaurantId],
      },
      {
        name: 'Q9: Payment reconciliation list by restaurant_id, created_at DESC',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT p.id, p.amount_paise, p.method, p.status, p.created_at, b.bill_number
              FROM payments p
              JOIN bills b ON p.bill_id = b.id
              WHERE p.restaurant_id = $1 AND p.status = 'confirmed'
              ORDER BY p.created_at DESC LIMIT 50;`,
        params: [restaurantId],
      },
      {
        name: 'Q10: Tax report breakdown across date range',
        sql: `EXPLAIN (ANALYZE, BUFFERS)
              SELECT b.business_date, SUM(b.subtotal_paise) as subtotal, SUM(b.tax_paise) as tax, SUM(b.total_paise) as total
              FROM bills b
              WHERE b.restaurant_id = $1 AND b.status = 'paid' AND b.business_date BETWEEN '2026-08-01' AND '2026-10-12'
              GROUP BY b.business_date
              ORDER BY b.business_date DESC;`,
        params: [restaurantId],
      },
    ];

    const results: BenchmarkResult[] = [];

    for (const q of queries) {
      const res = await client.query<{ 'QUERY PLAN': string }>(q.sql, q.params);
      const planLines = res.rows.map((r) => r['QUERY PLAN']);
      const planText = planLines.join('\n');

      // Extract execution time and planning time from EXPLAIN output
      const execMatch = planText.match(/Execution Time:\s+([0-9.]+)\s+ms/);
      const planMatch = planText.match(/Planning Time:\s+([0-9.]+)\s+ms/);

      const executionTimeMs = execMatch ? parseFloat(execMatch[1]!) : 0;
      const planningTimeMs = planMatch ? parseFloat(planMatch[1]!) : 0;

      results.push({
        name: q.name,
        query: q.sql,
        executionTimeMs,
        planningTimeMs,
        plan: planText,
      });
    }

    return results;
  } finally {
    client.release();
  }
}

// Direct CLI invocation
async function main() {
  console.log('=== Restaurant OS Performance Seeding & Query Benchmarks ===');
  const seedResult = await seedPerformanceData(100_000);
  console.log(
    `Seeded data summary: ${seedResult.billsCount} bills, ${seedResult.orderItemsCount} order items for restaurant ${seedResult.restaurantId}`,
  );

  console.log('\nRunning EXPLAIN (ANALYZE, BUFFERS) on 10 critical queries...\n');
  const results = await runQueryBenchmarks(seedResult.restaurantId, seedResult.userId);

  for (const r of results) {
    console.log(`------------------------------------------------------------`);
    console.log(`QUERY: ${r.name}`);
    console.log(
      `Execution Time: ${r.executionTimeMs.toFixed(3)} ms | Planning Time: ${r.planningTimeMs.toFixed(3)} ms`,
    );
    console.log(`PLAN:\n${r.plan}\n`);
  }

  await pool.end();
  process.exit(0);
}

if (process.argv[1]?.includes('seed-perf')) {
  main().catch(async (err) => {
    console.error('Performance benchmark error:', err);
    await pool.end();
    process.exit(1);
  });
}
