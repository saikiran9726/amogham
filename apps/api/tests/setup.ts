import { beforeAll, beforeEach } from 'vitest';
import { pool } from '../src/db/client.js';
import { setUserSessionCache } from '../src/auth/token-cache.js';

const TEST_RESTAURANTS = [
  '018f9e1e-2895-7800-9831-000000000000',
  '018f9e1e-2895-7800-9831-294719283748',
  '018f9e1e-2895-7800-9831-294719283749',
];

const STANDARD_USERS = [
  { id: '018f9e1e-2895-7800-9831-111111111111', role: 'owner', name: 'Owner User' },
  { id: '018f9e1e-2895-7800-9831-222222222222', role: 'waiter', name: 'Waiter User' },
  { id: '018f9e1e-2895-7800-9831-333333333333', role: 'kitchen', name: 'Kitchen User' },
  { id: '018f9e1e-2895-7800-9831-444444444444', role: 'manager', name: 'Manager User' },
  { id: '018f9e1e-2895-7800-9831-111111111112', role: 'owner', name: 'Owner Hub' },
];

export async function seedStandardTestFixtures() {
  try {
    for (const rId of TEST_RESTAURANTS) {
      await pool.query(
        `INSERT INTO restaurants (id, name) VALUES ($1, 'Test Fixture Restaurant') ON CONFLICT (id) DO NOTHING`,
        [rId],
      );
    }

    const primaryRestaurant = '018f9e1e-2895-7800-9831-000000000000';
    for (const u of STANDARD_USERS.slice(0, 4)) {
      await pool.query(
        `INSERT INTO users (id, restaurant_id, name, username, active, token_version)
         VALUES ($1, $2, $3, $4, true, 0)
         ON CONFLICT (id) DO UPDATE SET active = true, token_version = 0`,
        [u.id, primaryRestaurant, u.name, `fixture_${u.role}_${u.id.slice(-4)}`],
      );
    }

    await pool.query(
      `INSERT INTO users (id, restaurant_id, name, username, active, token_version)
       VALUES ($1, $2, 'Owner Hub', 'fixture_owner_hub', true, 0)
       ON CONFLICT (id) DO UPDATE SET active = true, token_version = 0`,
      ['018f9e1e-2895-7800-9831-111111111112', '018f9e1e-2895-7800-9831-294719283749'],
    );

    // Prime the memory session cache for all (restaurant, user) combinations used across tests
    for (const rId of TEST_RESTAURANTS) {
      for (const u of STANDARD_USERS) {
        setUserSessionCache(rId, u.id, { tokenVersion: 0, active: true });
      }
    }
  } catch (err) {
    // Database connection error during offline/mock-only runs can be logged
    console.error('Fixture seeding warning:', err);
  }
}

beforeAll(async () => {
  await seedStandardTestFixtures();
});

beforeEach(async () => {
  for (const rId of TEST_RESTAURANTS) {
    for (const u of STANDARD_USERS) {
      setUserSessionCache(rId, u.id, { tokenVersion: 0, active: true });
    }
  }
});
