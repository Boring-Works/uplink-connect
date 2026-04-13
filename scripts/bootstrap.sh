#!/usr/bin/env bash
#
# Uplink Connect - Bootstrap Script
# First-time setup for Cloudflare resources and local development
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$PROJECT_ROOT/infra"
APPS_DIR="$PROJECT_ROOT/apps"

# Logging helpers
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${CYAN}[STEP]${NC} $1"; }

# Print banner
print_banner() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║                                                            ║${NC}"
    echo -e "${CYAN}║              UPLINK CONNECT - BOOTSTRAP                    ║${NC}"
    echo -e "${CYAN}║                                                            ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    local missing=()

    if ! command -v node &> /dev/null; then
        missing+=("Node.js 20+")
    elif [[ $(node --version | cut -d'v' -f2 | cut -d'.' -f1) -lt 20 ]]; then
        missing+=("Node.js 20+ (current: $(node --version))")
    fi

    if ! command -v pnpm &> /dev/null; then
        missing+=("pnpm")
    fi

    if ! command -v wrangler &> /dev/null; then
        missing+=("wrangler CLI")
    fi

    if ! command -v git &> /dev/null; then
        missing+=("git")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing prerequisites: ${missing[*]}"
        echo ""
        echo "Install:"
        echo "  Node.js:  https://nodejs.org/ (use v20 LTS)"
        echo "  pnpm:     npm install -g pnpm"
        echo "  wrangler: pnpm add -g wrangler"
        exit 1
    fi

    log_success "All prerequisites met"
}

# Authenticate with Cloudflare
authenticate() {
    log_step "Checking Cloudflare authentication..."

    if wrangler whoami &> /dev/null; then
        local account
        account=$(wrangler whoami 2>/dev/null | grep -E "Account|Email" | head -2 || echo "Unknown")
        log_success "Authenticated with Cloudflare"
        echo "  $account"
    else
        log_warn "Not authenticated with Cloudflare"
        echo ""
        echo "Please run: wrangler login"
        echo ""
        read -p "Press Enter after logging in..."

        if ! wrangler whoami &> /dev/null; then
            log_error "Still not authenticated. Please try again."
            exit 1
        fi
    fi
}

# Install dependencies
install_deps() {
    log_step "Installing dependencies..."
    cd "$PROJECT_ROOT"
    pnpm install
    log_success "Dependencies installed"
}

# Generate wrangler.jsonc files from templates
generate_wrangler_configs() {
    log_step "Generating wrangler configurations..."

    local workers=("uplink-core" "uplink-edge" "uplink-browser" "uplink-ops")

    for worker in "${workers[@]}"; do
        local template="$INFRA_DIR/wrangler.$worker.template.jsonc"
        local target="$APPS_DIR/$worker/wrangler.jsonc"

        if [[ ! -f "$template" ]]; then
            log_warn "Template not found: $template"
            continue
        fi

        if [[ -f "$target" ]]; then
            log_warn "wrangler.jsonc already exists for $worker"
            read -p "Overwrite? (y/N): " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "Skipping $worker"
                continue
            fi
        fi

        cp "$template" "$target"
        log_success "Generated $target"
    done
}

# Create D1 database
create_d1_database() {
    log_step "Creating D1 database..."

    local db_name="uplink-control"

    # Check if exists
    if wrangler d1 list --json 2>/dev/null | jq -e ".[] | select(.name == \"$db_name\")" &> /dev/null; then
        log_success "D1 database already exists: $db_name"
        local db_id
        db_id=$(wrangler d1 list --json | jq -r ".[] | select(.name == \"$db_name\") | .uuid")
        echo "  Database ID: $db_id"
        return 0
    fi

    log_info "Creating D1 database: $db_name"
    local output
    output=$(wrangler d1 create "$db_name" 2>&1)

    if [[ $? -eq 0 ]]; then
        log_success "D1 database created"
        echo "$output" | grep -E "database_id|uuid" || true
    else
        log_error "Failed to create D1 database"
        echo "$output"
        return 1
    fi
}

