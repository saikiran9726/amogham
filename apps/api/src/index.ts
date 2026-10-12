import { buildServer } from './server.js';
import { env } from './config/env.js';
import { closeDatabaseConnection } from './db/client.js';
import { closeRealtimeServer } from './realtime/socket.js';

import { db } from './db/client.js';
import { restaurants } from './db/schema/restaurants.js';
import { HubSyncWorker } from './services/hub/HubSyncWorker.js';

async function start(): Promise<void> {
  const app = await buildServer();

  // Enforce single tenant per deployment when MULTI_TENANT=false in production
  if (!env.MULTI_TENANT && env.NODE_ENV === 'production') {
    const existingRestaurants = await db.select({ id: restaurants.id }).from(restaurants);
    if (existingRestaurants.length !== 1) {
      app.log.error(
        { count: existingRestaurants.length },
        'MULTI_TENANT=false requires exactly one restaurant in production database. Deployment halted.',
      );
      throw new Error(
        `MULTI_TENANT=false requires exactly one restaurant row in production, found ${existingRestaurants.length}`,
      );
    }
  }

  // Start HubSyncWorker if deployed in local_hub role
  let hubWorker: HubSyncWorker | null = null;
  if (env.HUB_ROLE === 'local_hub') {
    if (!env.RESTAURANT_ID || !env.CLOUD_SYNC_URL || !env.HUB_API_KEY) {
      throw new Error(
        'HUB_ROLE=local_hub requires RESTAURANT_ID, CLOUD_SYNC_URL, and HUB_API_KEY to be configured.',
      );
    }
    hubWorker = new HubSyncWorker({
      restaurantId: env.RESTAURANT_ID,
      cloudSyncUrl: env.CLOUD_SYNC_URL,
      hubApiKey: env.HUB_API_KEY,
      deviceId: env.HUB_DEVICE_ID,
      syncIntervalMs: env.HUB_SYNC_INTERVAL_MS,
    });
    hubWorker.start();
    app.log.info(
      { cloudSyncUrl: env.CLOUD_SYNC_URL, restaurantId: env.RESTAURANT_ID },
      '🚀 HubSyncWorker started in local_hub role',
    );
  }

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    app.log.info({ signal, exitCode }, 'Graceful shutdown initiated...');

    // 10s shutdown watchdog: force exit if drain takes too long
    const watchdog = setTimeout(() => {
      console.error('Shutdown watchdog triggered after 10s: forcing non-zero exit');
      process.exit(1);
    }, 10_000);
    watchdog.unref();

    try {
      if (hubWorker) {
        hubWorker.stop();
        app.log.info('HubSyncWorker stopped.');
      }
      await closeRealtimeServer();
      app.log.info('Socket.IO realtime server closed.');
      await app.close();
      app.log.info('Fastify server closed.');
      await closeDatabaseConnection();
      app.log.info('Database connections closed.');
      clearTimeout(watchdog);
      process.exit(exitCode);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      clearTimeout(watchdog);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM', 0);
  });

  // Process handlers for unhandledRejection / uncaughtException: log, drain, exit non-zero
  process.on('unhandledRejection', (reason, promise) => {
    app.log.error(
      { reason, promise },
      'Unhandled Promise Rejection detected: draining server and exiting non-zero',
    );
    void gracefulShutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught Exception detected: draining server and exiting non-zero');
    void gracefulShutdown('uncaughtException', 1);
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`🚀 Restaurant OS API listening at http://${env.HOST}:${env.PORT}`);
    app.log.info(`Environment: ${env.NODE_ENV}`);
  } catch (err) {
    app.log.error(err, 'Failed to start API server');
    process.exit(1);
  }
}

start().catch((err) => {
  console.error('Fatal startup error in API application:', err);
  process.exit(1);
});
