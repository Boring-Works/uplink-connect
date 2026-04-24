# Changelog

All notable changes to Uplink Connect will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-04-23

### Security & Hardening

- **AI SDK v6 Migration** - `error-agent.ts` migrated to AI SDK v6 with `streamText().textStream`
  - Uses `workers-ai-provider` with AI Gateway integration
  - Added abort signal support for client disconnect cleanup
  - Added timeout protection (`totalMs: 60s`, `chunkMs: 15s`)
  - Added `maxOutputTokens: 2048` limit
  - Added `onError` and `onFinish` callbacks for observability
  - Replaced raw `env.AI.run()` embedding with idiomatic AI SDK `embed()`

- **DO RPC Migration** - Type-safe RPC methods replacing HTTP fetch
  - `SourceCoordinator`: `acquireLease`, `releaseLease`, `advanceCursor`, `recordSuccess`, `recordFailure`, `getState`, `getHealth`, `unpause`
  - `BrowserManagerDO`: `requestSessionRpc`, `releaseSessionRpc`, `heartbeatRpc`, `getStatusRpc`, `forceCleanupRpc`
  - All callers updated in `coordinator-client.ts`, `index.ts`, `routes/browser.ts`, `health-monitor.ts`

- **DO SQL API Migration** - Persistent SQLite storage replacing in-memory state
  - `BrowserManagerDO`: Migrated from KV blob to SQLite tables (`sessions`, `session_queue`, `stats`)
  - `ErrorAgentDO`: Migrated from in-memory array to SQLite `chat_messages` with schema versioning
  - `NotificationDispatcher`: Migrated from in-memory Maps to SQLite `retry_queue` + `rate_limits`

- **Concurrency Safety** - `blockConcurrencyWhile` added to all mutating DO RPC methods and HTTP routes
- **Auth Hardening** - `timingSafeEqual` for cookie token and password hash comparison
- **SQL Injection Fix** - Whitelist validation for `findSourcesByMetadataField` column names
- **Cache Invalidation** - `getSourceConfigWithPolicy` cache invalidated on all mutations
- **Export Date Fix** - `unixepoch(?)` for proper ISO-to-epoch comparison

### Infrastructure

- **D1 Indexes** - Migration `0013_dashboard_indexes.sql` with 6 composite indexes
- **Generated Columns** - Migration `0014_generated_columns.sql` with expression index on `json_extract(metadata_json, '$.sourceType')`
  - Original `ALTER TABLE ADD GENERATED STORED` failed on D1; replaced with expression index achieving same query performance
- **Batch Deletes** - `permanentlyDeleteSource` uses atomic `db.batch()`

### Testing

- **ErrorAgentDO Unit Tests** - New comprehensive test suite covering schema, auth, rate limiting, message persistence, WebSocket protocol, abort behavior, and stream handling
- **E2E Test Fix** - Health endpoint test now handles degraded test environment gracefully
- **Wrangler Config** - Removed invalid `ai_gateway` top-level binding; AI Gateway now configured via `workers-ai-provider` `gateway` option
- **D1 Migrations** - Manually recorded already-applied `0012` and fixed `0014` for D1 compatibility
- **Test Count**: 554 → 652 passing across all suites

### Dependencies

- Updated `hono` to `^4.12.15` (XSS vulnerability fix)
- Updated `wrangler` to `^4.85.0`
- Updated `@cloudflare/workers-types` to `^4.20260424.1`

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
- Added `/scheduler` HTML page for per-source cron schedule management
  - Boring Portfolio `boringlabs` aesthetic (warm industrial, Forge Orange accent)
  - Add/edit/delete schedules with enable/disable toggles
  - Manual trigger button for immediate runs
  - Source dropdown populated from active source configs

#### Scheduler & Dynamic Cron
- New `source_schedules` table (migration 0010)
- New `scheduler.ts` library with CRUD and cron-grouped query functions
- New `/internal/schedules` REST API (GET, POST, PUT, DELETE, trigger)
- `triggerScheduledSources()` now reads enabled schedules from D1 dynamically
- Hard-coded scheduled triggers fully removed — all scheduling is data-driven
- Live updates for sources count, runs, queue depth, and alerts

#### Infrastructure
- Added v4 Durable Object migration for `DashboardStreamDO` and `ErrorAgentDO`
- Updated wrangler.jsonc with new DO bindings

#### Testing
- Added 35+ new tests across all suites
- Added 43 new utility tests in `@uplink/contracts` for safe JSON, sanitization, and HTTP error classification
- Added 10 new integration tests in core for logging sanitization and HTTP-status-based retry logic
- Total test count: 587+ (up from 519)

#### Real Data Sources
- **Multi-source public API ingestion** - 4 live sources proving platform versatility
  - `usgs-earthquakes-hourly` — GeoJSON from USGS
  - `github-public-events` — GitHub API events
  - `hackernews-top-stories` — HN top story IDs
  - `exchange-rates-daily` — Currency rates
  - All verified end-to-end: entities in D1, artifacts in R2, dashboard shows live flow
  - Setup script: `scripts/setup-public-sources.sh`
  - **Note:** Hard-coded scheduled auto-triggers removed. Manual trigger via API/dashboard until scheduler settings UI is built.

