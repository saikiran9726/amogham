#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Restaurant OS - Local Hub Automated Installer"
echo "=========================================================="

# Check Docker and Docker Compose
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed. Please install Docker Engine first." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.hub"

# Function to generate a secure UUIDv4
generate_uuid() {
    if command -v uuidgen &>/dev/null; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    elif command -v python3 &>/dev/null; then
        python3 -c 'import uuid; print(str(uuid.uuid4()))'
    elif [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
    else
        # Fallback to random hex formatted as UUID
        od -x /dev/urandom | head -1 | awk '{OFS="-"; print $2$3,$4,$5,$6,$7$8$9}'
    fi
}

# Function to generate strong cryptographic secrets
generate_secret() {
    local length="${1:-32}"
    if command -v openssl &>/dev/null; then
        openssl rand -hex "$((length / 2))"
    else
        head /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "$length"
    fi
}

# Resolve or generate RESTAURANT_ID (no hardcoded UUID)
PARAM_RESTAURANT_ID="${1:-}"

if [ ! -f "$ENV_FILE" ]; then
    echo "[install] No existing .env.hub found. Generating fresh configuration..."
    
    if [ -n "$PARAM_RESTAURANT_ID" ]; then
        TARGET_RESTAURANT_ID="$PARAM_RESTAURANT_ID"
    else
        TARGET_RESTAURANT_ID="$(generate_uuid)"
        echo "[install] Generated new Restaurant UUID: ${TARGET_RESTAURANT_ID}"
    fi

    POSTGRES_PASS="$(generate_secret 24)"
    JWT_SEC="$(generate_secret 48)"
    COOKIE_SEC="$(generate_secret 48)"
    HUB_KEY="$(generate_secret 32)"

    cat <<EOF > "$ENV_FILE"
RESTAURANT_ID=${TARGET_RESTAURANT_ID}
HUB_DEVICE_ID=hub-lan-primary
HUB_API_KEY=${HUB_KEY}
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${POSTGRES_PASS}
POSTGRES_DB=restaurant_hub
JWT_SECRET=${JWT_SEC}
COOKIE_SECRET=${COOKIE_SEC}
CLOUD_SYNC_URL=https://cloud.restaurant-os.internal
CORS_ORIGIN=http://localhost:5173
EOF
    echo "[install] Successfully generated strong credentials in ${ENV_FILE}"
else
    # If passed as parameter, override RESTAURANT_ID in existing file
    if [ -n "$PARAM_RESTAURANT_ID" ]; then
        sed -i.bak "s|^RESTAURANT_ID=.*|RESTAURANT_ID=${PARAM_RESTAURANT_ID}|" "$ENV_FILE"
        rm -f "${ENV_FILE}.bak"
        echo "[install] Updated RESTAURANT_ID in ${ENV_FILE} to ${PARAM_RESTAURANT_ID}"
    fi
fi

# Load environment file
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Strict validation: refuse to start with weak or default secrets
check_secret_strength() {
    local name="$1"
    local value="$2"
    local min_length="$3"

    if [ -z "$value" ]; then
        echo "ERROR: Configuration secret '${name}' is empty or missing." >&2
        return 1
    fi

    if [ "${#value}" -lt "$min_length" ]; then
        echo "ERROR: Configuration secret '${name}' has length ${#value}, minimum required is ${min_length}." >&2
        return 1
    fi

    # Known weak / placeholder passwords
    case "$value" in
        *postgres*|*postgres_hub_local_pass*|*restaurant_os_hub_*|*password*|*secret*|*change_me*|*123456*)
            echo "ERROR: Secret '${name}' contains insecure default or dictionary word ('${value}'). Refusing to start." >&2
            return 1
            ;;
    esac

    return 0
}

echo "[install] Validating cryptographic secret quality..."
FAILED_CHECKS=0

check_secret_strength "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD" 16 || FAILED_CHECKS=$((FAILED_CHECKS + 1))
check_secret_strength "JWT_SECRET" "$JWT_SECRET" 32 || FAILED_CHECKS=$((FAILED_CHECKS + 1))
check_secret_strength "COOKIE_SECRET" "$COOKIE_SECRET" 32 || FAILED_CHECKS=$((FAILED_CHECKS + 1))
check_secret_strength "HUB_API_KEY" "$HUB_API_KEY" 24 || FAILED_CHECKS=$((FAILED_CHECKS + 1))

if [ "$FAILED_CHECKS" -gt 0 ]; then
    echo "" >&2
    echo "FATAL: Deployment refused due to weak or default credentials in ${ENV_FILE}." >&2
    echo "Please update ${ENV_FILE} with cryptographically strong secrets or delete it to regenerate." >&2
    exit 1
fi

echo "[install] Secrets verification passed."
echo "[install] Launching Local Hub services with docker compose..."

docker compose -f "${SCRIPT_DIR}/docker-compose.hub.yml" --env-file "$ENV_FILE" up -d

echo ""
echo "=========================================================="
echo " Local Hub successfully deployed!"
echo " Restaurant ID: ${RESTAURANT_ID}"
echo " Status check:  curl http://localhost:3000/healthz"
echo " Metrics:       curl http://localhost:3000/metrics"
echo " Log streams:   docker compose -f ${SCRIPT_DIR}/docker-compose.hub.yml logs -f"
echo "=========================================================="
