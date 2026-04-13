# Uplink Connect

## What This Is

Cloudflare-native data collection and ingestion platform (v0.1.0).

A production-ready, multi-tenant data ingestion system built entirely on Cloudflare's edge infrastructure. Handles everything from simple webhook intake to complex browser-based collection workflows, with durable execution guarantees and comprehensive observability.

## Stack

- **Tier 3** (CF Workers bare)
- TypeScript 5.8+ with strict mode
- pnpm 10.6+ workspaces
- Cloudflare Workers + Durable Objects + Workflows + Queues + D1 + R2 + Analytics Engine + Vectorize

### Service Architecture

```
uplink-edge      → Public intake API (webhooks, manual triggers)
uplink-core      → Queue processing, DO coordination, workflows
uplink-browser   → Browser-based collection
uplink-ops       → Protected operations API
```

### Data Architecture

| Tier | Product | Purpose |
|------|---------|---------|
| Coordination | Durable Objects | Per-source locks, cursors, rate limits |
| Operational | D1 | Source configs, runs, entities, errors |
| Immutable | R2 | Raw artifacts, exports |
| Metrics | Analytics Engine | High-cardinality telemetry |
| Search | Vectorize | Semantic entity search |
| Async | Queues | At-least-once buffering |
| Orchestration | Workflows | Multi-step collection jobs |

## Current State

**Status: Production Ready (v0.1.0)**

### Completed Features

- ✅ Multi-source ingestion (API, webhook, email, file, browser, manual)
- ✅ Durable Object-based source coordination (leases, cursors, rate limits)
- ✅ Workflow-driven collection with automatic retries
- ✅ Queue-based async processing with DLQ
- ✅ R2 raw artifact storage with structured key paths
- ✅ D1 operational data store (12 tables, 6 migrations)
- ✅ Entity normalization and deduplication
- ✅ Vectorize semantic search
- ✅ Comprehensive metrics and alerting
- ✅ Protected ops API for run management
- ✅ Run replay capability
- ✅ Retention workflows
- ✅ 35 integration tests passing

### API Surface

- **uplink-edge**: 3 endpoints (public)
- **uplink-core**: 25 endpoints (internal)
- **uplink-ops**: 7 endpoints (protected)
- **uplink-browser**: 2 endpoints (internal)

## Project Structure

```
UplinkConnect/
├── apps/
│   ├── uplink-edge/          # Public intake API
│   │   ├── src/index.ts      # Hono app with /health, /v1/intake, /v1/sources/:id/trigger
│   │   ├── wrangler.jsonc    # Worker config
│   │   └── package.json      # @uplink/edge
│   ├── uplink-core/          # Processing, DO, Workflows
│   │   ├── src/
│   │   │   ├── index.ts      # Main worker (fetch + queue handlers)
│   │   │   ├── types.ts      # Env types, RuntimeSnapshot
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts           # Internal auth middleware
│   │   │   │   ├── coordinator-client.ts  # DO client methods
│   │   │   │   ├── db.ts             # D1 operations
│   │   │   │   ├── metrics.ts        # Analytics Engine writes
│   │   │   │   ├── alerting.ts       # Alert system
│   │   │   │   ├── processing.ts     # Queue batch processing
│   │   │   │   ├── retry.ts          # Retry logic, circuit breakers
│   │   │   │   ├── vectorize.ts      # Vectorize operations
│   │   │   │   └── pipelines.ts      # Pipeline emission (beta)
│   │   │   ├── durable/
│   │   │   │   └── source-coordinator.ts  # DO implementation
│   │   │   ├── workflows/
│   │   │   │   ├── collection-workflow.ts # Main collection workflow
│   │   │   │   └── retention-workflow.ts  # Cleanup workflow
│   │   │   └── test/integration/     # 35 integration tests
│   │   ├── migrations/       # 6 SQL migrations
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
│       └── src/index.ts      # Canonical entity mapping
├── scripts/
│   ├── deploy.sh             # Full deployment automation
│   ├── bootstrap.sh          # Environment setup
│   └── smoke-test.sh         # Post-deployment validation
├── infra/
│   ├── README.md             # Infrastructure docs
│   └── wrangler.*.template.jsonc  # Config templates
├── docs/
│   ├── README.md             # This file
│   ├── API.md                # Full API documentation
│   ├── OPERATIONS.md         # Runbooks and procedures
│   ├── ROADMAP.md            # Completed and planned work
│   ├── CHANGELOG.md          # Release notes
│   ├── METRICS_ALERTING.md   # Observability guide
│   └── AUDIT_REPORT.md       # Comprehensive audit
├── package.json              # Workspace root
├── pnpm-workspace.yaml       # pnpm workspace config
├── tsconfig.base.json        # Shared TypeScript config
└── .gitignore                # Git ignore rules
```

