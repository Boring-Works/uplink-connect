#!/usr/bin/env bash
#
# Uplink Connect - Main Deployment Script
# Idempotent deployment of all workers and Cloudflare resources
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$PROJECT_ROOT/apps"
INFRA_DIR="$PROJECT_ROOT/infra"

# Workers in dependency order (core must be first due to service bindings)
WORKERS=("uplink-core" "uplink-edge" "uplink-browser" "uplink-ops")

# Required secrets per worker
declare -A WORKER_SECRETS=(
    ["uplink-edge"]="INGEST_API_KEY CORE_INTERNAL_KEY"
    ["uplink-core"]="CORE_INTERNAL_KEY"
    ["uplink-browser"]="BROWSER_API_KEY"
    ["uplink-ops"]="OPS_API_KEY CORE_INTERNAL_KEY"
)

# Logging helpers
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js version
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi

    local node_version
    node_version=$(node --version | cut -d'v' -f2)
    local major_version
    major_version=$(echo "$node_version" | cut -d'.' -f1)

    if [[ "$major_version" -lt 20 ]]; then
        log_error "Node.js 20+ required, found $node_version"
        exit 1
    fi
    log_success "Node.js $node_version"

    # Check pnpm
    if ! command -v pnpm &> /dev/null; then
        log_error "pnpm is not installed. Install with: npm install -g pnpm"
        exit 1
    fi
    log_success "pnpm $(pnpm --version)"

    # Check wrangler
    if ! command -v wrangler &> /dev/null; then
        log_error "wrangler is not installed. Install with: pnpm add -g wrangler"
        exit 1
    fi

    local wrangler_version
    wrangler_version=$(wrangler --version | head -1 | awk '{print $2}')
    log_success "wrangler $wrangler_version"

    # Check authentication
    if ! wrangler whoami &> /dev/null; then
        log_error "Not authenticated with Cloudflare. Run: wrangler login"
        exit 1
    fi
    log_success "Authenticated with Cloudflare"

    # Verify project structure
    for worker in "${WORKERS[@]}"; do
        if [[ ! -d "$APPS_DIR/$worker" ]]; then
            log_error "Worker directory not found: $APPS_DIR/$worker"
            exit 1
        fi
        if [[ ! -f "$APPS_DIR/$worker/wrangler.jsonc" ]]; then
            log_error "wrangler.jsonc not found for $worker"
            exit 1
        fi
    done
    log_success "Project structure verified"
}

# Get or create D1 database
setup_d1_database() {
    local db_name="uplink-control"
    log_info "Setting up D1 database: $db_name"

    # Check if database exists
    local db_id
    db_id=$(wrangler d1 list --json 2>/dev/null | jq -r ".[] | select(.name == \"$db_name\") | .uuid" || true)

    if [[ -z "$db_id" ]]; then
        log_info "Creating D1 database: $db_name"
        local create_output
        create_output=$(wrangler d1 create "$db_name" --json 2>/dev/null || true)

        if [[ -z "$create_output" ]] || [[ "$create_output" == "null" ]]; then
            # Try to get the ID from list after creation
            sleep 2
            db_id=$(wrangler d1 list --json 2>/dev/null | jq -r ".[] | select(.name == \"$db_name\") | .uuid" || true)
        else
            db_id=$(echo "$create_output" | jq -r '.uuid // .id // empty' 2>/dev/null || true)
        fi

        if [[ -z "$db_id" ]]; then
            log_error "Failed to create or find D1 database: $db_name"
            exit 1
        fi
        log_success "Created D1 database: $db_name ($db_id)"
    else
        log_success "D1 database exists: $db_name ($db_id)"
    fi

    # Update wrangler.jsonc with database ID
    local wrangler_config="$APPS_DIR/uplink-core/wrangler.jsonc"
    if [[ -f "$wrangler_config" ]]; then
        # Use sed to replace the database_id placeholder
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/\"database_id\": \"<CONTROL_DB_ID>\"/\"database_id\": \"$db_id\"/" "$wrangler_config"
        else
            sed -i "s/\"database_id\": \"<CONTROL_DB_ID>\"/\"database_id\": \"$db_id\"/" "$wrangler_config"
        fi
        log_success "Updated wrangler.jsonc with database ID"
    fi

    echo "$db_id"
}

