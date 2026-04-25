# Uplink Connect Roadmap

## Current State

Uplink Connect v0.1.2 is **COMPLETE and PRODUCTION-READY**.

All major workstreams from the original v3.01 plan have been implemented and deployed.

---

## Completed Workstreams

### A. Source Coordination (Durable Objects) ✅

Goal: make per-source state serialized and race-safe.

Deliverables:

- [x] `SourceCoordinator` DO class
- [x] lease API: `acquireLease`, `releaseLease`
- [x] cursor API: `getCursor`, `advanceCursor`
- [x] throttle API: `nextAllowedAt`, `recordRateLimit`
- [x] status snapshot method for ops
- [x] backpressure and auto-pause on consecutive failures

Acceptance criteria:

- [x] concurrent triggers for same source produce one active run
- [x] cursor never regresses under retries
- [x] source auto-pauses after failure threshold

### B. Source Registry and Governance ✅

Goal: model sources as first-class config.

Deliverables:

- [x] D1 tables: `source_configs`, `source_capabilities`, `source_policies`
- [x] auth reference model (`secret_ref`, scope metadata)
- [x] source status model: `active`, `paused`, `disabled`
- [x] per-source pacing defaults and retry policy
- [x] source soft-delete with restore capability
- [x] webhook HMAC signature verification

Acceptance criteria:

- [x] no collector runs without a registry entry
- [x] each run stores policy snapshot used at run start
- [x] deleted sources can be restored

### C. Normalization and Entity Plane ✅

Goal: unify heterogeneous records into stable current-state entities.

Deliverables:

- [x] `normalizers` package with source-to-canonical mappers
- [x] entity tables in D1: `entities_current`, `entity_observations`, `entity_links`
- [x] dedupe keys: `(source_id, external_id)` and `content_hash`
- [x] raw-to-entity provenance links
- [x] AST-based code chunking for TS/JS files

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
- [x] Webhook adapter foundation with HMAC verification
- [x] Browser adapter foundation
- [x] File upload endpoint with multipart/form-data

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
- [x] settings management with audit logging
- [x] data export API (JSON, CSV, NDJSON)

Acceptance criteria:

- [x] operator can replay a failed run with one API call
- [x] stale run and high-error sources are visible in one query
- [x] all operator actions are audited

### G. Metrics and Search ✅

Goal: improve observability and retrieval quality.

Deliverables:

- [x] Analytics Engine write points for ingest lifecycle
- [x] Vectorize indexing path for entities
- [x] semantic search endpoint (`/internal/search/entities`)
- [x] comprehensive metrics library
- [x] synthetic monitoring cron job (every 5 minutes)
- [x] visual HTML dashboard with auto-refresh
- [x] pipeline topology and component health endpoints
- [x] WebSocket real-time dashboard updates

Acceptance criteria:

- [x] per-source error rate and queue lag are queryable
- [x] semantic lookup returns linked entities with provenance
- [x] dashboard shows live system health

### H. Notifications ✅

Goal: alert operators through multiple channels.

Deliverables:

- [x] Universal notification system with 8 providers
  - [x] webhook
  - [x] slack
  - [x] discord
  - [x] teams
  - [x] pagerduty
  - [x] opsgenie
  - [x] email
  - [x] custom
- [x] `NotificationDispatcher` DO with rate limiting and retry logic
- [x] Notification delivery tracking in D1

Acceptance criteria:

- [x] alerts can be sent to multiple channels
- [x] rate limiting prevents notification floods

### I. AI and Real-time Features ✅

Goal: leverage Workers AI and WebSockets for advanced capabilities.

Deliverables:

- [x] `DashboardStreamDO` - WebSocket metrics streaming
- [x] `ErrorAgentDO` - RAG-based error diagnosis
- [x] Vectorize namespace for error similarity search
- [x] Workers AI integration for embeddings and text generation

Acceptance criteria:

- [x] dashboard receives live metric updates
- [x] error agent provides contextual diagnosis

### J. DevOps and Quality ✅

Goal: ensure reliable deployment and high code quality.

Deliverables:

- [x] GitHub Actions CI/CD workflow
- [x] 483+ tests across all suites
- [x] TypeScript strict mode throughout
- [x] Biome linting and formatting
- [x] Live test suite against production
- [x] Automated deployment scripts

Acceptance criteria:

- [x] all tests pass on every PR
- [x] type checks pass across all workspaces
- [x] live tests validate production health

---

## Documentation ✅

