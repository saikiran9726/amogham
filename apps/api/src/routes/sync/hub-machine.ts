import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { forSystem, forTenant } from '../../db/tenant.js';
import { hubRegistry } from '../../db/schema/sync.js';
import { SyncEngineService } from '../../services/sync-engine.js';
import { verifyHubApiKeyConstantTime } from '../../services/hub/HubSyncWorker.js';
import {
  AppError,
  Permissions,
  syncPushBatchSchema,
  syncPullQuerySchema,
  type HubRegistryItem,
} from '@restaurant-os/shared';
import { registerRouteGuard } from '../../auth/middleware.js';

interface HubMachineContext {
  hub: HubRegistryItem;
  restaurantId: string;
}

export async function authenticateHubMachine(
  request: FastifyRequest,
): Promise<HubMachineContext> {
  // 1. Refuse user JWTs / Authorization headers for machine access
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    throw AppError.forbidden(
      'Machine endpoint refuses user JWT credentials. Authentication requires X-Hub-Key header.',
    );
  }

  // 2. Extract and validate X-Hub-Key header
  const hubKeyHeader = request.headers['x-hub-key'];
  if (!hubKeyHeader || typeof hubKeyHeader !== 'string') {
    throw AppError.unauthorized('Missing X-Hub-Key header for machine authentication');
  }

  const requestedRestaurantId = request.headers['x-restaurant-id'] as string | undefined;
  const requestedDeviceId = request.headers['x-hub-device-id'] as string | undefined;

  const system = forSystem();

  // 3. Find candidate active hubs
  const conditions = [eq(hubRegistry.isActive, true)];
  if (requestedRestaurantId) {
    conditions.push(eq(hubRegistry.restaurantId, requestedRestaurantId));
  }
  if (requestedDeviceId) {
    conditions.push(eq(hubRegistry.deviceId, requestedDeviceId));
  }

  const candidates = await system.db
    .select()
    .from(hubRegistry)
    .where(and(...conditions));

  let matchedHub: (typeof candidates)[0] | null = null;
  for (const candidate of candidates) {
    if (verifyHubApiKeyConstantTime(hubKeyHeader, candidate.apiKeyHash)) {
      matchedHub = candidate;
      break;
    }
  }

  if (!matchedHub) {
    throw AppError.unauthorized('Invalid or unauthorized X-Hub-Key');
  }

  const hubItem: HubRegistryItem = {
    id: matchedHub.id,
    restaurantId: matchedHub.restaurantId,
    deviceId: matchedHub.deviceId,
    name: matchedHub.name,
    hostAddress: matchedHub.hostAddress,
    isActive: matchedHub.isActive,
    lastHeartbeat: matchedHub.lastHeartbeat.toISOString(),
    lastSyncedSeq: matchedHub.lastSyncedSeq,
    createdAt: matchedHub.createdAt.toISOString(),
    updatedAt: matchedHub.updatedAt.toISOString(),
  };

  return { hub: hubItem, restaurantId: matchedHub.restaurantId };
}

export async function registerHubMachineRoutes(app: FastifyInstance): Promise<void> {
  registerRouteGuard({
    method: 'POST',
    url: '/sync/hub/push',
    isPublic: false,
    permission: Permissions.ORDER_CREATE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/sync/hub/pull',
    isPublic: false,
    permission: Permissions.ORDER_CREATE,
  });

  /**
   * POST /sync/hub/push
   * Machine push endpoint: pushes an ordered batch of events from local hub to cloud.
   */
  app.post('/sync/hub/push', async (request: FastifyRequest) => {
    const { hub, restaurantId } = await authenticateHubMachine(request);
    const parsed = syncPushBatchSchema.parse(request.body);

    const result = await SyncEngineService.processPushBatch(restaurantId, parsed, {
      permissions: [
        Permissions.ORDER_CREATE,
        Permissions.ORDER_UPDATE,
        Permissions.KOT_UPDATE_STATUS,
        Permissions.PAYMENT_TAKE,
        Permissions.BILL_REPRINT,
        Permissions.BILL_REFUND,
        Permissions.SETTINGS_MANAGE,
      ],
    });

    // Update hub lastHeartbeat and lastSyncedSeq in database
    const tenant = forTenant(restaurantId);
    await tenant.update(
      hubRegistry,
      {
        lastHeartbeat: new Date(),
        lastSyncedSeq: result.lastSeq,
        updatedAt: new Date(),
      },
      eq(hubRegistry.id, hub.id),
    );

    return result;
  });

  /**
   * GET /sync/hub/pull
   * Machine pull endpoint: pulls event stream since cursor.
   */
  app.get('/sync/hub/pull', async (request: FastifyRequest) => {
    const { restaurantId } = await authenticateHubMachine(request);
    const { since, limit } = syncPullQuerySchema.parse(request.query);

    const result = await SyncEngineService.pullEvents(restaurantId, since, limit);
    return result;
  });
}
