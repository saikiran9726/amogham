import { Server as SocketIOServer, Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { Roles } from '@restaurant-os/shared';
import { isOriginAllowed } from '../config/cors.js';
import { verifyUserIdentity, type VerifiedIdentity } from '../auth/identity.js';
import {
  type RealtimeBus,
  type RealtimeEvent,
  type RealtimeTarget,
  InMemoryRealtimeBus,
} from './bus.js';

export interface AuthenticatedSocket extends Socket {
  user: VerifiedIdentity;
}

let ioInstance: SocketIOServer | null = null;
let realtimeBusInstance: RealtimeBus = new InMemoryRealtimeBus();

export function getIO(): SocketIOServer | null {
  return ioInstance;
}

export function getRealtimeBus(): RealtimeBus {
  return realtimeBusInstance;
}

export function setRealtimeBus(bus: RealtimeBus): void {
  realtimeBusInstance = bus;
}

export function initRealtimeServer(fastifyApp: FastifyInstance): SocketIOServer {
  const io = new SocketIOServer(fastifyApp.server, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // Wire RealtimeBus to Socket.IO broadcasts
  realtimeBusInstance.subscribe((restaurantId, event, payload, target) => {
    if (!io) return;
    if (target === 'all') {
      io.to(`restaurant:${restaurantId}`).emit(event, payload);
    } else {
      io.to(`restaurant:${restaurantId}:${target}`).emit(event, payload);
    }
  });

  // Handshake authentication & origin validation
  io.use((rawSocket: Socket, next) => {
    void (async () => {
      try {
        const origin = rawSocket.handshake.headers.origin;
        if (!isOriginAllowed(origin)) {
          return next(new Error(`Origin ${origin} not allowed by CORS`));
        }

        const token =
          rawSocket.handshake.auth?.token ||
          (rawSocket.handshake.headers.authorization?.startsWith('Bearer ')
            ? rawSocket.handshake.headers.authorization.slice(7)
            : null);

        if (!token) {
          return next(new Error('Authentication required'));
        }

        const payload = await verifyUserIdentity(token);
        (rawSocket as AuthenticatedSocket).user = payload;
        next();
      } catch {
        next(new Error('Invalid authentication token'));
      }
    })();
  });

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const user = socket.user;
    if (!user || !user.restaurantId) {
      socket.disconnect(true);
      return;
    }

    const { restaurantId, role } = user;

    // Join rooms strictly based on verified token identity — no client-driven room joins
    void socket.join(`restaurant:${restaurantId}`);

    if (role === Roles.OWNER || role === Roles.MANAGER) {
      void socket.join(`restaurant:${restaurantId}:owner`);
      void socket.join(`restaurant:${restaurantId}:kitchen`);
      void socket.join(`restaurant:${restaurantId}:floor`);
    } else if (role === Roles.KITCHEN) {
      void socket.join(`restaurant:${restaurantId}:kitchen`);
    } else if (role === Roles.WAITER) {
      void socket.join(`restaurant:${restaurantId}:floor`);
    }

    // Disconnect at token expiration
    let expTimer: NodeJS.Timeout | null = null;
    const scheduleExpirationDisconnect = (expSeconds?: number) => {
      if (expTimer) {
        clearTimeout(expTimer);
        expTimer = null;
      }
      if (!expSeconds) return;

      const msUntilExp = expSeconds * 1000 - Date.now();
      if (msUntilExp <= 0) {
        socket.emit('auth:expired', { reason: 'Token expired' });
        socket.disconnect(true);
        return;
      }

      expTimer = setTimeout(() => {
        socket.emit('auth:expired', { reason: 'Token expired' });
        socket.disconnect(true);
      }, msUntilExp);

      if (typeof expTimer.unref === 'function') {
        expTimer.unref();
      }
    };

    scheduleExpirationDisconnect(user.exp);

    socket.on('disconnect', () => {
      if (expTimer) {
        clearTimeout(expTimer);
        expTimer = null;
      }
    });

    // Auth refresh handshake: clients can supply a fresh token without losing connection
    socket.on(
      'auth:refresh',
      async (
        data: { token?: string },
        callback?: (res: { ok: boolean; error?: string }) => void,
      ) => {
        try {
          if (!data?.token) {
            callback?.({ ok: false, error: 'Token required' });
            return;
          }
          const freshIdentity = await verifyUserIdentity(data.token);
          if (
            freshIdentity.restaurantId !== socket.user.restaurantId ||
            freshIdentity.userId !== socket.user.userId
          ) {
            callback?.({ ok: false, error: 'Identity mismatch' });
            return;
          }

          socket.user = freshIdentity;
          scheduleExpirationDisconnect(freshIdentity.exp);
          callback?.({ ok: true });
        } catch {
          callback?.({ ok: false, error: 'Invalid or expired token' });
        }
      },
    );

    // Reconnection catch-up: client sends `since` cursor timestamp. Returns tenant-scoped events only.
    socket.on(
      'catch_up',
      async (data: { since?: number }, callback?: (events: RealtimeEvent[]) => void) => {
        const since = data?.since || 0;
        const missed = await realtimeBusInstance.getHistory(restaurantId, since);
        if (callback) {
          callback(missed);
        }
      },
    );
  });

  // Gracefully clean up bus timers and socket.io on Fastify server shutdown
  fastifyApp.addHook('onClose', async () => {
    realtimeBusInstance.destroy();
    await closeRealtimeServer();
  });

  ioInstance = io;
  return io;
}

/**
 * Closes the active Socket.IO server instance gracefully.
 */
export async function closeRealtimeServer(): Promise<void> {
  if (ioInstance) {
    const serverToClose = ioInstance;
    ioInstance = null;
    await new Promise<void>((resolve) => {
      void serverToClose.close(() => resolve());
    });
  }
}

/**
 * Emits realtime event to specified role rooms or whole restaurant.
 */
export function emitRealtimeEvent<T = unknown>(
  restaurantId: string,
  event: string,
  data: T,
  target: RealtimeTarget = 'all',
): RealtimeEvent<T> | undefined {
  return realtimeBusInstance.publish({
    restaurantId,
    event,
    data,
    target,
  }) as RealtimeEvent<T>;
}