# Apply D1 migrations
apply_migrations() {
    local db_name="uplink-control"
    log_info "Applying D1 migrations..."

    cd "$APPS_DIR/uplink-core"

    # Apply migrations to remote
    if wrangler d1 migrations apply "$db_name" --remote 2>&1; then
        log_success "Migrations applied successfully"
    else
        log_warn "Migration apply returned non-zero, checking status..."
        # Check if it's just "no migrations to apply"
        local migration_list
        migration_list=$(wrangler d1 migrations list "$db_name" --remote --json 2>/dev/null || echo "[]")
        log_info "Current migration status: $migration_list"
    fi

    cd "$PROJECT_ROOT"
}

# Setup R2 bucket
setup_r2_bucket() {
    local bucket_name="uplink-raw"
    log_info "Setting up R2 bucket: $bucket_name"

    # Check if bucket exists
    if wrangler r2 bucket list 2>/dev/null | grep -q "^$bucket_name$"; then
        log_success "R2 bucket exists: $bucket_name"
    else
        log_info "Creating R2 bucket: $bucket_name"
        if wrangler r2 bucket create "$bucket_name" 2>&1; then
            log_success "Created R2 bucket: $bucket_name"
        else
            log_warn "Failed to create R2 bucket (may already exist or permission issue)"
        fi
    fi
}

# Setup Queues
setup_queues() {
    log_info "Setting up Queues..."

    local queues=("uplink-ingest" "uplink-ingest-dlq")

    for queue in "${queues[@]}"; do
        if wrangler queues list 2>/dev/null | grep -q "^$queue$"; then
            log_success "Queue exists: $queue"
        else
            log_info "Creating queue: $queue"
            if wrangler queues create "$queue" 2>&1; then
                log_success "Created queue: $queue"
            else
                log_warn "Failed to create queue: $queue (may already exist)"
            fi
        fi
    done

    # Set up queue consumer for uplink-core
    log_info "Setting up queue consumer for uplink-core..."
    if wrangler queues consumer add uplink-ingest uplink-core 2>&1; then
        log_success "Queue consumer configured"
    else
        log_warn "Queue consumer may already be configured"
    fi
}

# Setup Vectorize index
setup_vectorize() {
    local index_name="uplink-entities"
    log_info "Setting up Vectorize index: $index_name"

    # Check if index exists
    if wrangler vectorize list 2>/dev/null | grep -q "^$index_name$"; then
        log_success "Vectorize index exists: $index_name"
    else
        log_info "Creating Vectorize index: $index_name"
        # Create with 384 dimensions (gte-small embeddings) and cosine metric
        if wrangler vectorize create "$index_name" --dimensions 384 --metric cosine 2>&1; then
            log_success "Created Vectorize index: $index_name"
        else
            log_warn "Failed to create Vectorize index (may already exist or feature not enabled)"
        fi
    fi
}

# Check secrets are set
check_secrets() {
    local worker=$1
    log_info "Checking secrets for $worker..."

    local secrets="${WORKER_SECRETS[$worker]:-}"
    if [[ -z "$secrets" ]]; then
        log_info "No secrets required for $worker"
        return 0
    fi

    local missing_secrets=()
    for secret in $secrets; do
        # Check if secret is set via wrangler
        if ! wrangler secret list --name "$worker" 2>/dev/null | grep -q "^$secret$"; then
            missing_secrets+=("$secret")
        fi
    done

    if [[ ${#missing_secrets[@]} -gt 0 ]]; then
        log_warn "Missing secrets for $worker: ${missing_secrets[*]}"
        log_info "Set them with: wrangler secret put <SECRET_NAME> --name $worker"
        return 1
    fi

    log_success "All secrets configured for $worker"
    return 0
}

# Deploy a single worker
deploy_worker() {
    local worker=$1
    log_info "Deploying $worker..."

    cd "$APPS_DIR/$worker"

    # Build first
    log_info "Building $worker..."
    pnpm build 2>&1 | tail -20

    # Deploy
    log_info "Deploying $worker to Cloudflare..."
    if wrangler deploy 2>&1; then
        log_success "Deployed $worker"
    else
        log_error "Failed to deploy $worker"
        cd "$PROJECT_ROOT"
        return 1
    fi

    cd "$PROJECT_ROOT"
}

# Health check a deployed worker
health_check_worker() {
    local worker=$1
    log_info "Health checking $worker..."

    local url
    case "$worker" in
        uplink-core)
            url="https://uplink-core.boringworks.workers.dev/health"
            ;;
        uplink-edge)
            url="https://uplink-edge.boringworks.workers.dev/health"
            ;;
        uplink-browser)
            url="https://uplink-browser.boringworks.workers.dev/health"
            ;;
        uplink-ops)
            url="https://uplink-ops.boringworks.workers.dev/health"
            ;;
        *)
            log_warn "Unknown worker: $worker"
            return 1
            ;;
    esac

    local response
    local http_code
    response=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

    if [[ "$response" == "200" ]]; then
        log_success "$worker health check passed"
        return 0
    else
        log_error "$worker health check failed (HTTP $response)"
        return 1
    fi
}

