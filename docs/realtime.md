# Realtime Layer Architecture & Events

The Restaurant OS Realtime layer is powered by **Socket.IO** mounted on top of Fastify. It provides sub-second event broadcasts across role-scoped rooms (`kitchen`, `floor`, `owner`) with JWT authentication, replay protection, and catch-up synchronization on reconnection.

---

## 1. Authentication & Room Authorisation

### Handshake Authentication & CORS

Every client socket connection must provide an authenticated JWT Bearer token either in `auth.token` or in the `Authorization: Bearer <token>` header:

```typescript
const socket = io(SERVER_URL, {
  auth: { token: accessToken },
  transports: ['websocket'],
});
```

- Handshake rejects invalid or expired tokens immediately with an authentication error.
- **CORS Allowlist**: Socket handshakes enforce the exact same origin allow-list as REST API endpoints (`CORS_ORIGIN` config). Disallowed origins are rejected during handshake.
- **Session Expiry**: The server inspects token `exp` and automatically disconnects the socket when the token expires, emitting `auth:expired`. The client reconnects or performs an `auth:refresh` handshake with a refreshed token.

### Role-Scoped Rooms (Server-Side Only)

Upon successful handshake, the server inspects the verified token's claims (`restaurantId` and `role`) and automatically binds the connection to isolated rooms:

- **`restaurant:{restaurantId}`**: Base restaurant room for system-wide alerts.
- **`restaurant:{restaurantId}:kitchen`**: Joined by `KITCHEN`, `MANAGER`, and `OWNER`.
- **`restaurant:{restaurantId}:floor`**: Joined by `WAITER`, `MANAGER`, and `OWNER`.
- **`restaurant:{restaurantId}:owner`**: Joined strictly by `OWNER` and `MANAGER`.

> [!SECURITY]
> Client-driven room joins (`join_room`) are completely prohibited and not exposed. Sockets can never join or listen to arbitrary rooms or cross-tenant rooms; membership is strictly determined server-side from verified JWT claims.

---

## 2. Reconnection & Catch-Up Cursor

When a mobile device or tablet disconnects (e.g. Wi-Fi drop on floor):

1. The client maintains `lastEventTimestamp` (cursor).
2. Upon reconnecting, the client emits `catch_up`:
   ```typescript
   socket.emit('catch_up', { since: lastEventTimestamp }, (missedEvents) => {
     for (const ev of missedEvents) {
       handleIncomingRealtimeEvent(ev.event, ev.data);
     }
   });
   ```
3. The server queries the tenant's bounded event history and replays any missed events in order. The response is strictly filtered to the authenticated tenant and non-expired events.

---

## 3. Realtime Events Specification

| Event Name                 | Target Room        | Payload                                       | Purpose                                                                                                      |
| :------------------------- | :----------------- | :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `kot.created`              | `kitchen`, `floor` | `{ kotId, orderId, kotNumber, type, status }` | Emitted when a new, additional, or modified KOT is dispatched.                                               |
| `kot.updated`              | `all`              | `{ kotId, status, seenAt }`                   | Emitted when kitchen marks a KOT seen.                                                                       |
| `kot.itemDone`             | `all`              | `{ kotItemId, kotId, orderId }`               | Emitted when a cook marks an item prepared.                                                                  |
| `kot.statusChanged`        | `all`              | `{ kotId, orderId, status }`                  | Emitted when KOT transitions (e.g. `preparing`, `ready`, `served`).                                          |
| `order.ready`              | `floor`            | `{ orderId, tableId }`                        | Emitted when all active KOT items for an order are done. Waiter UI triggers tile pulse & haptic/audio alert. |
| `table.statusChanged`      | `all`              | `{ tableId, status }`                         | Emitted when table status shifts (`occupied`, `preparing`, `ready`).                                         |
| `menu.availabilityChanged` | `all`              | `{ itemId, available, oosReason }`            | Emitted when item is marked out-of-stock or returned to stock. Instantly greys out item and blocks addition. |

---

## 4. Kitchen Privacy & Data Shaping

Responses served to the kitchen or emitted over kitchen streams strictly omit customer profiles, prices, payment details, and discounts. Sanitization is enforced via `serializeKitchenState` and `serializeMenuForRole`.

---

## 5. Single-Instance Limits & RealtimeBus Architecture

Event delivery and history caching are mediated by the `RealtimeBus` interface (`apps/api/src/realtime/bus.ts`):

```typescript
export interface RealtimeBus {
  publish<T>(payload: RealtimePublishPayload<T>): Promise<RealtimeEvent<T>> | RealtimeEvent<T>;
  getHistory(restaurantId: string, since: number): Promise<RealtimeEvent[]> | RealtimeEvent[];
  subscribe(subscriber: RealtimeSubscriber): () => void;
  sweep(): void;
  destroy(): void;
}
```

### Single-Instance (In-Memory) Boundaries

The default `InMemoryRealtimeBus` operates with the following design constraints:

1. **Per-Tenant Event Log Bound**: Capped at **500 events** per restaurant. Oldest entries are evicted as new ones arrive.
2. **Time-to-Live (TTL)**: Events are retained for a maximum of **10 minutes** (`600,000 ms`).
3. **Background Sweep**: A periodic sweeper runs every 60 seconds to prune expired events and evict idle tenant buffers.
4. **Event Identifiers**: Unique event IDs are generated via standard `crypto.randomUUID()`.
5. **Horizontal Scaling**: In a multi-instance deployment across load-balanced nodes, the in-memory bus does not share events across processes. Scaling horizontally requires plugging a Redis Pub/Sub / Streams adapter into the `RealtimeBus` interface.
