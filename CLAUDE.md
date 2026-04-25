# Uplink Connect

## What This Is

Cloudflare-native data collection and ingestion platform (v0.1.2). SDK-native standards audit complete.

A production-ready, multi-tenant data ingestion system built entirely on Cloudflare's edge infrastructure. Handles everything from simple webhook intake to complex browser-based collection workflows, with durable execution guarantees and comprehensive observability.

## Stack

- **Tier 3** (CF Workers bare)
- TypeScript 5.9+ with strict mode
- pnpm 10.6+ workspaces
- Cloudflare Workers + Durable Objects + Workflows + Queues + D1 + R2 + Analytics Engine + Vectorize + Workers AI
- ULIDs via `ulidx` (Boring Stack convention — never `crypto.randomUUID()`)

### Service Architecture

```
uplink-edge      → Public intake API (webhooks, manual triggers, file uploads)
uplink-core      → Queue processing, DO coordination, workflows, 45+ endpoints
uplink-browser   → Browser-based collection
uplink-ops       → Protected operations API
```

### Data Architecture

| Tier | Product | Purpose |
|------|---------|---------|
| Coordination | Durable Objects | Per-source locks, cursors, rate limits, notifications, dashboard streams |
| Operational | D1 | Source configs, runs, entities, errors, settings, audit log |
| Immutable | R2 | Raw artifacts, exports |
| Metrics | Analytics Engine | High-cardinality telemetry |
| Search | Vectorize | Semantic entity search, error similarity |
| Async | Queues | At-least-once buffering |
| Orchestration | Workflows | Multi-step collection jobs |
| AI | Workers AI | Error diagnosis, embeddings |

## Current State

**Status: Production Ready (v0.1.2)**

### Completed Features

- ✅ Multi-source ingestion (API, webhook, email, file, browser, manual)
- ✅ Durable Object-based source coordination (leases, cursors, rate limits, backpressure)
- ✅ Workflow-driven collection with automatic retries
- ✅ Queue-based async processing with DLQ
- ✅ R2 raw artifact storage with structured key paths
- ✅ D1 operational data store (18 tables, 14 migrations)
- ✅ Entity normalization, deduplication, and relationship linking
- ✅ Vectorize semantic search
- ✅ Comprehensive metrics and alerting with Analytics Engine
- ✅ Visual HTML dashboard with WebSocket real-time updates
- ✅ Scheduler settings UI with per-source cron configuration
- ✅ Dynamic cron-based source triggering (no hard-coded schedules)
- ✅ RAG-based error analysis agent via WebSocket
- ✅ Data export API (JSON, CSV, NDJSON)
- ✅ Universal notification system (8 providers)
- ✅ Protected ops API for run management and replay
- ✅ Run replay capability
- ✅ Retention workflows
- ✅ Settings management with audit logging
- ✅ Source soft-delete and restore
- ✅ Webhook HMAC signature verification
- ✅ File upload endpoint with multipart/form-data
- ✅ AST-based code chunking for TS/JS ingestion
- ✅ 483+ tests passing (292 core unit + 121 contracts + 37 normalizers + 33 source-adapters)

### API Surface

- **uplink-edge**: 4 endpoints (public)
- **uplink-core**: 50+ endpoints (internal)
- **SDK-native audit**: ULIDs, streaming uploads, `AbortSignal.any()`, `timingSafeEqual` everywhere
- **uplink-ops**: 7 endpoints (protected)
- **uplink-browser**: 2 endpoints (internal)

## Project Structure

