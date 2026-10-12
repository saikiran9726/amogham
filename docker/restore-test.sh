#!/usr/bin/env bash
set -euo pipefail

# Configuration
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
SCRATCH_DB="${SCRATCH_DB:-restaurant_hub_restore_test_$$}"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Starting automated restoration drill..."

# 1. Locate the newest backup archive
NEWEST_BACKUP=$(ls -t "${BACKUP_DIR}"/hub_backup_*.sql.gz 2>/dev/null | head -n 1 || true)
if [ -z "${NEWEST_BACKUP}" ] || [ ! -f "${NEWEST_BACKUP}" ]; then
  echo "ERROR: No backup archives found matching hub_backup_*.sql.gz in ${BACKUP_DIR}" >&2
  exit 1
fi

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Found newest backup: ${NEWEST_BACKUP}"

# 2. Checksum verification if sha256 file exists
CHECKSUM_FILE="${NEWEST_BACKUP}.sha256"
if [ -f "${CHECKSUM_FILE}" ]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Verifying SHA-256 checksum..."
  (cd "$(dirname "${NEWEST_BACKUP}")" && sha256sum -c "$(basename "${CHECKSUM_FILE}")")
else
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Warning: Checksum file not found, continuing with gzip verification..."
fi

# 3. Verify gzip archive integrity
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Testing gzip archive integrity..."
if ! gzip -t "${NEWEST_BACKUP}"; then
  echo "ERROR: Corrupt backup archive detected: ${NEWEST_BACKUP}" >&2
  exit 1
fi

# 4. Create isolated scratch database
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Creating scratch database ${SCRATCH_DB} on ${PGHOST}..."
dropdb -h "${PGHOST}" -U "${PGUSER}" --if-exists "${SCRATCH_DB}" 2>/dev/null || true
createdb -h "${PGHOST}" -U "${PGUSER}" "${SCRATCH_DB}"

cleanup_scratch() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Dropping scratch database ${SCRATCH_DB}..."
  dropdb -h "${PGHOST}" -U "${PGUSER}" --if-exists "${SCRATCH_DB}" 2>/dev/null || true
}
trap cleanup_scratch EXIT

# 5. Restore backup into scratch database
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Restoring schema and data into scratch database..."
gunzip -c "${NEWEST_BACKUP}" | psql -h "${PGHOST}" -U "${PGUSER}" -d "${SCRATCH_DB}" -v ON_ERROR_STOP=1 --quiet

# 6. Execute row-count smoke test
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] Running schema and row-count verification smoke tests..."

MIGRATIONS_COUNT=$(psql -h "${PGHOST}" -U "${PGUSER}" -d "${SCRATCH_DB}" -t -A -c "SELECT count(*) FROM _migrations;" 2>/dev/null || echo "0")
echo "  - Migrations applied: ${MIGRATIONS_COUNT}"

if [ "${MIGRATIONS_COUNT}" -lt 1 ]; then
  echo "ERROR: Restoration smoke test failed: _migrations table is empty or missing" >&2
  exit 1
fi

RESTAURANTS_COUNT=$(psql -h "${PGHOST}" -U "${PGUSER}" -d "${SCRATCH_DB}" -t -A -c "SELECT count(*) FROM restaurants;" 2>/dev/null || echo "0")
echo "  - Restaurant entities found: ${RESTAURANTS_COUNT}"

TABLES_COUNT=$(psql -h "${PGHOST}" -U "${PGUSER}" -d "${SCRATCH_DB}" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0")
echo "  - Public tables restored: ${TABLES_COUNT}"

if [ "${TABLES_COUNT}" -lt 10 ]; then
  echo "ERROR: Restoration smoke test failed: expected at least 10 core tables, found ${TABLES_COUNT}" >&2
  exit 1
fi

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [restore-test] SUCCESS: Restoration drill passed all smoke tests!"
