# Uplink Connect Roadmap (Post-Phase 1)

## Current State

Phase 1 is **COMPLETE**:

- [x] `uplink-edge` intake endpoint and queue producer
- [x] `uplink-core` queue consumer with D1 run registry + R2 raw artifact write
- [x] canonical envelope contracts in `packages/contracts`
- [x] initial D1 control schema
- [x] workspace install and typecheck passing

## Completed Workstreams

### A. Source Coordination (Durable Objects) ✅

Goal: make per-source state serialized and race-safe.

Deliverables:

- [x] `SourceCoordinator` DO class
- [x] lease API: `acquireLease`, `releaseLease`
- [x] cursor API: `getCursor`, `advanceCursor`
- [x] throttle API: `nextAllowedAt`, `recordRateLimit`
- [x] status snapshot method for ops

Acceptance criteria:

- [x] concurrent triggers for same source produce one active run
- [x] cursor never regresses under retries

### B. Source Registry and Governance ✅

Goal: model sources as first-class config.

Deliverables:

- [x] D1 tables: `source_configs`, `source_capabilities`, `source_policies`
- [x] auth reference model (`secret_ref`, scope metadata)
- [x] source status model: `active`, `paused`, `disabled`
- [x] per-source pacing defaults and retry policy

Acceptance criteria:

- [x] no collector runs without a registry entry
- [x] each run stores policy snapshot used at run start

### C. Normalization and Entity Plane ✅

Goal: unify heterogeneous records into stable current-state entities.

Deliverables:

- [x] `normalizers` package with source-to-canonical mappers
- [x] entity tables in D1: `entities_current`, `entity_observations`, `entity_links`
- [x] dedupe keys: `(source_id, external_id)` and `content_hash`
- [x] raw-to-entity provenance links

Acceptance criteria:

- [x] same record replay updates existing entity, does not duplicate
- [x] every entity row links back to `run_id` and `artifact_id`

### D. Orchestration Layer (Workflows) ✅

Goal: support long-running and batched collectors with durable resume.

Deliverables:

- [x] `CollectionWorkflow` for durable collection
- [x] `RetentionWorkflow` for cleanup jobs
- [x] deterministic step naming convention
- [x] workflow run table + status sync to D1

Acceptance criteria:

- [x] workflow resume works after transient failure
- [x] batch progress can be queried by run id

### E. Adapter Framework ✅

Goal: plug in source collectors without changing core pipeline.

Deliverables:

- [x] `source-adapters` package interface
- [x] API adapter foundation
- [x] webhook adapter foundation
- [x] browser adapter foundation

Acceptance criteria:

- [x] adapters emit the same `IngestEnvelope`
- [x] core pipeline processes all without source-specific branching

### F. Ops and Reliability ✅

Goal: operate privately and safely.

Deliverables:

- [x] `uplink-ops` protected endpoints:
  - [x] run history (`/v1/runs`)
  - [x] run detail (`/v1/runs/:id`)
  - [x] replay failed run (`/v1/runs/:id/replay`)
  - [x] source health (`/v1/sources/:id/health`)
  - [x] artifact lookup (`/v1/artifacts/:id`)
- [x] retry queue tooling and dead-letter inspection endpoint
- [x] retention workflow for old artifacts and stale run logs
- [x] alerting system with configurable thresholds
- [x] metrics endpoints for system, sources, queue, and entities

Acceptance criteria:

- [x] operator can replay a failed run with one API call
- [x] stale run and high-error sources are visible in one query

### G. Metrics and Search ✅

Goal: improve observability and retrieval quality.

Deliverables:

- [x] Analytics Engine write points for ingest lifecycle
- [x] Vectorize indexing path for entities
- [x] semantic search endpoint (`/internal/search/entities`)
- [x] comprehensive metrics library

Acceptance criteria:

- [x] per-source error rate and queue lag are queryable
- [x] semantic lookup returns linked entities with provenance

## Documentation ✅