```
UplinkConnect/
├── apps/
│   ├── uplink-edge/          # Public intake API
│   │   ├── src/index.ts      # Hono app with /health, /v1/intake, /v1/sources/:id/trigger, /v1/files/:id
│   │   ├── wrangler.jsonc    # Worker config
│   │   └── package.json      # @uplink/edge
│   ├── uplink-core/          # Processing, DO, Workflows
│   │   ├── src/
│   │   │   ├── index.ts      # Main worker (fetch + queue + scheduled handlers)
│   │   │   ├── types.ts      # Env types, RuntimeSnapshot
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts           # Internal auth middleware
│   │   │   │   ├── coordinator-client.ts  # DO client methods
│   │   │   │   ├── db.ts             # D1 operations
│   │   │   │   ├── metrics.ts        # Analytics Engine writes
│   │   │   │   ├── alerting.ts       # Alert system
│   │   │   │   ├── health-monitor.ts # Component health checks
│   │   │   │   ├── settings.ts       # Platform settings
│   │   │   │   ├── scheduler.ts      # Source schedule CRUD and cron grouping
│   │   │   │   ├── tracing.ts        # Run tracing and lineage
│   │   │   │   ├── processing.ts     # Queue batch processing
│   │   │   │   ├── retry.ts          # Retry logic, circuit breakers
│   │   │   │   ├── vectorize.ts      # Vectorize operations
│   │   │   │   ├── notifications.ts  # Notification dispatch
│   │   │   │   └── pipelines.ts      # Pipeline emission (beta)
│   │   │   ├── durable/
│   │   │   │   ├── source-coordinator.ts    # DO for per-source coordination
│   │   │   │   ├── browser-manager.ts       # DO for browser sessions
│   │   │   │   ├── notification-dispatcher.ts # DO for rate-limited notifications
│   │   │   │   ├── dashboard-stream.ts      # DO for real-time dashboard
│   │   │   │   └── error-agent.ts           # DO for RAG error diagnosis
│   │   │   ├── routes/               # 15 route modules
│   │   │   └── test/                 # 292+ tests (unit, integration, e2e, live)
│   │   ├── migrations/       # 14 SQL migrations
│   │   ├── wrangler.jsonc    # Worker config with bindings
│   │   └── package.json      # @uplink/core
│   ├── uplink-browser/       # Browser collection
│   │   └── src/index.ts      # /health, /internal/collect
│   └── uplink-ops/           # Protected operations
│       └── src/index.ts      # Proxies to core with auth
├── packages/
│   ├── contracts/            # Shared schemas and types
│   │   └── src/index.ts      # Zod schemas, types, helpers
│   ├── source-adapters/      # Adapter implementations
│   │   └── src/index.ts      # API, webhook, browser adapters
│   └── normalizers/          # Entity normalization
│       └── src/index.ts      # Canonical entity mapping, code chunking
├── scripts/
│   ├── deploy.sh             # Full deployment automation
│   ├── bootstrap.sh          # Environment setup
│   ├── smoke-test.sh         # Post-deployment validation
│   └── setup-public-sources.sh  # Configure live public data sources
├── infra/
│   ├── README.md             # Infrastructure docs
│   └── wrangler.*.template.jsonc  # Config templates
├── AGENTS.md                 # Multi-agent context
├── API.md                    # Full API documentation
├── OPERATIONS.md             # Runbooks and procedures
├── RUNBOOK.md                # Daily operations runbook
├── ROADMAP.md                # Completed and planned work
├── CHANGELOG.md              # Release notes
├── METRICS_ALERTING.md       # Observability guide
├── AUDIT_REPORT.md           # Comprehensive audit results
├── PROJECT_STATUS.md         # Current project status
├── package.json              # Workspace root
├── pnpm-workspace.yaml       # pnpm workspace config
├── tsconfig.base.json        # Shared TypeScript config
└── .gitignore                # Git ignore rules
```

## Key Files

| File | Purpose |
|------|---------|
| `apps/uplink-core/src/index.ts` | Main core worker with queue + scheduled handlers |
| `apps/uplink-core/src/durable/source-coordinator.ts` | DO for per-source coordination |
| `apps/uplink-core/src/durable/dashboard-stream.ts` | WebSocket DO for live dashboard |
| `apps/uplink-core/src/durable/error-agent.ts` | RAG-based error diagnosis DO |
| `apps/uplink-core/src/workflows/collection-workflow.ts` | Durable collection workflow |
| `apps/uplink-core/src/lib/processing.ts` | Queue batch processing |
| `apps/uplink-core/src/lib/db.ts` | D1 database operations |
| `packages/contracts/src/index.ts` | All shared schemas and types |
| `packages/normalizers/src/index.ts` | Entity normalization + code chunking |
| `apps/uplink-core/migrations/*.sql` | Database schema |

## Database Schema (D1)

### Tables (18 total)

1. **source_configs** - Source registry
2. **source_policies** - Rate limits and retry config
3. **source_capabilities** - Feature flags per source
4. **source_runtime_snapshots** - DO state cache
5. **ingest_runs** - Run tracking
6. **raw_artifacts** - R2 reference tracking
7. **entities_current** - Canonical entity state
8. **entity_observations** - Historical observations
9. **entity_links** - Entity relationships
10. **ingest_errors** - Error tracking with retry state
11. **retry_idempotency_keys** - Idempotency tracking
12. **retention_audit_log** - Cleanup audit trail
13. **alerts_active** - Active alerts
14. **source_metrics_5min** - Aggregated metrics
15. **platform_settings** - Global configuration
16. **audit_log** - Operator action log

