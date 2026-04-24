# UplinkConnect v3.01 — Native Cloudflare SDK Gap Analysis

**Date:** 2026-04-23  
**Scope:** Identify every production-ready native Cloudflare SDK feature that is AVAILABLE but UNUSED in UplinkConnect, with migration paths from custom code to native SDK.  
**Rule:** Exclude experimental features. Only recommend features that are 100% production-ready from Cloudflare.

---

## Implementation Status (Updated 2026-04-23)

| # | Feature | Status | Files Changed |
|---|---------|--------|---------------|
| 1 | Smart Placement | **DONE** | `wrangler.jsonc` |
| 2 | Queue concurrency + retry_delay | **DONE** | `wrangler.jsonc` |
| 3 | R2 customMetadata | **DONE** | `processing.ts` |
| 4 | Queue exponential backoff retries | **DONE** | `processing.ts` |
| 5 | D1 `json_extract` functions | **DONE** | `db.ts` |
| 6 | Cache API for source configs | **DONE** | `db.ts` |
| 7 | AI SDK v6 streaming | **DONE** | `error-agent.ts`, `package.json` |
| 8 | AI Gateway integration | **DONE** | `error-agent.ts`, `wrangler.jsonc` |
| 9 | DO RPC (SourceCoordinator) | **DONE** | `source-coordinator.ts`, `coordinator-client.ts` |
| 10 | DO SQL API (BrowserManagerDO) | **DONE** | `browser-manager.ts` |
| 11 | D1 `batch()` for atomic deletes | **DONE** | `db.ts` |
| 12 | Integration test schema fix | **DONE** | `setup.ts`, `0012_error_occurrence_count.sql` |
| — | DO Alarms | **Already used** | `browser-manager.ts`, `notification-dispatcher.ts`, `dashboard-stream.ts` |

---

## Executive Summary

| Tier | Count | Impact |
|------|-------|--------|
| **Critical gaps** (replace entire custom modules) | 2 | High |
| **Major gaps** (significant simplification) | 5 | Medium-High |
| **Minor gaps** (quality-of-life improvements) | 4 | Low-Medium |
| **Already well-utilized** | 14 | — |

**The single biggest gap:** UplinkConnect does not use the **Agents SDK** at all. The custom `ErrorAgentDO` (~239 lines), `DashboardStreamDO`, and `NotificationDispatcher` are all hand-rolled Durable Objects that duplicate capabilities the Agents SDK provides natively.

---

## Tier 1: Critical Gaps — Replace Entire Custom Modules

### 1. Agents SDK — NOT USED AT ALL

**What you have:** Five hand-rolled Durable Objects using raw `DurableObject` from `cloudflare:workers`.

**What you're missing:** The `agents` package (`^0.11.x`) provides:

| Feature | Custom Code Today | Native SDK Equivalent | Impact |
|---------|------------------|----------------------|--------|
| AI chat agent | `ErrorAgentDO` (239 lines) + manual stream parsing | `AIChatAgent` with built-in `streamText` | **Replaces entire file** |
| State persistence | Manual `ctx.storage.put/get` | `this.setState()` / `this.state` (auto-persisted) | Removes ~50 lines per DO |
| WebSocket management | Manual `WebSocketPair`, `clients` Set, ping/pong | Built-in hibernation + auto-ping | Removes ~40 lines |
| Scheduled tasks | External cron trigger → DO fetch | `this.schedule(delay, "methodName", data)` | Removes scheduler complexity |
| RPC from client | HTTP fetch to DO | `@callable()` decorated methods | Type-safe, no HTTP boilerplate |
| Readonly connections | Manual auth check on every message | `shouldConnectionBeReadonly()` hook | Security + simplicity |
| MCP tool integration | Not present | `this.mcp.connect()` + `getAITools()` | Enables tool use without custom code |
| React hooks | Custom WebSocket client | `useAgentChat()` from `agents/react` | Frontend simplification |

**Migration example — ErrorAgentDO:**

