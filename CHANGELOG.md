# Changelog

All notable changes to Uplink Connect will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-12

### Added

#### Core Platform
- **uplink-edge** - Public intake API with authenticated endpoints
  - `/health` health check endpoint
  - `/v1/intake` ingest envelope submission with queue handoff
  - `/v1/sources/:sourceId/trigger` manual source triggering
  
- **uplink-core** - Internal processing service
  - Queue consumer with idempotent processing
  - D1 operational data store integration
  - R2 raw artifact persistence
  - Entity normalization pipeline
  - Vectorize indexing for semantic search
  
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
  - Failure counting
  - Runtime state snapshots

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
- **D1 Migrations**
  - `sources` - Source registry
  - `source_configs` - Detailed configuration
  - `source_policies` - Rate limits and retry policy
  - `source_capabilities` - Feature flags
  - `source_runtime_snapshots` - DO state cache
  - `ingest_runs` - Run tracking
  - `raw_artifacts` - R2 reference tracking
  - `entities_current` - Canonical entity state
  - `entity_observations` - Historical observations
  - `entity_links` - Relationship tracking
  - `ingest_errors` - Error tracking with retry state
  - `alerts` - Alert management

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

#### Observability
- **Metrics System**
  - System-wide metrics endpoint
  - Per-source metrics with time windows
  - Queue depth tracking
  - Entity count metrics
  - Analytics Engine integration
  
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

#### API Endpoints
- 35+ endpoints across all services
- Consistent authentication patterns
- Structured error responses
- Pagination support
- Filtering and search

#### Documentation
- Comprehensive README with architecture diagram
- Complete API reference (API.md)
- Operations guide with runbooks (OPERATIONS.md)
- Updated roadmap with completed items
- This changelog

### Security
- Bearer token authentication for external endpoints
- Internal key authentication for service-to-service
- No secrets in code or committed configuration
- Secret reference pattern for source credentials

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

### Infrastructure
- Cloudflare Workers for compute
- D1 for operational data
- R2 for immutable artifacts
- Queues for async buffering
- Durable Objects for coordination
- Workflows for durable execution
- Analytics Engine for metrics
- Vectorize for semantic search

## Migration Notes

This is the initial release. No migrations from previous versions required.

### Database Setup

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
- No built-in UI - API-only interface
- Single D1 database (sharding strategy documented for future)

## Contributors

- BoringWorks Platform Team

## References

- Architecture based on [Uplink Connect v3.01 Plan](../uplink-connect-v3.01-plan.md)
- Cloudflare Workers best practices
- Durable Objects patterns from PeopleResearch projects

---

[0.1.0]: https://github.com/boringworks/uplink-connect/releases/tag/v0.1.0