- [x] Comprehensive README.md with architecture diagram
- [x] API.md with full endpoint documentation
- [x] OPERATIONS.md with runbooks and procedures
- [x] ROADMAP.md updated with completed items
- [x] CHANGELOG.md with v0.1.0 release notes

## North Star for v1

Uplink Connect v1 is **COMPLETE**:

1. [x] 3 different source types ingest through one canonical envelope
2. [x] Replaying any ingest message does not duplicate state
3. [x] One source cannot double-run concurrently (DO lease)
4. [x] Failed runs can be replayed from ops API without touching infra
5. [x] Every stored entity can be traced to a raw artifact key

## v0.1.0 Release Summary

### What's Included

**Core Platform:**
- Multi-tenant source registry with policies
- Durable Object-based source coordination
- Workflow-driven collection with automatic retries
- Queue-based async processing
- R2 raw artifact storage
- D1 operational data store

**Observability:**
- Analytics Engine metrics
- Configurable alerting system
- Comprehensive health endpoints
- Error tracking with retry state
- Vectorize semantic search

**Operations:**
- Protected ops API
- Run replay capability
- Source health monitoring
- Bulk error retry
- Retention workflows

**Developer Experience:**
- Full TypeScript type safety
- Shared contract packages
- pnpm workspace monorepo
- Comprehensive documentation

### API Surface

| Service | Endpoints | Auth |
|---------|-----------|------|
| uplink-edge | 3 | Bearer |
| uplink-core | 25+ | Internal + None |
| uplink-ops | 7 | Bearer |
| uplink-browser | 2 | Bearer + None |

### Data Model

- 12 D1 tables
- 6 migrations
- Full foreign key relationships
- Indexed for query performance

## Future Enhancements (Post-v0.1.0)

### Potential Additions

1. **Pipelines Integration** (beta)
   - Stream analytics events to R2 Iceberg
   - SQL transforms on ingest

2. **Advanced Browser Collection**
   - Browser Rendering binding
   - CDP/Puppeteer support
   - Session reuse across collections

3. **AI Extraction**
   - Workers AI for unstructured data
   - AI Gateway for multi-provider
   - Confidence scoring

4. **Multi-region**
   - D1 read replication
   - Regional Durable Objects
   - Geo-routing

5. **Advanced Workflows**
   - Parent-child batch workflows
   - Human-in-the-loop approvals
   - Conditional branching

### Performance Optimizations

- D1 sharding strategy for scale
- Queue batch size tuning
- R2 multipart uploads for large artifacts
- Cache warming for hot sources

## Risk Register (Updated)

| Risk | Status | Mitigation |
|------|--------|------------|
| Race conditions in source state | ✅ Resolved | DO lease + cursor ownership |
| D1 growth pressure | ✅ Managed | Operational data only, history in R2 |
| Replay duplication | ✅ Prevented | Deterministic idempotency keys |
| Browser collector cost | ✅ Controlled | Opt-in per source capability |
| Alert fatigue | ✅ Addressed | Configurable thresholds, acknowledgment |

## Migration Notes

### From Previous Versions

This is the first stable release (v0.1.0). No migrations needed.

### Database Migrations

Applied in order:
1. `0001_control_schema.sql` - Core tables
2. `0002_source_registry.sql` - Source config
3. `0003_entity_plane.sql` - Entity tables
4. `0004_retention_audit.sql` - Audit logging
5. `0005_alerting_metrics.sql` - Alerts and metrics
6. `0006_retry_tracking.sql` - Error retry state

## Immediate Next Tasks (Post-v0.1.0)

1. Deploy to production environment
2. Configure first production sources
3. Set up monitoring dashboards
4. Train operations team
5. Document source-specific runbooks

## Credits

Built with:
- Cloudflare Workers
- Durable Objects
- Workflows
- D1
- R2
- Queues
- Analytics Engine
- Vectorize

Architecture inspired by:
- PeopleResearch property search workflows
- HolstonResearch ingest patterns
- BoringBots platform decomposition