# Main deployment flow
main() {
    log_info "Starting Uplink Connect deployment..."
    log_info "Project root: $PROJECT_ROOT"

    # Step 1: Prerequisites
    check_prerequisites

    # Step 2: Setup Cloudflare resources (idempotent)
    log_info "=== Setting up Cloudflare resources ==="
    setup_d1_database
    setup_r2_bucket
    setup_queues
    setup_vectorize

    # Step 3: Apply migrations
    log_info "=== Applying database migrations ==="
    apply_migrations

    # Step 4: Check secrets
    log_info "=== Checking secrets ==="
    local missing_secrets=false
    for worker in "${WORKERS[@]}"; do
        if ! check_secrets "$worker"; then
            missing_secrets=true
        fi
    done

    if [[ "$missing_secrets" == true ]]; then
        log_warn "Some secrets are missing. Deployment will continue but workers may fail."
        log_info "Set missing secrets with: ./scripts/bootstrap.sh --secrets"
    fi

    # Step 5: Deploy workers in order
    log_info "=== Deploying workers ==="
    for worker in "${WORKERS[@]}"; do
        deploy_worker "$worker"
    done

    # Step 6: Health checks
    log_info "=== Running health checks ==="
    local health_check_failed=false
    for worker in "${WORKERS[@]}"; do
        if ! health_check_worker "$worker"; then
            health_check_failed=true
        fi
    done

    if [[ "$health_check_failed" == true ]]; then
        log_warn "Some health checks failed. Workers may still be starting up."
        log_info "Run ./scripts/smoke-test.sh to validate deployment"
    else
        log_success "All health checks passed"
    fi

    log_success "Deployment complete!"
    log_info ""
    log_info "Next steps:"
    log_info "  - Run smoke tests: ./scripts/smoke-test.sh"
    log_info "  - View logs: wrangler tail --name <worker-name>"
    log_info "  - Set up custom domains in Cloudflare dashboard"
}

# Handle command line arguments
case "${1:-}" in
    --check)
        check_prerequisites
        exit 0
        ;;
    --resources)
        setup_d1_database
        setup_r2_bucket
        setup_queues
        setup_vectorize
        exit 0
        ;;
    --workers)
        for worker in "${WORKERS[@]}"; do
            deploy_worker "$worker"
        done
        exit 0
        ;;
    --health)
        for worker in "${WORKERS[@]}"; do
            health_check_worker "$worker"
        done
        exit 0
        ;;
    --help|-h)
        echo "Uplink Connect Deployment Script"
        echo ""
        echo "Usage: $0 [options]"
        echo ""
        echo "Options:"
        echo "  (no args)     Full deployment"
        echo "  --check       Check prerequisites only"
        echo "  --resources   Setup Cloudflare resources only"
        echo "  --workers     Deploy workers only"
        echo "  --health      Run health checks only"
        echo "  --help        Show this help"
        echo ""
        echo "Environment:"
        echo "  Ensure you are logged in: wrangler login"
        exit 0
        ;;
    *)
        main
        ;;
esac