```typescript
// BEFORE: 239 lines of custom DurableObject
export class ErrorAgentDO extends DurableObject<Env> {
  private clients: Set<WebSocket> = new Set();
  // ...manual WebSocket handling, manual state, manual AI streaming
}

// AFTER: ~40 lines using Agents SDK
import { AIChatAgent } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { streamText } from "ai";

export class ErrorAgent extends AIChatAgent<Env> {
  async onChatMessage(message: string) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    // Similar errors fetched via @callable method or on-start init
    const similar = await this.searchSimilarErrors(message);
    
    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: this.buildSystemPrompt(similar),
      messages: this.messages, // auto-managed
    });
    
    return result.toDataStreamResponse();
  }
  
  @callable()
  async searchSimilarErrors(query: string) {
    const embedding = await this.embedText(query);
    return this.env.ENTITY_INDEX.query(embedding, {
      topK: 5, namespace: "errors", returnMetadata: true,
    });
  }
}
```

**What to install:**
```bash
pnpm add agents ai workers-ai-provider
```

**Effort:** Medium — refactor 3 DOs (`ErrorAgentDO`, `DashboardStreamDO`, `NotificationDispatcher`)  
**Risk:** Low — Agents SDK is production-ready, widely adopted  
**Benefit:** Eliminates ~600 lines of custom DO boilerplate

---

### 2. AI SDK v6 + workers-ai-provider — Using Raw `env.AI.run()` ✅ DONE

**What you have:** Direct `env.AI.run("@cf/...", { messages, stream: true })` calls with manual ReadableStream parsing (lines 129-163 in `error-agent.ts`).

**Status:** Migrated to `streamText({ model: workersAi("...") }).textStream` with AI Gateway support. Removed ~35 lines of manual SSE parsing.

**What you're missing:**

| Feature | Current Code | Native SDK | Benefit |
|---------|-------------|------------|---------|
| Streaming | Manual `getReader()` + `TextDecoder` + SSE parsing | `streamText().toDataStreamResponse()` | Removes ~30 lines of stream parsing |
| Tool calling | Not implemented | `streamText({ tools: { ... } })` | Enables agent tools |
| Structured output | Not implemented | `generateText({ output: Output.object({ schema }) })` | Typed JSON responses |
| AI Gateway | Direct AI binding | `workersai("@cf/...", { gateway: { id: "..." } })` | Caching, rate limiting, observability |
| Session affinity | Used in BoringWorkers | Already supported via `sessionAffinity` | Prefix cache hits |
| Session token management | Not used | `tool()` from `ai` | Reusable tool definitions |

**Migration for ErrorAgentDO streaming:**

```typescript
// BEFORE (error-agent.ts:129-163) — 35 lines
const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
  messages: messagesForAi, stream: true,
}) as unknown as ReadableStream;
// ...manual reader loop, decoder, SSE parsing, JSON.parse

// AFTER — 3 lines
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const workersai = createWorkersAI({ binding: env.AI });
const result = streamText({
  model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  messages: messagesForAi,
});
return result.toDataStreamResponse();
```

**Effort:** Low — drop-in replacement for AI calls  
**Risk:** Very low — `workers-ai-provider` is the official adapter

---

### 3. AI Gateway — NOT USED

**What you have:** Direct Workers AI binding calls with no caching, rate limiting, or observability layer.

**What you're missing:** AI Gateway provides production-grade AI traffic management:

| Feature | Current State | With AI Gateway |
|---------|-------------|-----------------|
| Caching | None | `cf-aig-cache-ttl` header — cache identical prompts |
| Rate limiting | Custom backpressure in DO | Per-gateway rate limits with configurable thresholds |
| Retry/fallback | Custom retry logic in `retry.ts` | Automatic retry with model fallback |
| Observability | Basic Analytics Engine | Per-request logs, token counts, latency percentiles |
| Unified billing | Workers AI only | One bill for Workers AI + third-party models |
| Zero Data Retention | N/A | `zdr: true` for OpenAI/Anthropic |

**Implementation:**

```typescript
// Add to wrangler.jsonc
"ai_gateway": {
  "binding": "AI_GATEWAY",
  "gateway_id": "uplink-ai-gateway"
}

// In code — just add gateway option
const workersai = createWorkersAI({ 
  binding: env.AI,
  gateway: { id: "uplink-ai-gateway" } 
});

// Or with REST API for third-party models
const workersai = createWorkersAI({ 
  accountId: env.CF_ACCOUNT_ID,
  apiKey: env.CF_API_TOKEN,
  gateway: { id: "uplink-ai-gateway" }
});
```

