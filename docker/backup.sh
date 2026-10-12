#!/usr/bin/env bash
set -euo pipefail

# Database and Backup Configuration
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-restaurant_hub}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Starting PostgreSQL backup for ${PGDATABASE}@${PGHOST}..."

mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
FINAL_BACKUP="${BACKUP_DIR}/hub_backup_${TIMESTAMP}.sql.gz"
CHECKSUM_FILE="${FINAL_BACKUP}.sha256"
TMP_BACKUP="${BACKUP_DIR}/.tmp_hub_backup_${TIMESTAMP}_$$.sql.gz"

# Clean up temporary dump file on exit if failure occurs
cleanup_tmp() {
  if [ -f "${TMP_BACKUP}" ]; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Cleaning up incomplete temporary file..." >&2
    rm -f "${TMP_BACKUP}"
  fi
}
trap cleanup_tmp EXIT

# 1. Stream pg_dump through gzip to temporary file
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Creating database dump to temporary location..."
pg_dump -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" --clean --if-exists | gzip -9 > "${TMP_BACKUP}"

# 2. Verify gzip archive integrity
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Verifying archive integrity with gzip -t..."
if ! gzip -t "${TMP_BACKUP}"; then
  echo "ERROR: Corrupt gzip dump generated for ${PGDATABASE}" >&2
  exit 1
fi

# 3. Calculate SHA-256 checksum
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Calculating SHA-256 checksum..."
TMP_CHECKSUM=$(sha256sum "${TMP_BACKUP}" | awk '{print $1}')

# 4. Atomic move to final backup destination
mv "${TMP_BACKUP}" "${FINAL_BACKUP}"
trap - EXIT

# Write checksum alongside backup
echo "${TMP_CHECKSUM}  $(basename "${FINAL_BACKUP}")" > "${CHECKSUM_FILE}"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Backup created successfully: ${FINAL_BACKUP} (Size: $(du -sh "${FINAL_BACKUP}" | cut -f1))"

# 5. Optional off-box upload (S3 / rclone via environment)
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v aws &>/dev/null; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Uploading backup to S3 bucket ${BACKUP_S3_BUCKET}..."
    aws s3 cp "${FINAL_BACKUP}" "${BACKUP_S3_BUCKET}/$(basename "${FINAL_BACKUP}")"
    aws s3 cp "${CHECKSUM_FILE}" "${BACKUP_S3_BUCKET}/$(basename "${CHECKSUM_FILE}")"
  else
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] WARNING: BACKUP_S3_BUCKET set but aws CLI is not installed" >&2
  fi
fi

if [ -n "${RCLONE_REMOTE:-}" ]; then
  if command -v rclone &>/dev/null; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Uploading backup to rclone remote ${RCLONE_REMOTE}..."
    rclone copy "${FINAL_BACKUP}" "${RCLONE_REMOTE}"
    rclone copy "${CHECKSUM_FILE}" "${RCLONE_REMOTE}"
  else
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] WARNING: RCLONE_REMOTE set but rclone CLI is not installed" >&2
  fi
fi

# 6. Retention rotation: purge backups older than RETENTION_DAYS
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Purging local backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "hub_backup_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -exec rm -f {} +
find "${BACKUP_DIR}" -name "hub_backup_*.sql.gz.sha256" -type f -mtime +"${RETENTION_DAYS}" -exec rm -f {} +

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [backup] Backup cycle completed."