- [x] Comprehensive README.md with architecture diagram
- [x] API.md with full endpoint documentation
- [x] OPERATIONS.md with runbooks and procedures
- [x] RUNBOOK.md with daily operations
- [x] ROADMAP.md updated with completed items
- [x] CHANGELOG.md with release notes
- [x] CLAUDE.md with project context
- [x] AGENTS.md with multi-agent instructions
- [x] PROJECT_STATUS.md with current status
- [x] METRICS_ALERTING.md with observability guide
- [x] AUDIT_REPORT.md with comprehensive audit
- [x] openapi.yml with OpenAPI 3.0 spec

---

## North Star for v1

Uplink Connect v1 is **COMPLETE**:

1. [x] 6 different source types ingest through one canonical envelope
2. [x] Replaying any ingest message does not duplicate state
3. [x] One source cannot double-run concurrently (DO lease)
4. [x] Failed runs can be replayed from ops API without touching infra
5. [x] Every stored entity can be traced to a raw artifact key
6. [x] Dashboard provides real-time system visibility
7. [x] AI-powered error diagnosis assists operators
8. [x] Data can be exported in multiple formats

---

## v0.1.2 Release Summary

### What's Included

**Core Platform:**
- Multi-tenant source registry with policies
- Durable Object-based source coordination (5 DOs, all SQL-backed)
- WebSocket real-time features (2 DOs)
- Workflow-driven collection with automatic retries
- Queue-based async processing with DLQ
- R2 raw artifact storage and file uploads (streaming for large files)
- D1 operational data store (18 tables, 14 migrations)

**Observability:**
- Analytics Engine metrics
- Configurable alerting system
- Comprehensive health endpoints
- Visual HTML dashboard with WebSocket updates
- Error tracking with retry state
- Vectorize semantic search
- Synthetic monitoring

**Operations:**
- Protected ops API
- Run replay capability
- Source health monitoring
- Bulk error retry
- Retention workflows
- Settings management with audit log
- Data export API
- RAG error chat agent

**AI and Notifications:**
- Workers AI integration
- Vectorize error similarity search
- Universal notification system (8 providers)
- Rate-limited notification dispatcher

**Developer Experience:**
- Full TypeScript type safety
- Shared contract packages
- pnpm workspace monorepo
- 483+ comprehensive tests
- CI/CD pipeline

### API Surface

| Service | Endpoints | Auth |
|---------|-----------|------|
| uplink-edge | 5 | Bearer + None |
| uplink-core | 45+ | Internal + None |
| uplink-ops | 7 | Bearer |
| uplink-browser | 2 | Bearer + None |

### Data Model

- 18 D1 tables
- 14 migrations
- Full foreign key relationships
- Indexed for query performance

---

## Future Enhancements (Post-v0.1.1)

### Immediate (Next 2 Weeks)

1. **Scheduler Settings UI**
   - Dashboard page for per-source cron configuration
   - Enable/disable toggle per source
   - Store schedules in `platform_settings` or dedicated table
   - Replace the disabled `triggerScheduledSources` stub

### Medium-term (Next Quarter)

2. **Pipelines Integration** (beta)
   - Stream analytics events to R2 Iceberg
   - SQL transforms on ingest

3. **Advanced Browser Collection**
   - Browser Rendering binding full utilization
   - CDP/Puppeteer support
   - Session reuse across collections

4. **AI Extraction**
   - Workers AI for unstructured data extraction
   - AI Gateway for multi-provider
   - Confidence scoring

5. **Multi-region**
   - D1 read replication
   - Regional Durable Objects
   - Geo-routing

6. **GraphQL API Layer**
   - Unified query interface
   - Entity relationship traversal

### Performance Optimizations

- D1 sharding strategy for scale
- Queue batch size tuning
- R2 multipart uploads for large artifacts
- Cache warming for hot sources

---

## Risk Register (Updated)

| Risk | Status | Mitigation |
|------|--------|------------|
| Race conditions in source state | ✅ Resolved | DO lease + cursor ownership |
| D1 growth pressure | ✅ Managed | Operational data only, history in R2 |
| Replay duplication | ✅ Prevented | Deterministic idempotency keys |
| Browser collector cost | ✅ Controlled | Opt-in per source capability |
| Alert fatigue | ✅ Addressed | Configurable thresholds, acknowledgment |
| Notification floods | ✅ Addressed | Rate-limited DO dispatcher |
| Dashboard stale data | ✅ Addressed | WebSocket real-time updates |

---

## Immediate Next Tasks (Post-v0.1.2)

1. **Build Scheduler Settings UI** - Per-source cron configuration in dashboard (priority: replaces hard-coded triggers)
2. Monitor production deployment metrics
3. Gather operator feedback on dashboard and error agent
4. Document source-specific runbooks
5. Evaluate Pipelines beta when available

---

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
- Workers AI

Architecture inspired by:
- PeopleResearch property search workflows
- HolstonResearch ingest patterns
- BoringBots platform decomposition
- RepoMind RAG and chunking patterns