**Note:** Workers AI models (`@cf/...`) are NOT billed through AI Gateway — they use Workers AI pricing. AI Gateway billing applies to third-party models (OpenAI, Anthropic, etc.).

**Effort:** Low — add binding, pass `gateway` option  
**Risk:** Very low — AI Gateway is GA, default gateway available with no setup

---

## Tier 2: Major Gaps — Significant Simplification

### 4. D1 JSON Functions — Storing JSON as TEXT, Parsing in JS ✅ DONE

**What you have:** JSON columns stored as TEXT, parsed/stringified in JavaScript:
- `request_headers_json`, `metadata_json`, `webhook_security_json`, `alert_config_json`, `envelope_json`
- `retry_attempts_json` parsed with `JSON.parse()` in `processing.ts:560`

**What you're missing:** D1 has native SQLite JSON1 extension:

```sql
-- Extract nested value without parsing in JS
SELECT json_extract(metadata_json, '$.sourceType') as source_type
FROM source_configs;

-- Filter inside JSON arrays
SELECT * FROM ingest_runs
WHERE json_extract(envelope_json, '$.records[0].id') = ?;

-- Generated column (auto-populated from JSON)
ALTER TABLE source_configs ADD COLUMN source_type 
  AS (json_extract(metadata_json, '$.sourceType')) STORED;

-- Index on generated column for fast JSON filtering
CREATE INDEX idx_source_type ON source_configs(source_type);
```

**Where to apply:**
- `db.ts` — `upsertSourceConfig` stores `metadata_json`; queries could use `json_extract`
- `processing.ts` — `retry_attempts_json` parsed manually; use `json_extract` in SQL
- `metrics.ts` — Could aggregate JSON fields directly in SQL with `json_group_array`

**Effort:** Low-Medium — update schema + queries  
**Risk:** Very low — SQLite JSON1 is stable, well-tested

---

### 5. Durable Objects SQL API — Using KV Storage on SQLite-backed DOs ✅ PARTIAL

**What you have:** All 5 DOs use `ctx.storage.put/get` (KV API) despite being SQLite-backed:

**Status:** `BrowserManagerDO` migrated to DO SQL API with `sessions`, `session_queue`, and `stats` tables. Remaining DOs (`SourceCoordinator`, `ErrorAgentDO`, `DashboardStreamDO`, `NotificationDispatcher`) still use KV storage.
- `SourceCoordinator`: `SNAPSHOT_KEY` + `BACKPRESSURE_KEY` as blob values
- `ErrorAgentDO`: `MESSAGES_KEY` as serialized array
- Others likely similar

**What you're missing:** SQLite-backed DOs have a full SQL engine:

```typescript
// BEFORE: Blob storage
await this.ctx.storage.put(SNAPSHOT_KEY, this.snapshot);
const stored = await this.ctx.storage.get<RuntimeSnapshot>(SNAPSHOT_KEY);

// AFTER: SQL with schema, indexes, queries
this.ctx.storage.sql.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    source_id TEXT PRIMARY KEY,
    lease_token TEXT,
    lease_expires_at INTEGER,
    cursor TEXT,
    consecutive_failures INTEGER DEFAULT 0,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_lease ON snapshots(lease_expires_at);
`);

// Query with SQL
const row = this.ctx.storage.sql
  .exec("SELECT * FROM snapshots WHERE source_id = ?", this.snapshot.sourceId)
  .one();
```

**Benefits of SQL over KV in DOs:**
- Partial updates (no need to serialize entire snapshot)
- Indexed queries (fast lease lookups)
- Relational data (backpressure as separate table with foreign keys)
- ACID transactions across multiple rows

**Effort:** Medium — refactor DO constructors + persist methods  
**Risk:** Low — SQL API is GA, recommended for new DOs

---

### 6. Durable Objects Alarms API — Using External Cron Triggers

**What you have:** `scheduled()` handler in main worker + cron trigger `*/5 * * * *` to trigger source collection. The scheduler queries D1 for enabled schedules, then fetches DOs.

**What you're missing:** DOs can set their own alarms:

```typescript
// In SourceCoordinator — schedule next collection inline
async scheduleNextRun(intervalSeconds: number) {
  const alarmTime = Date.now() + intervalSeconds * 1000;
  await this.ctx.storage.setAlarm(alarmTime);
}