#### Reliability & Observability Improvements
- **Deep health checks** - `/health` endpoints now perform real dependency probes (D1, R2, Vectorize, Analytics Engine, DO, AI binding)
- **KV alert deduplication** - `NotificationDispatcher` checks `ALERT_CACHE` KV before sending alerts, 1-hour TTL prevents alert spam
- **Error deduplication by hash** - `recordIngestError` computes SHA-256 hash of cleaned message and increments `occurrence_count` for duplicate unresolved errors instead of inserting new rows. New migration `0011_error_dedup_hash.sql`
- **DO concurrency safety** - All POST mutations in `SourceCoordinator` are wrapped with `blockConcurrencyWhile` for atomicity

#### Promptfoo-Inspired Patterns (Data Safety & Resilience)
- **Safe JSON serialization** - `safeJsonStringify` in `@uplink/contracts` handles circular references, BigInt, functions, and Errors gracefully. Used for all D1/R2 persistence paths
- **Expanded secret sanitization** - `sanitizeObject` now redacts 70+ secret field patterns (passwords, tokens, API keys, certificates, cookies, auth headers) and detects secret-looking values (OpenAI keys, AWS AKIA, Bearer tokens, base64 blobs). All secrets replaced with `[REDACTED]`. Integrated into the structured `Logger`
- **URL credential sanitization** - `sanitizeUrl` strips `username:password` credentials and redacts sensitive query parameters (`api_key`, `token`, `signature`, etc.)
- **Rate limit header parsing** - `parseRateLimitHeaders`, `parseDuration`, and `parseRetryAfter` support OpenAI, Anthropic, and standard RFC formats. Used by `fetchWithCache` for intelligent backoff
- **Fetch with cache + retry** - `fetchWithCache` provides automatic GET response caching, exponential backoff with jitter, transient error retry (502/503/504), and rate-limit wait handling. Integrated into `uplink-browser` external fetches and all notification providers
- **D1 metrics aggregation** - `getAggregatedSourceMetrics` uses a single optimized GROUP BY query with JSON aggregation for metadata counts, replacing N+1 per-source lookups
- **Retry with deduplication** - `retryWithDeduplication` repeatedly calls an operation until a target count of unique items is reached or max consecutive empty retries are exhausted
- **Array sampling** - `sampleArray` randomly selects `n` items from an array
- **Non-transient HTTP error detection** - `classifyError` now fast-paths on HTTP status codes: 400/401/404/422/501 fail immediately without retry; 429 gets 60s delay; 502/503/504 are retryable. Extracts status from `Response`, `error.status`, or error messages
- **Connection error detection** - `isTransientConnectionError` recognizes ECONNRESET, ETIMEDOUT, fetch failed, gateway errors, and Worker CPU exceeded
- **JSON extraction from LLM outputs** - `extractJsonObjects` and `extractFirstJsonObject` for parsing structured output from Workers AI

#### Security & Audit Fixes
- **Dashboard auth** - Password submission changed from GET query param to POST form data
- **Secure cookies** - Auth cookie now includes `Secure` flag on HTTPS deployments
- **Settings page save** - Added `POST /settings` endpoint so the HTML settings page works without internal API key header
- **Cron validation** - Rejects invalid or malicious cron expressions in schedule APIs
- **SSRF protection** - Notification test URLs block private IPs, localhost, and non-HTTP(S) schemes
- **XSS mitigation** - All user-controlled values in dashboard and scheduler HTML are properly escaped
- **Export columns** - Fixed `/internal/export/runs` and `/internal/export/errors` to use actual D1 column names
- **Edge internal key** - Fallback changed from empty string to `"missing"` for safer constant-time comparison

#### Cost & Performance Protections
- **Bounded D1 queries** - Added `LIMIT 100` to `evaluateStuckRuns` and `evaluateExpiredLeases`; added 24-hour time bounds to `getQueueMetrics`; added `LIMIT 1000` to `getEntityMetrics` GROUP BY
- **Bounded fetch cache** - `fetchWithCache` now caps in-memory cache at 100 entries with FIFO eviction to prevent unbounded memory growth
- **WebSocket connection limits** - `DashboardStreamDO` capped at 100 clients, `ErrorAgentDO` capped at 20 clients. Returns 503 when full
- **Alarm leak fix** - `DashboardStreamDO` now cancels its alarm in `webSocketError` when no clients remain
- **Fixed Analytics Engine index anti-pattern** - `writeMetric` now uses `"default"` index fallback instead of random UUID per call, preventing high-cardinality storage bloat
- **Collection workflow timeouts** - `fetchFn` now respects `sourceLookup.policy.timeoutSeconds` (capped at 30s) via `AbortSignal`

#### Bug Fixes (P0)
- Fixed `ingest_queue_status` missing table crash in `DashboardStreamDO`
- Replaced `setInterval` with DO alarms in `DashboardStreamDO` and `NotificationDispatcher`
- Fixed file upload memory bomb (no more `TextDecoder().decode(buffer)` on large files)
- Added constant-time auth comparison (`timingSafeEqual`) across all workers
- Fixed `CollectionWorkflow` fetch binding (`Illegal invocation` error)
- Fixed `fastStableHash` output length to meet `contentHash` schema requirement (>=16 chars)
- Fixed malformed `wrangler.jsonc` where `triggers` was nested inside `queues`
- Removed misplaced notification test endpoint from `browser.ts`
- Fixed 404 after dashboard/scheduler login by adding `POST` route handlers

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
