# Local Hub Installation & Operational Runbook

Deploying Restaurant OS Local Hub on an in-restaurant mini-PC or edge appliance.

---

## 1. Hardware Requirements & Assumptions

- **Machine**: Intel N100 / Core i3 mini-PC, Raspberry Pi 5 (8GB), or dedicated store computer.
- **Network**: Static local IP address on restaurant router (e.g. `192.168.1.100`).
- **OS**: Ubuntu Server 22.04 LTS / Debian 12 / Windows with WSL2 Docker.
- **Storage**: Minimum 32GB SSD storage.

---

## 2. Single-Tenant Edge Hub Architecture (`MULTI_TENANT=false`)

Restaurant OS defaults to single-tenant deployments (`MULTI_TENANT=false` in `apps/api/src/config/env.ts`):

- **Deployment Model**: One isolated physical Edge Hub per restaurant location.
- **Data Isolation**: Physical database isolation ensures zero cross-tenant attack vectors or data leakage.
- **Startup Enforcement**: In production (`NODE_ENV=production`), the API server automatically validates that exactly one restaurant row exists in the database. If zero or multiple restaurants are detected, startup halts immediately to prevent misconfiguration.
- **User Scoping**: Usernames are scoped directly to the local installation without needing restaurant code prefixes.

---

## 3. Hub Mode & Machine Authentication (`HUB_ROLE=local_hub`)

When deployed with `HUB_ROLE=local_hub`:

- **`HubSyncWorker`**: Automatically boots on server start. Continuously streams local `sync_events` to `CLOUD_SYNC_URL/sync/hub/push` and pulls cloud configuration events via `/sync/hub/pull`.
- **Machine Authentication (`X-Hub-Key`)**:
  - Edge-to-cloud communication authenticates strictly via the `X-Hub-Key` HTTP header.
  - Verification is performed in constant time using `crypto.timingSafeEqual` against the SHA-256 hash stored in `hub_registry.api_key_hash`.
  - Machine endpoints `/sync/hub/push` and `/sync/hub/pull` **strictly refuse user JWTs** (HTTP 403) to preserve least-privilege machine boundaries.
- **Single-Writer Authority**:
  - **Local Hub** is the exclusive authoritative writer for orders, items, KOT state transitions, bills, and payments.
  - **Cloud Console** is the exclusive authoritative writer for menu catalogs, items, prices, modifiers, settings, and staff credentials.
- **Exponential Backoff & Poison Command Isolation**:
  - Failed network synchronization requests retry using exponential backoff with randomized jitter ($1\text{s}, 2\text{s}, 4\text{s}, 8\text{s}, \dots$).
  - If a command fails 5 consecutive attempts, it is quarantined to `dead_letter_commands` to prevent head-of-line blocking.
  - Active dead letters and sync lag are continuously tracked and published to Prometheus metrics.

---

## 4. Quickstart Installation

1. Copy or clone repository to edge machine:

   ```bash
   git clone <repo-url> /opt/restaurant-os-hub
   cd /opt/restaurant-os-hub/docker
   ```

2. Run the automated installer:

   ```bash
   chmod +x install-hub.sh backup.sh restore-test.sh
   # Provide an existing restaurant UUID, or omit to auto-generate:
   ./install-hub.sh [RESTAURANT_ID]
   ```

   The installer verifies that:
   - Strong cryptographic secrets are generated for `POSTGRES_PASSWORD`, `JWT_SECRET`, `COOKIE_SECRET`, and `HUB_API_KEY`.
   - Weak defaults (e.g. `postgres`, dictionary words, short strings) are rejected with a fatal error.

3. Verify service health and metrics:

   ```bash
   curl http://localhost:3000/healthz
   # {"status":"ok","timestamp":...}

   curl http://localhost:3000/readyz
   # {"status":"ready","database":"connected","migrations":{"isUpToDate":true,...}}

   curl http://localhost:3000/metrics
   ```

---

## 5. Reverse-Proxy, TLS Termination & `TRUST_PROXY`