// Alarm handler runs automatically
async alarm() {
  // Self-trigger collection
  await this.performCollection();
  // Reschedule
  await this.scheduleNextRun(this.config.intervalSeconds);
}
```

**Benefits:**
- No need for global cron trigger (simpler wrangler config)
- Per-source scheduling granularity (not all sources run every 5 min)
- DO wakes itself up — no external scheduler needed
- Alarms survive DO hibernation

**Effort:** Medium — refactor scheduling from worker-level to DO-level  
**Risk:** Low — Alarms API is GA

---

### 7. Durable Objects RPC — Using HTTP fetch Between DOs ✅ PARTIAL

**What you have:** `coordinator.fetch(doUrl.toString(), { method: "POST" })` in `index.ts:119` and throughout `coordinator-client.ts`.

**Status:** `SourceCoordinator` now exposes `acquireLease`, `releaseLease`, `advanceCursor`, `recordSuccess`, `recordFailure`, `unpause`, `getState`, `getHealth` as public RPC methods. `coordinator-client.ts` updated to use RPC instead of HTTP fetch. Other DOs still use HTTP.

**What you're missing:** DOs support direct RPC:

```typescript
// BEFORE: HTTP fetch wrapper
const doUrl = new URL("https://source-coordinator/collect");
doUrl.searchParams.set("sourceId", sourceId);
doUrl.searchParams.set("leaseToken", leaseToken);
await coordinator.fetch(doUrl.toString(), { method: "POST" });

// AFTER: Type-safe RPC
// In SourceCoordinator:
export class SourceCoordinator extends DurableObject<Env> {
  async collect(params: { sourceId: string; leaseToken: string }) {
    // ... collection logic
    return { success: true, recordCount };
  }
}

// In caller:
const result = await coordinator.collect({ sourceId, leaseToken });
```

**Benefits:**
- Type-safe calls (no URL construction, no JSON parsing)
- No HTTP overhead (internal routing)
- Automatic serialization of complex objects
- Works with service bindings too

**Effort:** Medium — refactor coordinator-client + DO methods  
**Risk:** Low — RPC is GA, recommended over fetch

---

### 8. Queues Consumer Concurrency + Retry Delay — CONFIGURED ✅

**What you have:** Enhanced queue consumer config in `wrangler.jsonc`:
```jsonc
{
  "queue": "uplink-ingest",
  "max_batch_size": 10,
  "max_batch_timeout": 30,
  "max_retries": 3,
  "dead_letter_queue": "uplink-ingest-dlq"
}
```

**What you're missing:**

```jsonc
{
  "queue": "uplink-ingest",
  "max_batch_size": 10,
  "max_batch_timeout": 30,
  "max_retries": 3,
  "dead_letter_queue": "uplink-ingest-dlq",
  "max_concurrency": 10,        // NEW: Auto-scale up to 10 concurrent consumers
  "retry_delay": 5              // NEW: Wait 5s before retry (backpressure relief)
}
```

**Also in code:** Replace manual retry logic with `message.retry({ delaySeconds: 10 })`:

```typescript
// BEFORE (processing.ts:119)
message.retry();

// AFTER: Exponential backoff via queue
message.retry({ delaySeconds: Math.min(2 ** message.attempts * 5, 300) });
```

**Effort:** Very low — config change + minor code update  
**Risk:** Very low

---

### 9. Cache API — Partially Implemented ✅

**What you have:** `getSourceConfigWithPolicy()` now caches via Cache API (5-min TTL). Other hot paths still uncached.

**What you're missing:** Workers Cache API for:

```typescript
// Cache source configurations (rarely change)
const cache = caches.default;
const cacheKey = new Request(`https://internal/source-config/${sourceId}`);
const cached = await cache.match(cacheKey);
if (cached) return cached.json();