# Create R2 bucket
create_r2_bucket() {
    log_step "Creating R2 bucket..."

    local bucket_name="uplink-raw"

    if wrangler r2 bucket list 2>/dev/null | grep -q "^$bucket_name$"; then
        log_success "R2 bucket already exists: $bucket_name"
        return 0
    fi

    log_info "Creating R2 bucket: $bucket_name"
    if wrangler r2 bucket create "$bucket_name" 2>&1; then
        log_success "R2 bucket created: $bucket_name"
    else
        log_error "Failed to create R2 bucket"
        return 1
    fi
}

# Create queues
create_queues() {
    log_step "Creating Queues..."

    local queues=("uplink-ingest" "uplink-ingest-dlq")

    for queue in "${queues[@]}"; do
        if wrangler queues list 2>/dev/null | grep -q "^$queue$"; then
            log_success "Queue exists: $queue"
        else
            log_info "Creating queue: $queue"
            if wrangler queues create "$queue" 2>&1; then
                log_success "Created queue: $queue"
            else
                log_error "Failed to create queue: $queue"
            fi
        fi
    done
}

# Create Vectorize index
create_vectorize_index() {
    log_step "Creating Vectorize index..."

    local index_name="uplink-entities"

    if wrangler vectorize list 2>/dev/null | grep -q "^$index_name$"; then
        log_success "Vectorize index already exists: $index_name"
        return 0
    fi

    log_info "Creating Vectorize index: $index_name"
    # Using 384 dimensions for gte-small embeddings
    if wrangler vectorize create "$index_name" --dimensions 384 --metric cosine 2>&1; then
        log_success "Vectorize index created: $index_name"
    else
        log_warn "Failed to create Vectorize index (feature may not be enabled on your account)"
        log_info "You can enable it later in the Cloudflare dashboard"
    fi
}

# Create .env files
create_env_files() {
    log_step "Creating environment files..."

    # Root .env for local development
    local root_env="$PROJECT_ROOT/.env"
    if [[ ! -f "$root_env" ]]; then
        cat > "$root_env" << 'EOF'
# Uplink Connect - Local Development Environment
# Copy secrets from Cloudflare dashboard or set via wrangler

# API Keys (generate strong random values)
INGEST_API_KEY=dev-ingest-key-change-in-production
OPS_API_KEY=dev-ops-key-change-in-production
BROWSER_API_KEY=dev-browser-key-change-in-production
CORE_INTERNAL_KEY=dev-internal-key-change-in-production

# Optional: Custom domains
# UPLINK_EDGE_URL=https://edge.your-domain.com
# UPLINK_CORE_URL=https://core.your-domain.com
# UPLINK_BROWSER_URL=https://browser.your-domain.com
# UPLINK_OPS_URL=https://ops.your-domain.com
EOF
        log_success "Created $root_env"
    else
        log_warn "$root_env already exists"
    fi

    # .dev.vars for wrangler dev
    local dev_vars="$PROJECT_ROOT/.dev.vars"
    if [[ ! -f "$dev_vars" ]]; then
        cat > "$dev_vars" << 'EOF'
# Local development secrets (used by wrangler dev)
INGEST_API_KEY=dev-ingest-key
OPS_API_KEY=dev-ops-key
BROWSER_API_KEY=dev-browser-key
CORE_INTERNAL_KEY=dev-internal-key
EOF
        log_success "Created $dev_vars"
    else
        log_warn "$dev_vars already exists"
    fi
}

