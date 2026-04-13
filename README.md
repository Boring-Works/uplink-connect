# Uplink Connect v3.01

Cloudflare-native data ingestion and collection platform. Built for reliability, observability, and scale.

[![Tests](https://img.shields.io/badge/tests-35%20passing-success)](./apps/uplink-core/src/test/integration)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)

## Overview

Uplink Connect is a multi-tenant data ingestion platform built entirely on Cloudflare's edge infrastructure. It handles everything from simple webhook intake to complex browser-based collection workflows, all with durable execution guarantees and comprehensive observability.

### Key Features

- **Multi-source ingestion**: API, webhook, email, file, browser, and manual triggers
- **Durable execution**: Workflows with automatic retries, leases, and cursor management
- **Idempotent processing**: Deterministic ingest IDs prevent duplicate data
- **Real-time observability**: Analytics Engine metrics, health checks, and alerting
- **Entity resolution**: Automatic deduplication and relationship linking
- **Protected operations**: Secure ops API for run management and replay

## Architecture

```
                              Uplink Connect v3.01

             +---------------------------------------------------+
             |                  Public Edge Plane                |
             |  uplink-edge (Worker)                              |
             |  - /health                                         |
             |  - /v1/intake (authenticated)                     |
             |  - /v1/sources/:id/trigger                        |
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
| `uplink-edge` | Public Worker | External intake API, webhook receiver, manual triggers |
| `uplink-core` | Internal Worker | Queue processing, D1/R2 writes, entity normalization, workflows |
| `uplink-browser` | Internal Worker | Browser-based collection (fetch-based, Browser Rendering ready) |
| `uplink-ops` | Protected Worker | Operator API for runs, replay, health checks, alerts |

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+
- Cloudflare account with Workers, D1, R2, Queues, and Workflows enabled

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

### Core Internal Endpoints (uplink-core)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | Service health check |
| GET | `/internal/runs` | Internal | List ingest runs |
| GET | `/internal/runs/:runId` | Internal | Get run details |
| POST | `/internal/runs/:runId/replay` | Internal | Replay failed run |
| GET | `/internal/artifacts/:artifactId` | Internal | Get artifact metadata |
| GET | `/internal/sources` | Internal | List source configs |
| POST | `/internal/sources` | Internal | Create/update source |
| POST | `/internal/sources/:sourceId/trigger` | Internal | Trigger with lease |
| GET | `/internal/sources/:sourceId/health` | Internal | Source health snapshot |
| POST | `/internal/search/entities` | Internal | Vector similarity search |
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
```

### Test Coverage

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
│   └── normalizers/          # Entity normalization
├── scripts/                  # Deployment and utility scripts
├── infra/                    # Infrastructure configs
├── docs/                     # Documentation
└── migrations/               # Database migrations
```

## Documentation

- [API.md](./API.md) - Full endpoint documentation
- [OPERATIONS.md](./OPERATIONS.md) - Runbooks and procedures
- [ROADMAP.md](./ROADMAP.md) - Completed and planned work
- [CHANGELOG.md](./CHANGELOG.md) - Release notes
- [METRICS_ALERTING.md](./METRICS_ALERTING.md) - Observability guide
- [AUDIT_REPORT.md](./AUDIT_REPORT.md) - Comprehensive audit results

## Contributing

1. Follow the existing code style (tabs, 100 char width)
2. Use strict TypeScript with no implicit any
3. Add tests for new functionality
4. Update documentation
5. Run `pnpm typecheck` and `pnpm test` before submitting

## License

MIT - BoringWorks