const config = await db.prepare("...").first();
await cache.put(cacheKey, new Response(JSON.stringify(config), {
  headers: { "Cache-Control": "max-age=300" }
}));
```

**Cacheable items in UplinkConnect:**
- Source configs (TTL: 5 min)
- Source policies (TTL: 5 min)
- Health check responses (TTL: 30 sec)
- Dashboard static data (TTL: 1 min)
- AI embeddings (if deterministic text)

**Effort:** Low — add cache checks around hot queries  
**Risk:** Very low — Cache API is GA

---

### 10. R2 Custom Metadata + Conditional Operations ✅ DONE

**What you have:** Basic `R2Bucket.put(key, body, { httpMetadata })` in `processing.ts:180`.

**Status:** `customMetadata` added to R2 puts with `sourceId`, `sourceType`, `runId`, `recordCount`, `collectedAt`.

**What you're missing:**

```typescript
// Add custom metadata for indexing
await env.RAW_BUCKET.put(rawKey, rawJson, {
  httpMetadata: { contentType: "application/json" },
  customMetadata: {
    sourceId: envelope.sourceId,
    sourceType: envelope.sourceType,
    runId,
    recordCount: String(envelope.records.length),
    collectedAt: envelope.collectedAt,
  },
});

// Later: list by metadata filter
const list = await env.RAW_BUCKET.list({
  prefix: `source/${sourceId}/`,
  // customMetadata filters not yet in R2 API, but metadata is queryable
});
```

**Also:** R2 supports multipart upload for large payloads:
```typescript
// For large ingestion batches
const multipart = await env.RAW_BUCKET.createMultipartUpload(rawKey);
// Upload parts...
```

**Effort:** Low — pass `customMetadata` option  
**Risk:** Very low

---

## Tier 3: Minor Gaps — Quality-of-Life Improvements

### 11. D1 `run()` Return Metadata — Not Using

**What you have:** `await stmt.run()` — discarding return value.

**What you're missing:** D1 returns rich metadata:

```typescript
const result = await stmt.run();
// result.meta.duration — query time
// result.meta.rows_read — rows scanned
// result.meta.rows_written — rows modified
// result.meta.changes — number of changes
```

**Apply to:** `db.ts` — log slow queries, track D1 usage for optimization.

---

### 12. Observability Traces — Configured but Underutilized

**What you have:** `observability.traces.enabled: true` in wrangler.jsonc, but no custom spans.

**What you're missing:** Custom trace spans for pipeline visibility:

```typescript
// In processing.ts
export async function handleIngestMessage(env: Env, message: IngestQueueMessage) {
  const traceId = message.requestId || crypto.randomUUID();
  // Workers runtime automatically creates spans, but custom spans give granularity
  
  // Currently: no visibility into which step is slow
  // Could use: manual span creation via Workers Trace API (if available)
  // Or: structured logging with trace_id for external trace correlation
}
```

**Note:** Custom OpenTelemetry spans in Workers are still maturing. For now, structured logs with `trace_id` + `span_id` are the production-ready approach.

---

### 13. Smart Placement — CONFIGURED ✅

**What you have:** `placement: { mode: "smart" }` added to `wrangler.jsonc`.

**What you're missing:** For DO-heavy workloads with D1/R2 access:

```jsonc
// wrangler.jsonc
"placement": {
  "mode": "smart"
}
```

Smart Placement runs the Worker close to its DOs/D1, reducing latency for DO RPC and D1 queries. Ideal for UplinkConnect's architecture (Worker → DO → D1 on every request).

**Effort:** One-line config  
**Risk:** Very low — Smart Placement is GA

---

### 14. Vectorize Metadata Filtering — Type Imported but Not Used

**What you have:** `VectorizeVectorMetadataFilter` type imported but queries don't use the `filter` parameter:

```typescript
// vectorize.ts:227 — filter is passed from options but never set by callers
const results = await env.ENTITY_INDEX.query(embedding, {
  topK: options?.topK ?? 10,
  filter: options?.filter, // always undefined in practice
  // ...
});
```

**What you could do:** Filter by `sourceId` or `entityType`:

```typescript
// Search only within a specific source
const results = await querySimilarEntities(env, query, {
  filter: { sourceId: { $eq: "usgs-earthquakes" } }
});
```

**Effort:** Low — pass filter from API routes  
**Risk:** Very low

---

### 15. Workers AI Image/Audio Models — Not Used

**What you have:** Text embeddings (`bge-small-en-v1.5`) + text generation (`llama-3.3-70b`).

**What you're missing:** Workers AI supports additional modalities that could enhance UplinkConnect:

| Model | Use Case for UplinkConnect |
|-------|---------------------------|
| `@cf/black-forest-labs/flux-1-schnell` | Generate dashboard charts/thumbnails |
| `@cf/openai/whisper` | Transcribe audio artifacts |
| `@cf/myshell-ai/melotts` | Text-to-speech for alert notifications |
| `@cf/baai/bge-reranker-base` | Rerank search results for better relevance |

**Note:** These are nice-to-have, not critical for data ingestion.

---

### 16. Pipeline Binding (Beta) — Partially Referenced

**What you have:** `types.ts:9-11` defines a `Pipeline` interface as "beta" but it's never used in the app.

```typescript
interface Pipeline {
  send(event: unknown): Promise<void>;
}
```

**What it is:** Cloudflare Pipelines is a streaming ingestion service (separate from Queues). For UplinkConnect's volume, Queues is the right choice. This comment can be removed.

---

## Already Well-Utilized ✅

These Cloudflare features are being used effectively and need no changes:

| Feature | Usage | Grade |
|---------|-------|-------|
| Hono routing | All API routes | A |
| D1 database | Control plane + entity storage | A |
| D1 `batch()` API | `upsertNormalizedEntities` with chunking | A |
| R2 raw storage | Artifact persistence | A |
| Vectorize | Semantic search on entities + errors | A |
| Analytics Engine | Ingest metrics + coordinator metrics | A |
| Queues + DLQ | Ingest pipeline with dead-letter | A |
| Durable Objects (SQLite-backed) | 5 DOs with proper migrations | A |
| WebSocket Hibernation API | `ErrorAgentDO` uses `acceptWebSocket` | A |
| Workflows | Collection + Retention workflows | A |
| Workers AI | Embeddings + LLM inference | A |
| Service bindings | `UPLINK_BROWSER` fetcher | A |
| Cron triggers | `*/5 * * * *` for scheduling | A |
| KV | `ALERT_CACHE` for alert dedup | A |
| Observability (logs + traces) | Enabled in wrangler.jsonc | B+ |

---

## Priority Action Matrix

| Priority | Feature | Effort | Impact | Files to Change |
|----------|---------|--------|--------|-----------------|
| **P0** | AI Gateway | 1h | High | `wrangler.jsonc`, `error-agent.ts`, `vectorize.ts` |
| **P0** | AI SDK v6 (`streamText`) | 2h | High | `error-agent.ts` |
| **P1** | Agents SDK (migrate ErrorAgentDO) | 1 day | Very High | New file + remove `error-agent.ts` |
| **P1** | DO SQL API (SourceCoordinator) | 4h | High | `source-coordinator.ts` |
| **P1** | DO RPC (replace fetch calls) | 4h | Medium | `coordinator-client.ts`, all DOs |
| **P2** | D1 JSON functions | 3h | Medium | `db.ts`, schema migrations |
| **P2** | Queue concurrency + retry delay | 30m | Medium | `wrangler.jsonc`, `processing.ts` |
| **P2** | Cache API | 2h | Medium | `routes/*.ts`, `lib/db.ts` |
| **P2** | Smart Placement | 5m | Low | `wrangler.jsonc` |
| **P3** | DO Alarms (self-scheduling) | 1 day | Medium | `source-coordinator.ts`, `index.ts` |
| **P3** | R2 custom metadata | 1h | Low | `processing.ts` |
| **P3** | Vectorize metadata filtering | 1h | Low | `routes/entities.ts` |

---

## Recommended Implementation Order

### Phase 1: Quick Wins (1 day)
1. Add AI Gateway binding
2. Migrate `error-agent.ts` to AI SDK v6 `streamText`
3. Add Smart Placement
4. Configure queue `max_concurrency` + `retry_delay`

### Phase 2: DO Modernization (2-3 days)
5. Migrate `ErrorAgentDO` to `AIChatAgent`
6. Convert `SourceCoordinator` to use DO SQL API
7. Replace DO fetch calls with RPC

### Phase 3: Data Layer (1-2 days)
8. Add D1 JSON generated columns
9. Add Cache API for hot paths
10. Add R2 custom metadata

---

*Generated by AI agent. All findings based on production-ready Cloudflare SDK features as of April 2026.*
