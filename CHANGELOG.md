# Changelog

All notable changes to Uplink Connect will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-04-14

### Added

#### Real-time & AI
- **DashboardStreamDO** - WebSocket Durable Object for live dashboard metrics streaming
  - Hibernation-enabled for efficiency
  - Broadcasts metrics every 5 seconds to subscribed clients
  - Endpoint: `GET /internal/stream/dashboard`
  
- **ErrorAgentDO** - RAG-based error diagnosis via WebSocket
  - Embeds error descriptions using `@cf/baai/bge-small-en-v1.5`
  - Searches Vectorize `errors` namespace for similar past errors
  - Streams AI diagnosis via `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  - Endpoint: `GET /internal/agent/error`

#### Data Export
- **Export API** - Export runs, entities, and errors in multiple formats
  - `GET /internal/export/runs` - Filter by source, date, status
  - `GET /internal/export/entities` - Filter by source, entity type
  - `GET /internal/export/errors` - Filter by source
  - Supports `json` (default), `csv`, and `ndjson` formats
  - Limit up to 50,000 records per export

#### Code Intelligence
- **AST-based Chunking** - Added `chunkCode()` to `@uplink/normalizers`
  - Intelligently chunks TS/JS files by constructs: function, class, interface, type, import, export, comment
  - Falls back to line-based chunking for non-code files
  - Configurable `maxChunkSize` and `minChunkSize`

#### Dashboard Enhancements
- Updated `/dashboard` HTML with WebSocket client for real-time metric updates
- Auto-reconnect on connection loss
- Live updates for sources count, runs, queue depth, and alerts

#### Infrastructure
- Added v4 Durable Object migration for `DashboardStreamDO` and `ErrorAgentDO`
- Updated wrangler.jsonc with new DO bindings

#### Testing
- Added 35+ new tests across all suites
- Total test count: 554+ (up from 519)

---

## [0.1.0] - 2026-04-12

### Added

#### Core Platform
- **uplink-edge** - Public intake API with authenticated endpoints
  - `/health` health check endpoint
  - `/v1/intake` ingest envelope submission with queue handoff
  - `/v1/sources/:sourceId/trigger` manual source triggering
  - `/v1/webhooks/:sourceId` webhook receiver with HMAC verification
  - `/v1/files/:sourceId` multipart file upload
   
- **uplink-core** - Internal processing service
  - Queue consumer with idempotent processing
  - D1 operational data store integration
  - R2 raw artifact persistence
  - Entity normalization pipeline
  - Vectorize indexing for semantic search
  - 45+ internal endpoints
  
- **uplink-browser** - Browser collection service
  - `/health` health check
  - `/internal/collect` URL fetching with auth
  
- **uplink-ops** - Protected operations API
  - Run management endpoints (list, get, replay)
  - Source health monitoring
  - Artifact metadata lookup
  - Proxied core operations

#### Durable Objects
- **SourceCoordinator** - Per-source state management
  - Lease acquisition and release
  - Cursor progression tracking
  - Rate limiting enforcement
  - Failure counting and auto-pause
  - Runtime state snapshots
  - Backpressure support

- **BrowserManagerDO** - Browser session management
  - Session allocation and cleanup
  - Concurrent collection handling

- **NotificationDispatcher** - Rate-limited notification delivery
  - 8 provider support (webhook, slack, discord, teams, pagerduty, opsgenie, email, custom)
  - Retry logic with throttling

#### Workflows
- **CollectionWorkflow** - Durable collection orchestration
  - Automatic retry on failure
  - Lease integration
  - Status synchronization to D1
  
- **RetentionWorkflow** - Cleanup automation
  - Configurable retention periods
  - Batch processing
  - Dry-run support

#### Data Model
- **D1 Migrations (9 total)**
  - `source_configs` - Source registry
  - `source_policies` - Rate limits and retry policy
  - `source_capabilities` - Feature flags
  - `source_runtime_snapshots` - DO state cache
  - `ingest_runs` - Run tracking
  - `raw_artifacts` - R2 reference tracking
  - `entities_current` - Canonical entity state
  - `entity_observations` - Historical observations
  - `entity_links` - Relationship tracking
  - `ingest_errors` - Error tracking with retry state
  - `retry_idempotency_keys` - Idempotency tracking
  - `retention_audit_log` - Cleanup audit trail
  - `alerts_active` - Alert management
  - `source_metrics_5min` - Time-series metrics
  - `platform_settings` - Global configuration
  - `audit_log` - Operator action log

#### Packages
- **@uplink/contracts** - Shared schemas and types
  - Zod schemas for all data structures
  - TypeScript type exports
  - Helper functions (toIsoNow, createIngestQueueMessage, etc.)
  - Analytics event schemas
  - Error recovery schemas
  
- **@uplink/source-adapters** - Adapter framework
  - Interface definitions for source types
  - API adapter foundation
  - Webhook adapter foundation
  - Browser adapter foundation
  
- **@uplink/normalizers** - Entity normalization
  - Canonical entity mapping
  - Content hash generation
  - Deduplication logic
  - Code chunking (added in v0.1.1)

#### Observability
- **Metrics System**
  - System-wide metrics endpoint
  - Per-source metrics with time windows
  - Queue depth tracking
  - Entity count metrics
  - Analytics Engine integration
  - Synthetic monitoring cron (every 5 minutes)
  
- **Alerting System**
  - Configurable alert rules
  - Multiple severity levels (warning, critical)
  - Alert types: source_failure_rate, queue_lag, run_stuck, lease_expired
  - Acknowledgment and resolution workflow
  - Auto-resolution for cleared conditions
  
- **Error Tracking**
  - Structured error logging
  - Retry state machine (pending -> retrying -> resolved/dead_letter)
  - Error categorization (network, timeout, rate_limit, auth, etc.)
  - Bulk retry capability
  - DLQ integration

- **Dashboard**
  - Self-hosted HTML dashboard at `/dashboard`
  - Pipeline topology visualization
  - Component health monitoring
  - Data flow metrics
  - Source health timeline
  - Run tracing
  - Entity lineage
  - Real-time WebSocket updates (added in v0.1.1)

#### API Endpoints
- 55+ endpoints across all services
- Consistent authentication patterns
- Structured error responses
- Pagination support
- Filtering and search

#### Documentation
- Comprehensive README with architecture diagram
- Complete API reference (API.md)
- Operations guide with runbooks (OPERATIONS.md)
- Daily runbook (RUNBOOK.md)
- Updated roadmap with completed items (ROADMAP.md)
- This changelog
- Project status report (PROJECT_STATUS.md)
- Agent instructions (AGENTS.md)
- Audit report (AUDIT_REPORT.md)
- Metrics and alerting guide (METRICS_ALERTING.md)
- OpenAPI 3.0 specification (openapi.yml)

#### DevOps
- GitHub Actions CI/CD workflow
- Automated testing on PRs and pushes
- Deployment scripts (deploy.sh, bootstrap.sh, smoke-test.sh)

### Security
- Bearer token authentication for external endpoints
- Internal key authentication for service-to-service
- No secrets in code or committed configuration
- Secret reference pattern for source credentials
- Webhook HMAC signature verification

### Performance
- Queue-based async processing decouples intake from processing
- Durable Objects serialize per-source operations
- Idempotent processing prevents duplicate work
- Batch processing for queue consumers
- Indexed D1 queries

### Developer Experience
- pnpm workspace monorepo
- TypeScript throughout
- Shared contract packages prevent shape drift
- wrangler dev support for local development
- Integration test scaffolding
- Live test suite against production

### Infrastructure
- Cloudflare Workers for compute
- D1 for operational data
- R2 for immutable artifacts
- Queues for async buffering
- Durable Objects for coordination
- Workflows for durable execution
- Analytics Engine for metrics
- Vectorize for semantic search
- Workers AI for error diagnosis

## Migration Notes

### v0.1.0 to v0.1.1

No database schema changes required for v0.1.1. The new Durable Objects (`DashboardStreamDO`, `ErrorAgentDO`) use SQLite storage within the DO itself.

To deploy v0.1.1:
```bash
cd apps/uplink-core
wrangler deploy
```

### Initial Setup (v0.1.0)

Apply migrations in order:
```bash
cd apps/uplink-core
wrangler d1 migrations apply uplink-control --local
wrangler d1 migrations apply uplink-control --remote
```

### Environment Setup

Required secrets:
```bash
# uplink-edge
wrangler secret put INGEST_API_KEY
wrangler secret put CORE_INTERNAL_KEY

# uplink-core
wrangler secret put CORE_INTERNAL_KEY
wrangler secret put BROWSER_API_KEY

# uplink-ops
wrangler secret put OPS_API_KEY
wrangler secret put CORE_INTERNAL_KEY

# uplink-browser
wrangler secret put BROWSER_API_KEY
```

## Known Limitations

- Pipelines integration commented out (beta feature)
- Browser Rendering binding configured but basic fetch used
- Source adapters are foundation only - specific implementations needed
- Dashboard is HTML-based, not a full SPA
- Single D1 database (sharding strategy documented for future)

## Contributors

- BoringWorks Platform Team

## References

- Architecture based on [Uplink Connect v3.01 Plan](../uplink-connect-v3.01-plan.md)
- Cloudflare Workers best practices
- Durable Objects patterns from PeopleResearch projects

---

[0.1.1]: https://github.com/boringworks/uplink-connect/releases/tag/v0.1.1
[0.1.0]: https://github.com/boringworks/uplink-connect/releases/tag/v0.1.0