### Migrations

1. `0001_control_schema.sql` - Core tables
2. `0002_source_registry.sql` - Source config
3. `0003_entity_plane.sql` - Entity tables
4. `0004_retention_audit.sql` - Audit logging
5. `0005_alerting_metrics.sql` - Alerts and metrics
6. `0006_retry_tracking.sql` - Error retry state
7. `0007_settings_audit.sql` - Settings and audit log
8. `0008_add_missing_columns.sql` - Schema fixes
9. `0009_notification_deliveries.sql` - Notification tracking
10. `0010_source_schedules.sql` - Source schedules
11. `0011_error_dedup_hash.sql` - Error deduplication
12. `0012_error_occurrence_count.sql` - Error occurrence counting
13. `0013_performance_indexes.sql` - Dashboard query indexes
14. `0014_generated_columns.sql` - Generated columns for metadata

## Commands

```bash
# Install dependencies
pnpm install

# Type check all workspaces
pnpm typecheck

# Build all packages
pnpm build

# Run integration tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run live tests against production
cd apps/uplink-core
pnpm vitest run --config vitest.live.config.ts

# Development (run each in separate terminals)
pnpm dev:edge
pnpm dev:core
pnpm dev:browser
pnpm dev:ops

# Deployment
./scripts/deploy.sh
./scripts/bootstrap.sh --secrets
./scripts/smoke-test.sh
./scripts/setup-public-sources.sh
```

## Environment Variables

### uplink-edge (.dev.vars)
```
INGEST_API_KEY=dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

### uplink-core (.dev.vars)
```
CORE_INTERNAL_KEY=internal-dev-key
BROWSER_API_KEY=browser-dev-key
```

### uplink-ops (.dev.vars)
```
OPS_API_KEY=ops-dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

### uplink-browser (.dev.vars)
```
BROWSER_API_KEY=browser-dev-key
```

## Testing

- **Framework**: Vitest with @cloudflare/vitest-pool-workers
- **Test Files**: 33+ test files across all workspaces
- **Total Tests**: 483+ passing (292 core unit + 121 contracts + 37 normalizers + 33 source-adapters)
- **Coverage Areas**:
  - Core unit tests: lib modules, DOs, notifications, chunking, auth, alerting
  - Contracts tests: Zod schemas, utilities, sanitization, HTTP classification
  - Normalizers tests: Entity normalization, code chunking
  - Source-adapters tests: API, webhook, browser adapters

## Deployment

### Prerequisites

- Node.js 20+
- pnpm 10+
- Cloudflare account with Workers, D1, R2, Queues, Workflows, Vectorize, Analytics Engine enabled
- wrangler CLI authenticated

### Deployment Order

1. **uplink-core** (foundational, has DO and Workflows)
2. **uplink-browser** (internal dependency)
3. **uplink-edge** (public API)
4. **uplink-ops** (protected ops)

### Resources Created

- D1 database: `uplink-control`
- R2 bucket: `uplink-raw`
- Queues: `uplink-ingest`, `uplink-ingest-dlq`
- Vectorize index: `uplink-entities`
- Analytics Engine dataset: `uplink-ops`

## Security

- Bearer token auth for external endpoints
- Internal key auth for service-to-service
- No secrets in code (use .dev.vars locally, wrangler secrets in prod)
- Per-source isolation in D1 and R2
- DO routing by sourceId for serialized access
- Webhook HMAC signature verification

## Observability

### Metrics (Analytics Engine)

- ingest.success/failure/latency/normalization_rate/error_rate
- queue.lag_seconds/pending_count/processing_count
- entity.created/observed
- coordinator.lease_acquired/released/expired/cursor_advanced

### Alerts

- source_failure_rate - High error rate per source
- queue_lag - Messages backing up
- run_stuck - Runs stuck in progress
- lease_expired - Lease not released properly

### Logging

- Structured JSON throughout
- Contextual fields: runId, sourceId, requestId
- Error classification and categorization

## Rules

- Keep source-specific coordination state in DOs, not KV
- All ingest writes must be idempotent via deterministic ingest_id
- Use D1 for operational truth, R2 for immutable artifacts
- Integer cents for money values if introduced later
- No secrets in code or committed config
- Tab indent, 100 char width
- Strict TypeScript, no implicit any

## License

MIT - BoringWorks