Production Local Hub deployments should terminate TLS locally (e.g., using Nginx, Caddy, or Traefik) so handheld devices and browsers connect securely over HTTPS/WSS:

```
[ POS Handhelds / KDS / Tablets ]
             │ (HTTPS / WSS)
             ▼
[ Reverse Proxy (Nginx / Caddy on port 443) ]
             │ (Cleartext HTTP loopback)
             ▼
[ hub-api (127.0.0.1:3000) ]
```

### Fastify `TRUST_PROXY` Configuration

To ensure accurate client IP logging, rate limiting, and audit tracking through the reverse proxy, set `TRUST_PROXY` in `.env.hub`:

```ini
# Single upstream reverse proxy hop (e.g., local Nginx):
TRUST_PROXY=1

# Or specify trusted loopback subnet:
TRUST_PROXY=127.0.0.1,::1
```

Supported values:

- `1`: Trust the immediate upstream proxy hop (inspects `X-Forwarded-For`).
- `127.0.0.1,192.168.1.0/24`: Explicit trusted IP addresses or CIDR blocks.
- `false`: Direct client connections only (ignores `X-Forwarded-*` headers).

---

## 6. Automated Backup & Disaster Recovery Drill

### Automated Nightly Backup (`backup.sh`)

The `hub-backup` container runs `backup.sh` every 24 hours:

- Executes `pg_dump` with `--clean --if-exists`.
- Streams to a temporary file, compresses with gzip (`gzip -9`).
- Verifies archive integrity with `gzip -t`.
- Computes SHA-256 checksum and saves it to `.sql.gz.sha256`.
- Atomically moves the temporary file to `/backups/hub_backup_YYYYMMDD_HHMMSS.sql.gz`.
- Rotates backups older than `RETENTION_DAYS` (default: 14 days).
- Supports optional off-box upload via `BACKUP_S3_BUCKET` (AWS S3) or `RCLONE_REMOTE` (rclone).

### Automated Restoration Drill (`restore-test.sh`)

Test backup recoverability without impacting production data:

```bash
docker exec -it restaurant-hub-backup /docker/restore-test.sh
```

**Runbook Steps executed by `restore-test.sh`:**

1. Locates the newest backup archive in `/backups`.
2. Verifies SHA-256 checksum against `.sha256` digest file.
3. Tests archive integrity using `gzip -t`.
4. Creates an isolated scratch database (e.g. `restaurant_hub_restore_test_<pid>`).
5. Restores the full dump into the scratch database.
6. Runs row-count and schema smoke tests:
   - Validates `_migrations` count $\ge 1$.
   - Validates `restaurants` count $\ge 1$.
   - Validates core public tables count $\ge 10$.
7. Automatically drops the scratch database on completion.
8. Exits 0 on success, non-zero on any verification failure.

### Manual Emergency Restoration Runbook

In the event of hardware failure:

```bash
# 1. Stop API container
docker compose -f docker-compose.hub.yml stop hub-api

# 2. Decompress and restore into PostgreSQL
gunzip -c /backups/hub_backup_YYYYMMDD_HHMMSS.sql.gz | docker exec -i restaurant-hub-db psql -U postgres -d restaurant_hub -v ON_ERROR_STOP=1

# 3. Restart Hub API
docker compose -f docker-compose.hub.yml start hub-api

# 4. Verify readiness
curl http://localhost:3000/readyz
```

---

## 7. Observability & Monitoring

The Local Hub exposes Prometheus metrics on `/metrics`:

- **`restaurant_os_http_request_duration_seconds`**: Request latency histogram by method, route, and status code.
- **`restaurant_os_sync_lag_events`**: Event distance between local sequence and cloud cursor.
- **`restaurant_os_dead_letter_count`**: Active quarantined poison commands requiring review.
- **`restaurant_os_user_lockout_total`**: Account lockout counter from failed login attempts.
- **`restaurant_os_hub_sync_push_total`** & **`restaurant_os_hub_sync_pull_total`**: Success and failure counters for edge-to-cloud synchronization.

Access is protected: requires an authenticated user token with `REPORT_READ` permission or a machine `X-Metrics-Token` header.
