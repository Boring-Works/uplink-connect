# Uplink Connect v3.01

Cloudflare-native data ingestion and collection platform. Built for reliability, observability, and scale.

[![Tests](https://img.shields.io/badge/tests-652%2B%20passing-success)](./apps/uplink-core/src/test)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Live Dashboard:** https://uplink-core.codyboring.workers.dev/dashboard

## Overview

Uplink Connect is a multi-tenant data ingestion platform built entirely on Cloudflare's edge infrastructure. It handles everything from simple webhook intake to complex browser-based collection workflows, all with durable execution guarantees and comprehensive observability.

### Key Features

- **Multi-source ingestion**: API, webhook, email, file, browser, and manual triggers
- **Durable execution**: Workflows with automatic retries, leases, and cursor management
- **Idempotent processing**: Deterministic ingest IDs prevent duplicate data
- **Real-time observability**: Analytics Engine metrics, health checks, and alerting
- **Visual dashboard**: Self-hosted HTML dashboard with live pipeline flow, component health, and WebSocket real-time updates
- **RAG error agent**: AI-powered error diagnosis using Vectorize and Workers AI
- **Data export**: Export runs, entities, and errors in JSON, CSV, or NDJSON
- **Entity resolution**: Automatic deduplication and relationship linking
- **Data lineage**: Full traceability from raw ingest to normalized entity
- **Protected operations**: Secure ops API for run management and replay
- **Universal notifications**: 8 providers including Slack, Discord, PagerDuty, Teams
- **Code intelligence**: AST-based chunking for TS/JS file ingestion
- **Live public data source**: USGS earthquakes hourly collection actively running

## Architecture

```
                              Uplink Connect v3.01

             +---------------------------------------------------+
             |                  Public Edge Plane                |
             |  uplink-edge (Worker)                              |
             |  - /health                                         |
             |  - /v1/intake (authenticated)                     |
             |  - /v1/sources/:id/trigger                        |
             |  - /v1/webhooks/:id                               |
             |  - /v1/files/:id (multipart upload)               |
             +---------------------------+-----------------------+
                                         |
                                         v
             +---------------------------------------------------+
             |                Coordination Plane                  |
             |  SourceCoordinator (Durable Object)                |
             |  - Per-source lease management                     |
             |  - Cursor progression                              |
             |  - Rate limiting                                   |
             |  - Failure tracking                                |
             |  DashboardStreamDO (WebSocket)                     |
             |  - Real-time metrics streaming                     |
             |  ErrorAgentDO (WebSocket + AI)                     |
             |  - RAG-based error diagnosis                       |
             +---------------------------+-----------------------+
                                         |
                     +-------------------+-------------------+
                     |                                       |
                     v                                       v
     +-----------------------------------+    +----------------------------------+
     |           Async Work Plane        |    |       Durable Job Plane          |
     |  Queues                           |    |  Workflows                        |
     |  - at-least-once buffering        |    |  - CollectionWorkflow            |
     |  - fan-out to processors          |    |  - RetentionWorkflow             |
     +-------------------+---------------+    +------------------+---------------+
                         |                                       |
                         +-------------------+-------------------+
                                             |
                                             v
             +---------------------------------------------------+
             |                 Processing Plane                   |
             |  uplink-core (Worker)                              |
             |  - Queue consumption                               |
             |  - R2 artifact persistence                         |
             |  - D1 operational writes                           |
             |  - Entity normalization                            |
             |  - Vectorize indexing                              |
             |  - Analytics Engine metrics                        |
             |  - Alert evaluation                                |
             |  - Settings management                             |
             +---------------------------+-----------------------+
                                         |
           +-----------------------------+------------------------------+
           |                             |                              |
           v                             v                              v
 +------------------+         +------------------------+      +------------------+
 | Operational Data |         | Immutable Data Lake    |      | Metrics / Search |
 | D1               |         | R2                     |      | Analytics Engine |
 | - sources        |         | - raw artifacts        |      | Vectorize        |
 | - runs           |         | - exports              |      | Workers AI       |
 | - entities       |         |                        |      |                  |
 +------------------+         +------------------------+      +------------------+
```

### Service Topology

| Service | Type | Purpose |
|---------|------|---------|
| `uplink-edge` | Public Worker | External intake API, webhook receiver, manual triggers, file uploads |
| `uplink-core` | Internal Worker | Queue processing, D1/R2 writes, entity normalization, workflows, 45+ endpoints |
| `uplink-browser` | Internal Worker | Browser-based collection (fetch-based, Browser Rendering ready) |
| `uplink-ops` | Protected Worker | Operator API for runs, replay, health checks, alerts |

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+
- Cloudflare account with Workers, D1, R2, Queues, Workflows, Vectorize, Analytics Engine enabled

### Installation

```bash
# Clone and install
pnpm install

# Typecheck all workspaces
pnpm typecheck

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Local Development

```bash
# Terminal 1: Start edge service
pnpm dev:edge

# Terminal 2: Start core service
pnpm dev:core

# Terminal 3: Start browser service
pnpm dev:browser

# Terminal 4: Start ops service
pnpm dev:ops
```

### Live Public Data Sources

Five real public data sources are actively collecting to prove the platform handles diverse APIs:

```bash
# Set up all public sources
./scripts/setup-public-sources.sh
```

| Source | API | What It Proves |
|--------|-----|----------------|
| **USGS Earthquakes** | `earthquake.usgs.gov` | GeoJSON ingestion, continuous monitoring |
| **GitHub Public Events** | `api.github.com/events` | High-frequency collection, auth headers |
| **Hacker News Top Stories** | `firebaseio.com` | Array-based IDs, large nested payloads |
| **Exchange Rates** | `exchangerate-api.com` | Financial data, nested JSON objects |
| **NWS Tennessee Weather** | `api.weather.gov` | Multi-step traversal, geospatial alerts |

All sources have verified end-to-end flow: entities in D1, artifacts in R2, metrics in Analytics Engine. Trigger manually via the API or dashboard, or schedule via `/scheduler`.

### Environment Setup

Create `.dev.vars` files in each app directory:

**apps/uplink-edge/.dev.vars:**
```
INGEST_API_KEY=dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

**apps/uplink-core/.dev.vars:**
```
CORE_INTERNAL_KEY=internal-dev-key
BROWSER_API_KEY=browser-dev-key
```

**apps/uplink-ops/.dev.vars:**
```
OPS_API_KEY=ops-dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

**apps/uplink-browser/.dev.vars:**
```
BROWSER_API_KEY=browser-dev-key
```

### Database Setup

```bash
# Create D1 database
wrangler d1 create uplink-control

# Apply migrations
cd apps/uplink-core
wrangler d1 migrations apply uplink-control --local
wrangler d1 migrations apply uplink-control --remote
```

### First Ingest Test

```bash
# Health check
curl http://localhost:8787/health

# Submit test ingest
curl -X POST http://localhost:8787/v1/intake \
  -H "Authorization: Bearer dev-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": "1.0",
    "ingestId": "test-001",
    "sourceId": "test-source",
    "sourceName": "Test Source",
    "sourceType": "api",
    "collectedAt": "2026-04-12T00:00:00Z",
    "records": [
      {
        "externalId": "record-1",
        "contentHash": "abc123",
        "rawPayload": {"name": "Test Entity"},
        "observedAt": "2026-04-12T00:00:00Z"
      }
    ]
  }'
```

## API Reference

### Edge Endpoints (uplink-edge)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Service health check |
| POST | `/v1/intake` | Bearer | Submit ingest envelope |
| POST | `/v1/sources/:sourceId/trigger` | Bearer | Trigger source collection |
| POST | `/v1/webhooks/:sourceId` | None* | Webhook receiver |
| POST | `/v1/files/:sourceId` | Bearer | Multipart file upload |

*Webhooks use HMAC signature verification

### Core Internal Endpoints (uplink-core)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Service health check |
| GET | `/dashboard` | None | Visual HTML dashboard |
| GET | `/internal/dashboard/v2` | Internal | Dashboard API v2 |
| GET | `/internal/runs` | Internal | List ingest runs |
| GET | `/internal/runs/:runId` | Internal | Get run details |
| POST | `/internal/runs/:runId/replay` | Internal | Replay failed run |
| GET | `/internal/runs/:runId/trace` | Internal | Run trace with lineage |
| GET | `/internal/artifacts/:artifactId` | Internal | Get artifact metadata |
| GET | `/internal/sources` | Internal | List source configs |
| POST | `/internal/sources` | Internal | Create/update source |
| POST | `/internal/sources/:sourceId/trigger` | Internal | Trigger with lease |
| GET | `/internal/sources/:sourceId/health` | Internal | Source health snapshot |
| GET | `/internal/sources/:sourceId/health/timeline` | Internal | Health timeline |
| GET | `/internal/sources/:sourceId/runs/tree` | Internal | Run tree view |
| POST | `/internal/search/entities` | Internal | Vector similarity search |
| GET | `/internal/entities/:entityId/lineage` | Internal | Entity lineage |
| GET | `/internal/alerts` | Internal | List active alerts |
| POST | `/internal/alerts/check` | Internal | Run alert checks |
| POST | `/internal/alerts/:id/acknowledge` | Internal | Acknowledge alert |
| POST | `/internal/alerts/:id/resolve` | Internal | Resolve alert |
| GET | `/internal/metrics/system` | Internal | System-wide metrics |
| GET | `/internal/metrics/sources` | Internal | Per-source metrics |
| GET | `/internal/metrics/sources/:id` | Internal | Specific source metrics |
| GET | `/internal/metrics/queue` | Internal | Queue depth metrics |
| GET | `/internal/metrics/entities` | Internal | Entity count metrics |
| GET | `/internal/errors` | Internal | List ingest errors |
| POST | `/internal/errors/:id/retry` | Internal | Retry failed operation |
| GET | `/internal/health/components` | Internal | Component health |
| GET | `/internal/health/topology` | Internal | Pipeline topology |
| GET | `/internal/health/flow` | Internal | Data flow metrics |
| GET | `/internal/settings` | Internal | Platform settings |
| PUT | `/internal/settings` | Internal | Update settings |
| GET | `/internal/audit-log` | Internal | Audit trail |
| GET | `/internal/export/runs` | Internal | Export runs |
| GET | `/internal/export/entities` | Internal | Export entities |
| GET | `/internal/export/errors` | Internal | Export errors |
| GET | `/internal/stream/dashboard` | Internal | WebSocket dashboard stream |
| GET | `/internal/agent/error` | Internal | WebSocket error agent |

### Ops Endpoints (uplink-ops)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Service health check |
| GET | `/v1/runs` | Bearer | List runs (proxied) |
| GET | `/v1/runs/:runId` | Bearer | Get run (proxied) |
| POST | `/v1/runs/:runId/replay` | Bearer | Replay run (proxied) |
| POST | `/v1/sources/:id/trigger` | Bearer | Trigger source (proxied) |
| GET | `/v1/sources/:id/health` | Bearer | Source health (proxied) |
| GET | `/v1/artifacts/:id` | Bearer | Get artifact (proxied) |

### Browser Endpoints (uplink-browser)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Service health check |
| POST | `/internal/collect` | Bearer | Collect from URL |

## Testing

Uplink Connect includes comprehensive integration tests running inside the Cloudflare Workers runtime:

```bash
# Run all tests
pnpm test

# Run in watch mode
pnpm test:watch

# Run live tests against production
cd apps/uplink-core
pnpm vitest run --config vitest.live.config.ts
```

### Test Coverage

**652+ tests** across unit, integration, e2e, live, worker, and package test suites.

| Category | Count | Coverage Area |
|----------|-------|---------------|
| **Unit tests** | 274 | lib modules, DOs, notifications, chunking |
| **Integration tests** | 35 | Source coordinator, workflows, ingest pipeline, retry recovery, replay/upsert |
| **E2E tests** | 6 | Health, dashboard, source registration, ingest/query, replay, browser status |
| **Worker tests** | 106 | edge (42), ops (32), browser (32) |
| **Package tests** | 115 | contracts (49), normalizers (37), source-adapters (29) |
| **Live tests** | 18 | Production endpoint validation |

#### Integration Test Files
| Test File | Tests | Coverage Area |
|-----------|-------|---------------|
| `source-coordinator.test.ts` | 14 | Lease management, cursor advancement, failure tracking |
| `workflow.test.ts` | 7 | Trigger flow, concurrent rejection, force trigger |
| `ingest.test.ts` | 6 | Full pipeline, idempotency, error handling |
| `replay-upsert.test.ts` | 5 | Replay guards, conflict upsert behavior |
| `retry-recovery.test.ts` | 3 | Message reconstruction, fallback envelopes |

## Environment Variables

### uplink-edge

| Variable | Required | Description |
|----------|----------|-------------|
| `INGEST_API_KEY` | Yes | API key for external requests |
| `CORE_INTERNAL_KEY` | Yes | Internal auth key for core service |

### uplink-core

| Variable | Required | Description |
|----------|----------|-------------|
| `CORE_INTERNAL_KEY` | Yes | Internal auth key validation |
| `BROWSER_API_KEY` | Yes | Auth key for browser service |
| `CONTROL_DB` | Auto | D1 database binding |
| `RAW_BUCKET` | Auto | R2 bucket binding |
| `ENTITY_INDEX` | Auto | Vectorize index binding |
| `OPS_METRICS` | Auto | Analytics Engine binding |
| `INGEST_QUEUE` | Auto | Queue producer binding |
| `DLQ` | Auto | Dead letter queue binding |
| `SOURCE_COORDINATOR` | Auto | Durable Object namespace |
| `BROWSER_MANAGER` | Auto | Durable Object namespace |
| `NOTIFICATION_DISPATCHER` | Auto | Durable Object namespace |
| `DASHBOARD_STREAM` | Auto | Durable Object namespace |
| `ERROR_AGENT` | Auto | Durable Object namespace |
| `COLLECTION_WORKFLOW` | Auto | Workflow binding |
| `RETENTION_WORKFLOW` | Auto | Workflow binding |
| `UPLINK_BROWSER` | Auto | Service binding to browser |

### uplink-ops

| Variable | Required | Description |
|----------|----------|-------------|
| `OPS_API_KEY` | Yes | API key for ops endpoints |
| `CORE_INTERNAL_KEY` | Yes | Internal auth for core proxy |
| `UPLINK_CORE` | Auto | Service binding to core |

### uplink-browser

| Variable | Required | Description |
|----------|----------|-------------|
| `BROWSER_API_KEY` | Yes | API key for internal requests |
| `BROWSER` | Auto | Browser Rendering binding |

## Deployment

### Pre-deployment

- [x] All type checks pass (`pnpm typecheck`)
- [x] All tests pass (`pnpm test`)
- [ ] Environment variables configured in Cloudflare dashboard
- [ ] D1 database created and migrations applied
- [ ] R2 buckets created (`uplink-raw`)
- [ ] Queues created (`uplink-ingest`, `uplink-ingest-dlq`)
- [ ] Vectorize index created (`uplink-entities`)
- [ ] Analytics Engine dataset created (`uplink-ops`)

### Deployment Order

1. **uplink-core** (foundational service with DO and Workflows)
   ```bash
   cd apps/uplink-core
   wrangler deploy
   ```

2. **uplink-browser** (internal dependency)
   ```bash
   cd apps/uplink-browser
   wrangler deploy
   ```

3. **uplink-edge** (public API)
   ```bash
   cd apps/uplink-edge
   wrangler deploy
   ```

4. **uplink-ops** (protected ops)
   ```bash
   cd apps/uplink-ops
   wrangler deploy
   ```

### Post-deployment

- [ ] Verify `/health` on all services
- [ ] Test ingest flow end-to-end
- [ ] Verify D1 tables populated
- [ ] Check R2 objects created
- [ ] Confirm queue consumption working
- [ ] Set up logpush or tail workers if needed

## Data Model

### Core Tables (D1)

| Table | Purpose |
|-------|---------|
| `source_configs` | Source registry and configuration |
| `source_policies` | Rate limits and retry policies |
| `source_capabilities` | Feature flags per source |
| `source_runtime_snapshots` | DO state cache |
| `ingest_runs` | Run tracking and status |
| `raw_artifacts` | R2 reference tracking |
| `entities_current` | Canonical entity state |
| `entity_observations` | Historical observations |
| `entity_links` | Entity relationships |
| `ingest_errors` | Error tracking with retry state |
| `retry_idempotency_keys` | Idempotency tracking |
| `retention_audit_log` | Cleanup audit trail |
| `alerts_active` | Active alerts |
| `source_metrics_5min` | Aggregated metrics windows |
| `platform_settings` | Global configuration |
| `audit_log` | Operator action log |

### Data Architecture Principles

- **Durable Objects** for per-source coordination (leases, cursors, rate limits)
- **D1** for operational relational data (sources, runs, entities)
- **R2** for immutable raw artifacts and exports
- **Analytics Engine** for high-cardinality metrics
- **Vectorize** for semantic search

## Project Structure

```
UplinkConnect/
├── apps/
│   ├── uplink-edge/          # Public intake API
│   ├── uplink-core/          # Processing, DO, Workflows
│   ├── uplink-browser/       # Browser collection
│   └── uplink-ops/           # Protected operations
├── packages/
│   ├── contracts/            # Shared schemas and types
│   ├── source-adapters/      # Adapter implementations
│   └── normalizers/          # Entity normalization + chunking
├── scripts/                  # Deployment and utility scripts
├── infra/                    # Infrastructure configs
└── migrations/               # Database migrations
```

## Documentation

- [API.md](./API.md) - Full endpoint documentation
- [OPERATIONS.md](./OPERATIONS.md) - Runbooks and procedures
- [RUNBOOK.md](./RUNBOOK.md) - Daily operations runbook
- [ROADMAP.md](./ROADMAP.md) - Completed and planned work
- [CHANGELOG.md](./CHANGELOG.md) - Release notes
- [METRICS_ALERTING.md](./METRICS_ALERTING.md) - Observability guide
- [AUDIT_REPORT.md](./AUDIT_REPORT.md) - Comprehensive audit results
- [PROJECT_STATUS.md](./PROJECT_STATUS.md) - Current project status
- [AGENTS.md](./AGENTS.md) - Agent instructions

## Contributing

1. Follow the existing code style (tabs, 100 char width)
2. Use strict TypeScript with no implicit any
3. Add tests for new functionality
4. Update documentation
5. Run `pnpm typecheck` and `pnpm test` before submitting

## License

MIT - BoringWorks