## Key Files

| File | Purpose |
|------|---------|
| `apps/uplink-core/src/index.ts` | Main core worker with 25 endpoints |
| `apps/uplink-core/src/durable/source-coordinator.ts` | DO for per-source coordination |
| `apps/uplink-core/src/workflows/collection-workflow.ts` | Durable collection workflow |
| `apps/uplink-core/src/lib/processing.ts` | Queue batch processing |
| `apps/uplink-core/src/lib/db.ts` | D1 database operations |
| `packages/contracts/src/index.ts` | All shared schemas and types |
| `apps/uplink-core/migrations/*.sql` | Database schema |

## Database Schema (D1)

### Tables (12 total)

1. **source_configs** - Source registry
2. **source_policies** - Rate limits and retry config
3. **source_capabilities** - Feature flags per source
4. **ingest_runs** - Run tracking
5. **raw_artifacts** - R2 reference tracking
6. **entities_current** - Canonical entity state
7. **entity_observations** - Historical observations
8. **entity_links** - Entity relationships
9. **ingest_errors** - Error tracking with retry state
10. **retry_idempotency_keys** - Idempotency tracking
11. **retention_audit_log** - Cleanup audit trail
12. **alerts_active** - Active alerts
13. **source_metrics_5min** - Aggregated metrics

### Migrations

1. `0001_control_schema.sql` - Core tables
2. `0002_source_registry.sql` - Source config
3. `0003_entity_plane.sql` - Entity tables
4. `0004_retention_audit.sql` - Audit logging
5. `0005_alerting_metrics.sql` - Alerts and metrics
6. `0006_retry_tracking.sql` - Error retry state

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

# Development (run each in separate terminals)
pnpm dev:edge
pnpm dev:core
pnpm dev:browser
pnpm dev:ops

# Deployment
./scripts/deploy.sh
./scripts/bootstrap.sh --secrets
./scripts/smoke-test.sh
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
- **Test Files**: 5 integration test files
- **Total Tests**: 35 passing
- **Coverage Areas**:
  - Source coordinator (lease, cursor, failure tracking)
  - Workflow execution (trigger, force, concurrent rejection)
  - Ingest pipeline (full flow, idempotency, errors)
  - Replay/upsert (guards, conflict resolution)
  - Retry recovery (message reconstruction)

## Deployment

### Prerequisites

- Node.js 20+
- pnpm 10+
- Cloudflare account with Workers, D1, R2, Queues, Workflows enabled
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

## Next Milestones

### Immediate (Post-v0.1.0)

1. Deploy to production
2. Configure first production sources
3. Set up monitoring dashboards
4. Train operations team

### Short-term

1. Add pagination to list endpoints
2. Implement source soft-delete
3. Add webhook signature verification
4. Create source-specific runbooks

### Medium-term

1. Enable Pipelines integration (when beta acceptable)
2. Add advanced browser collection (CDP)
3. Implement entity relationship API
4. Add multi-region support

## Credits

Built with Cloudflare Workers, Durable Objects, Workflows, D1, R2, Queues, Analytics Engine, and Vectorize.

Architecture inspired by PeopleResearch property search workflows, HolstonResearch ingest patterns, and BoringBots platform decomposition.

## License

MIT - BoringWorks
