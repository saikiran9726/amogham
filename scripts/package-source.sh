#!/usr/bin/env bash
set -euo pipefail

# scripts/package-source.sh
# Produces a clean source archive from git HEAD without node_modules, .env, or transient build artifacts.

OUTPUT_DIR="${1:-dist}"
ARCHIVE_NAME="${2:-restaurant-os-source.tar.gz}"
OUTPUT_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}"

mkdir -p "${OUTPUT_DIR}"

echo "==> Creating clean git archive at ${OUTPUT_PATH}..."
git archive --format=tar.gz --prefix=restaurant-os/ -o "${OUTPUT_PATH}" HEAD

echo "==> Validating archive integrity and absence of forbidden files..."
tar -tzf "${OUTPUT_PATH}" > "${OUTPUT_DIR}/.archive-contents.txt"

# Assert no node_modules or .env files are included
if grep -E "(^|/)(node_modules/|\.env|\.env\..*|dist/)" "${OUTPUT_DIR}/.archive-contents.txt" | grep -v "\.env\.example"; then
  echo "ERROR: Archive contains forbidden artifacts!" >&2
  rm -f "${OUTPUT_DIR}/.archive-contents.txt" "${OUTPUT_PATH}"
  exit 1
fi

rm -f "${OUTPUT_DIR}/.archive-contents.txt"

ARCHIVE_SIZE=$(wc -c < "${OUTPUT_PATH}")
echo "==> Successfully created clean archive: ${OUTPUT_PATH} (${ARCHIVE_SIZE} bytes)"