# Setup secrets
setup_secrets() {
    log_step "Setting up secrets..."

    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "You need to set the following secrets in Cloudflare:"
    echo ""
    echo "  1. INGEST_API_KEY      - For /v1/intake endpoint auth"
    echo "  2. OPS_API_KEY         - For ops API auth"
    echo "  3. BROWSER_API_KEY     - For browser service auth"
    echo "  4. CORE_INTERNAL_KEY   - For internal service communication"
    echo ""
    echo "Generate strong random values:"
    echo "  openssl rand -base64 32"
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""

    read -p "Set secrets now? (y/N): " -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Skipping secret setup"
        print_secret_instructions
        return 0
    fi

    # Set INGEST_API_KEY for uplink-edge
    echo ""
    log_info "Setting INGEST_API_KEY for uplink-edge..."
    wrangler secret put INGEST_API_KEY --name uplink-edge

    # Set CORE_INTERNAL_KEY for uplink-edge and uplink-core
    echo ""
    log_info "Setting CORE_INTERNAL_KEY for uplink-edge..."
    wrangler secret put CORE_INTERNAL_KEY --name uplink-edge

    echo ""
    log_info "Setting CORE_INTERNAL_KEY for uplink-core..."
    wrangler secret put CORE_INTERNAL_KEY --name uplink-core

    # Set BROWSER_API_KEY for uplink-browser
    echo ""
    log_info "Setting BROWSER_API_KEY for uplink-browser..."
    wrangler secret put BROWSER_API_KEY --name uplink-browser

    # Set OPS_API_KEY and CORE_INTERNAL_KEY for uplink-ops
    echo ""
    log_info "Setting OPS_API_KEY for uplink-ops..."
    wrangler secret put OPS_API_KEY --name uplink-ops

    echo ""
    log_info "Setting CORE_INTERNAL_KEY for uplink-ops..."
    wrangler secret put CORE_INTERNAL_KEY --name uplink-ops

    log_success "Secrets configured"
}

# Print secret instructions
print_secret_instructions() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo "To set secrets manually, run:"
    echo ""
    echo "  wrangler secret put INGEST_API_KEY --name uplink-edge"
    echo "  wrangler secret put CORE_INTERNAL_KEY --name uplink-edge"
    echo "  wrangler secret put CORE_INTERNAL_KEY --name uplink-core"
    echo "  wrangler secret put BROWSER_API_KEY --name uplink-browser"
    echo "  wrangler secret put OPS_API_KEY --name uplink-ops"
    echo "  wrangler secret put CORE_INTERNAL_KEY --name uplink-ops"
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
}

# Print next steps
print_next_steps() {
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    BOOTSTRAP COMPLETE                      ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Next steps:"
    echo ""
    echo "  1. Deploy the platform:"
    echo "     ./scripts/deploy.sh"
    echo ""
    echo "  2. Run smoke tests:"
    echo "     ./scripts/smoke-test.sh"
    echo ""
    echo "  3. Start local development:"
    echo "     pnpm dev:edge    # Terminal 1"
    echo "     pnpm dev:core    # Terminal 2"
    echo "     pnpm dev:browser # Terminal 3"
    echo ""
    echo "  4. View logs:"
    echo "     wrangler tail --name uplink-core"
    echo ""
    echo "Documentation:"
    echo "  - infra/README.md"
    echo "  - CLAUDE.md"
    echo ""
}

# Main bootstrap flow
main() {
    print_banner

    check_prerequisites
    authenticate
    install_deps

    # Create Cloudflare resources
    create_d1_database
    create_r2_bucket
    create_queues
    create_vectorize_index

    # Generate configs and env files
    generate_wrangler_configs
    create_env_files

    # Setup secrets
    setup_secrets

    print_next_steps
}

# Handle command line arguments
case "${1:-}" in
    --secrets)
        setup_secrets
        exit 0
        ;;
    --resources)
        authenticate
        create_d1_database
        create_r2_bucket
        create_queues
        create_vectorize_index
        exit 0
        ;;
    --env)
        create_env_files
        exit 0
        ;;
    --help|-h)
        echo "Uplink Connect Bootstrap Script"
        echo ""
        echo "Usage: $0 [options]"
        echo ""
        echo "Options:"
        echo "  (no args)      Full bootstrap"
        echo "  --secrets      Set up secrets only"
        echo "  --resources    Create Cloudflare resources only"
        echo "  --env          Create environment files only"
        echo "  --help         Show this help"
        echo ""
        exit 0
        ;;
    *)
        main
        ;;
esac
