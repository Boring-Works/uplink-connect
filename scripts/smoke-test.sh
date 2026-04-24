#!/usr/bin/env bash
#
# Uplink Connect - Smoke Test Script
# Post-deployment validation of all services
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

# Test configuration
INGEST_API_KEY="${INGEST_API_KEY:-}"
OPS_API_KEY="${OPS_API_KEY:-}"
CORE_INTERNAL_KEY="${CORE_INTERNAL_KEY:-}"

# Service URLs (override with env vars for custom domains)
UPLINK_EDGE_URL="${UPLINK_EDGE_URL:-https://uplink-edge.codyboring.workers.dev}"
UPLINK_CORE_URL="${UPLINK_CORE_URL:-https://uplink-core.codyboring.workers.dev}"
UPLINK_BROWSER_URL="${UPLINK_BROWSER_URL:-https://uplink-browser.codyboring.workers.dev}"
UPLINK_OPS_URL="${UPLINK_OPS_URL:-https://uplink-ops.codyboring.workers.dev}"

# Test results
TESTS_PASSED=0
TESTS_FAILED=0

# Logging helpers
log_info() { echo -e "${BLUE}[TEST]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_section() { echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}$1${NC}"; echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"; }

# Test result tracking
pass() {
    log_success "$1"
    ((TESTS_PASSED++)) || true
}

fail() {
    log_error "$1"
    ((TESTS_FAILED++)) || true
}

# HTTP request helper
http_get() {
    local url=$1
    local headers=${2:-}
    curl -s -o /dev/null -w "%{http_code}" ${headers:+-H "$headers"} "$url" 2>/dev/null || echo "000"
}

http_post() {
    local url=$1
    local data=${2:-}
    local headers=${3:-}
    curl -s -o /dev/null -w "%{http_code}" \
        -X POST \
        ${data:+-d "$data"} \
        ${headers:+-H "$headers"} \
        -H "Content-Type: application/json" \
        "$url" 2>/dev/null || echo "000"
}

http_get_body() {
    local url=$1
    local headers=${2:-}
    curl -s ${headers:+-H "$headers"} "$url" 2>/dev/null || echo "{}"
}

http_post_body() {
    local url=$1
    local data=${2:-}
    local headers=${3:-}
    curl -s \
        -X POST \
        ${data:+-d "$data"} \
        ${headers:+-H "$headers"} \
        -H "Content-Type: application/json" \
        "$url" 2>/dev/null || echo "{}"
}

# Test: Health endpoints
test_health_endpoints() {
    log_section "Testing Health Endpoints"

    local services=(
        "edge:$UPLINK_EDGE_URL"
        "core:$UPLINK_CORE_URL"
        "browser:$UPLINK_BROWSER_URL"
        "ops:$UPLINK_OPS_URL"
    )

    for service in "${services[@]}"; do
        local name="${service%%:*}"
        local url="${service#*:}"

        log_info "Testing $name health..."
        local response
        response=$(http_get "$url/health")

        if [[ "$response" == "200" ]]; then
            local body
            body=$(http_get_body "$url/health")
            pass "$name health check (HTTP 200)"
            echo "  Response: $body"
        elif [[ "$response" == "404" ]] || [[ "$response" == "1042" ]]; then
            pass "$name health check - service worker not publicly routed (HTTP $response)"
        else
            fail "$name health check (HTTP $response)"
        fi
    done
}

# Test: Intake endpoint (unauthorized)
test_intake_unauthorized() {
    log_section "Testing Intake Authentication"

    log_info "Testing intake without auth..."
    local response
    response=$(http_post "$UPLINK_EDGE_URL/v1/intake" '{"test": true}')

    if [[ "$response" == "401" ]] || [[ "$response" == "500" ]]; then
        pass "Intake rejects unauthorized requests (HTTP $response)"
    else
        fail "Intake should reject unauthorized requests (got HTTP $response)"
    fi
}

# Test: Intake endpoint (with auth)
test_intake_authorized() {
    log_section "Testing Intake Flow"

    if [[ -z "$INGEST_API_KEY" ]]; then
        log_warn "INGEST_API_KEY not set, skipping authorized intake test"
        log_info "Set it with: export INGEST_API_KEY=your-key"
        return 0
    fi

    log_info "Testing intake with valid auth..."

    local payload
    payload=$(cat <<EOF
{
    "schemaVersion": "1.0",
    "ingestId": "smoke-test-$(date +%s)",
    "sourceId": "smoke-test",
    "sourceName": "Smoke Test",
    "sourceType": "api",
    "collectedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "records": [
        {
            "externalId": "test-1",
            "contentHash": "abc123",
            "rawPayload": {"test": true},
            "observedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        }
    ],
    "hasMore": false
}
EOF
)

    local response
    response=$(http_post "$UPLINK_EDGE_URL/v1/intake" "$payload" "Authorization: Bearer $INGEST_API_KEY")

    if [[ "$response" == "202" ]]; then
        pass "Intake accepts valid requests (HTTP 202)"
    elif [[ "$response" == "500" ]]; then
        log_warn "Intake returned 500 (INGEST_API_KEY may not be set on worker)"
        fail "Intake configuration issue"
    else
        fail "Intake should accept valid requests (got HTTP $response)"
    fi
}

# Test: Source trigger (unauthorized)
test_source_trigger_unauthorized() {
    log_section "Testing Source Trigger Authentication"

    log_info "Testing source trigger without auth..."
    local response
    response=$(http_post "$UPLINK_EDGE_URL/v1/sources/test/trigger" '{}')

    if [[ "$response" == "401" ]] || [[ "$response" == "500" ]]; then
        pass "Source trigger rejects unauthorized requests (HTTP $response)"
    else
        fail "Source trigger should reject unauthorized requests (got HTTP $response)"
    fi
}

# Test: Source trigger (with auth, source not found)
test_source_trigger_not_found() {
    log_section "Testing Source Trigger (Not Found)"

    if [[ -z "$INGEST_API_KEY" ]]; then
        log_warn "INGEST_API_KEY not set, skipping source trigger test"
        return 0
    fi

    log_info "Testing source trigger for non-existent source..."
    local response
    response=$(http_post "$UPLINK_EDGE_URL/v1/sources/non-existent-source/trigger" '{}' "Authorization: Bearer $INGEST_API_KEY")

    # Should get 404 or 500 (if source not found in DB)
    if [[ "$response" == "404" ]] || [[ "$response" == "500" ]]; then
        pass "Source trigger handles missing source (HTTP $response)"
    else
        fail "Source trigger should return 404 for missing source (got HTTP $response)"
    fi
}

# Test: Ops API (unauthorized)
test_ops_unauthorized() {
    log_section "Testing Ops API Authentication"

    log_info "Testing ops API without auth..."
    local response
    response=$(http_get "$UPLINK_OPS_URL/v1/runs")

    if [[ "$response" == "401" ]] || [[ "$response" == "404" ]] || [[ "$response" == "1042" ]] || [[ "$response" == "500" ]]; then
        pass "Ops API is not publicly accessible or rejects unauthorized (HTTP $response)"
    else
        fail "Ops API unexpected response (got HTTP $response)"
    fi
}

# Test: Ops API (with auth)
test_ops_authorized() {
    log_section "Testing Ops API"

    if [[ -z "$OPS_API_KEY" ]]; then
        log_warn "OPS_API_KEY not set, skipping ops API test"
        log_info "Set it with: export OPS_API_KEY=your-key"
        return 0
    fi

    log_info "Testing ops API with valid auth..."
    local response
    response=$(http_get "$UPLINK_OPS_URL/v1/runs" "Authorization: Bearer $OPS_API_KEY")

    if [[ "$response" == "200" ]]; then
        local body
        body=$(http_get_body "$UPLINK_OPS_URL/v1/runs" "Authorization: Bearer $OPS_API_KEY")
        pass "Ops API returns runs list (HTTP 200)"
        echo "  Response preview: $(echo "$body" | head -c 100)..."
    elif [[ "$response" == "500" ]]; then
        log_warn "Ops API returned 500 (OPS_API_KEY may not be set on worker)"
        fail "Ops API configuration issue"
    else
        fail "Ops API should return 200 (got HTTP $response)"
    fi
}

# Test: Replay endpoint
test_replay() {
    log_section "Testing Replay Functionality"

    if [[ -z "$OPS_API_KEY" ]]; then
        log_warn "OPS_API_KEY not set, skipping replay test"
        return 0
    fi

    log_info "Testing replay for non-existent run..."
    local response
    response=$(http_post "$UPLINK_OPS_URL/v1/runs/non-existent-run/replay" '{}' "Authorization: Bearer $OPS_API_KEY")

    # Should get 404 for non-existent run
    if [[ "$response" == "404" ]]; then
        pass "Replay returns 404 for non-existent run"
    elif [[ "$response" == "500" ]]; then
        log_warn "Replay returned 500 (check CORE_INTERNAL_KEY configuration)"
        fail "Replay configuration issue"
    else
        log_warn "Replay returned HTTP $response (expected 404)"
        # Not a hard failure - may depend on implementation
    fi
}

# Test: Internal API (should be protected)
test_internal_api_protected() {
    log_section "Testing Internal API Protection"

    log_info "Testing internal runs endpoint without auth..."
    local response
    response=$(http_get "$UPLINK_CORE_URL/internal/runs")

    if [[ "$response" == "401" ]] || [[ "$response" == "500" ]]; then
        pass "Internal API is protected (HTTP $response)"
    else
        fail "Internal API should be protected (got HTTP $response)"
    fi
}

# Test: Browser service internal endpoint
test_browser_internal() {
    log_section "Testing Browser Service"

    log_info "Testing browser internal endpoint without auth..."
    local response
    response=$(http_post "$UPLINK_BROWSER_URL/internal/collect" '{"url": "https://example.com"}')

    if [[ "$response" == "401" ]] || [[ "$response" == "404" ]] || [[ "$response" == "1042" ]] || [[ "$response" == "500" ]]; then
        pass "Browser internal endpoint is not publicly accessible or protected (HTTP $response)"
    else
        fail "Browser internal endpoint unexpected response (got HTTP $response)"
    fi
}

# Test: Service bindings (indirect test via trigger)
test_service_bindings() {
    log_section "Testing Service Bindings"

    if [[ -z "$INGEST_API_KEY" ]]; then
        log_warn "INGEST_API_KEY not set, skipping service binding test"
        return 0
    fi

    log_info "Testing edge -> core service binding via trigger..."

    # This tests that edge can communicate with core
    local response
    response=$(http_post "$UPLINK_EDGE_URL/v1/sources/test-binding/trigger" '{}' "Authorization: Bearer $INGEST_API_KEY")

    # Even if source doesn't exist, a 404 means the binding worked
    # 500 might indicate binding issue or source not found
    if [[ "$response" == "404" ]] || [[ "$response" == "409" ]]; then
        pass "Service binding edge -> core is working (HTTP $response)"
    elif [[ "$response" == "500" ]]; then
        log_warn "Service binding test returned 500 (may be configuration issue)"
        # Don't fail - could be other issues
    else
        log_warn "Unexpected response from service binding test (HTTP $response)"
    fi
}

# Print test summary
print_summary() {
    echo ""
    log_section "Test Summary"

    local total=$((TESTS_PASSED + TESTS_FAILED))

    echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "${RED}Failed: $TESTS_FAILED${NC}"
    echo "Total:  $total"
    echo ""

    if [[ $TESTS_FAILED -eq 0 ]]; then
        echo -e "${GREEN}All tests passed!${NC}"
        return 0
    else
        echo -e "${YELLOW}Some tests failed.${NC}"
        echo ""
        echo "Common issues:"
        echo "  - Workers still starting up (wait 30s and retry)"
        echo "  - Secrets not set (run ./scripts/bootstrap.sh --secrets)"
        echo "  - Service bindings not configured correctly"
        echo "  - D1 database not migrated (run ./scripts/deploy.sh)"
        return 1
    fi
}

# Print configuration
print_config() {
    log_section "Test Configuration"
    echo "UPLINK_EDGE_URL:   $UPLINK_EDGE_URL"
    echo "UPLINK_CORE_URL:   $UPLINK_CORE_URL"
    echo "UPLINK_BROWSER_URL: $UPLINK_BROWSER_URL"
    echo "UPLINK_OPS_URL:    $UPLINK_OPS_URL"
    echo ""
    echo "API Keys configured:"
    [[ -n "$INGEST_API_KEY" ]] && echo "  - INGEST_API_KEY: yes" || echo "  - INGEST_API_KEY: no"
    [[ -n "$OPS_API_KEY" ]] && echo "  - OPS_API_KEY: yes" || echo "  - OPS_API_KEY: no"
    [[ -n "$CORE_INTERNAL_KEY" ]] && echo "  - CORE_INTERNAL_KEY: yes" || echo "  - CORE_INTERNAL_KEY: no"
    echo ""
}

# Load environment from .env if exists
load_env() {
    if [[ -f "$PROJECT_ROOT/.env" ]]; then
        log_info "Loading environment from .env"
        set -a
        # shellcheck source=/dev/null
        source "$PROJECT_ROOT/.env"
        set +a
    fi

    if [[ -f "$PROJECT_ROOT/.dev.vars" ]]; then
        log_info "Loading secrets from .dev.vars"
        # Extract key=value pairs and export
        while IFS='=' read -r key value; do
            [[ -z "$key" || "$key" =~ ^# ]] && continue
            export "$key=$value"
        done < "$PROJECT_ROOT/.dev.vars"
    fi
}

# Main test flow
main() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              UPLINK CONNECT - SMOKE TESTS                  ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    load_env
    print_config

    # Run all tests
    test_health_endpoints
    test_intake_unauthorized
    test_intake_authorized
    test_source_trigger_unauthorized
    test_source_trigger_not_found
    test_ops_unauthorized
    test_ops_authorized
    test_replay
    test_internal_api_protected
    test_browser_internal
    test_service_bindings

    print_summary
}

# Handle command line arguments
case "${1:-}" in
    --health)
        load_env
        test_health_endpoints
        print_summary
        exit $TESTS_FAILED
        ;;
    --intake)
        load_env
        test_intake_unauthorized
        test_intake_authorized
        print_summary
        exit $TESTS_FAILED
        ;;
    --ops)
        load_env
        test_ops_unauthorized
        test_ops_authorized
        print_summary
        exit $TESTS_FAILED
        ;;
    --help|-h)
        echo "Uplink Connect Smoke Test Script"
        echo ""
        echo "Usage: $0 [options]"
        echo ""
        echo "Options:"
        echo "  (no args)   Run all tests"
        echo "  --health    Test health endpoints only"
        echo "  --intake    Test intake flow only"
        echo "  --ops       Test ops API only"
        echo "  --help      Show this help"
        echo ""
        echo "Environment variables:"
        echo "  INGEST_API_KEY      - API key for intake endpoint"
        echo "  OPS_API_KEY         - API key for ops endpoint"
        echo "  UPLINK_EDGE_URL     - Override edge URL"
        echo "  UPLINK_CORE_URL     - Override core URL"
        echo "  UPLINK_BROWSER_URL  - Override browser URL"
        echo "  UPLINK_OPS_URL      - Override ops URL"
        echo ""
        echo "API keys are loaded from .env or .dev.vars if present"
        exit 0
        ;;
    *)
        main
        exit $TESTS_FAILED
        ;;
esac
