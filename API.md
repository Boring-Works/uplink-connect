# Uplink Connect API Documentation

Complete reference for all API endpoints.

## Table of Contents

- [Edge Endpoints](#edge-endpoints)
- [Core Internal Endpoints](#core-internal-endpoints)
- [Ops Endpoints](#ops-endpoints)
- [Browser Endpoints](#browser-endpoints)
- [Request/Response Examples](#requestresponse-examples)

---

## Edge Endpoints

### GET /health

Health check for the edge service.

**Auth:** None

**Response:**
```json
{
  "ok": true,
  "service": "uplink-edge",
  "now": "2026-04-12T12:00:00.000Z"
}
```

---

### POST /v1/intake

Submit an ingest envelope for processing.

**Auth:** Bearer token (INGEST_API_KEY)

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request Body:**
```json
{
  "schemaVersion": "1.0",
  "ingestId": "unique-ingest-id",
  "sourceId": "my-source",
  "sourceName": "My Source",
  "sourceType": "api",
  "collectedAt": "2026-04-12T12:00:00Z",
  "records": [
    {
      "externalId": "record-123",
      "contentHash": "sha256-hash",
      "rawPayload": { /* any JSON */ },
      "suggestedEntityType": "contact",
      "observedAt": "2026-04-12T12:00:00Z"
    }
  ],
  "hasMore": false,
  "nextCursor": "optional-cursor",
  "traceId": "optional-trace",
  "metadata": { "key": "value" }
}
```

**Response (202 Accepted):**
```json
{
  "ok": true,
  "ingestId": "unique-ingest-id",
  "sourceId": "my-source",
  "recordCount": 1,
  "receivedAt": "2026-04-12T12:00:01Z"
}
```

**Error Responses:**
- `400` - Invalid JSON or schema validation failed
- `401` - Missing or invalid authorization
- `500` - INGEST_API_KEY not configured

---

### POST /v1/sources/:sourceId/trigger

Trigger a collection run for a configured source.

**Auth:** Bearer token (INGEST_API_KEY)

**Path Parameters:**
- `sourceId` - The source identifier

**Request Body (optional):**
```json
{
  "triggeredBy": "manual",
  "reason": "Daily sync",
  "force": false
}
```

**Response (202 Accepted):**
```json
{
  "ok": true,
  "sourceId": "my-source",
  "runId": "collect:my-source:workflow-id",
  "workflowId": "workflow-instance-id",
  "leaseExpiresAt": 1715523600000
}
```

**Error Responses:**
- `401` - Unauthorized
- `404` - Source not found
- `409` - Source disabled or lease unavailable

---

## Core Internal Endpoints

All `/internal/*` endpoints require internal authentication via `x-uplink-internal-key` header.

### GET /health

Health check for the core service.

**Response:**
```json
{
  "ok": true,
  "service": "uplink-core",
  "now": "2026-04-12T12:00:00.000Z"
}
```

---

### GET /internal/runs

List ingest runs with pagination.

**Query Parameters:**
- `limit` - Max results (default: 50, max: 100)

**Response:**
```json
{
  "runs": [
    {
      "run_id": "run-123",
      "source_id": "my-source",
      "source_name": "My Source",
      "status": "normalized",
      "record_count": 100,
      "normalized_count": 100,
      "received_at": "2026-04-12T12:00:00Z"
    }
  ],
  "total": 1
}
```

---

### GET /internal/runs/:runId

Get detailed information about a specific run.

**Path Parameters:**
- `runId` - The run identifier

**Response:**
```json
{
  "run_id": "run-123",
  "source_id": "my-source",
  "source_name": "My Source",
  "source_type": "api",
  "status": "normalized",
  "collected_at": "2026-04-12T12:00:00Z",
  "received_at": "2026-04-12T12:00:01Z",
  "record_count": 100,
  "normalized_count": 100,
  "error_count": 0,
  "artifact_key": "raw/my-source/2026-04-12/run-123.json",
  "workflow_instance_id": "workflow-id",
  "triggered_by": "api"
}
```

---

### POST /internal/runs/:runId/replay

Replay a failed or completed run with a new ingest ID.

**Path Parameters:**
- `runId` - The run to replay

**Response (202 Accepted):**
```json
{
  "ok": true,
  "replayRunId": "replay:run-123:uuid"
}
```

**Replay Guardrails:**
- `409` when the run is still in progress (`received`, `collecting`, `enqueued`, `persisted`)
- `409` when the run is a placeholder collection record
- `400` when stored envelope JSON is invalid or non-replayable

---

### GET /internal/artifacts/:artifactId

Get artifact metadata.

**Path Parameters:**
- `artifactId` - The artifact identifier

**Response:**
```json
{
  "artifact_id": "artifact-123",
  "run_id": "run-123",
  "source_id": "my-source",
  "artifact_type": "raw-envelope",
  "r2_key": "raw/my-source/2026-04-12/run-123.json",
  "size_bytes": 1024,
  "created_at": 1715523600
}
```

---

### GET /internal/sources

List all source configurations.

**Response:**
```json
{
  "sources": [
    {
      "source_id": "my-source",
      "name": "My Source",
      "type": "api",
      "status": "active",
      "adapter_type": "rest-api",
      "endpoint_url": "https://api.example.com/data",
      "updated_at": 1715523600
    }
  ],
  "total": 1
}
```

---

### POST /internal/sources

Create or update a source configuration.

**Request Body:**
```json
{
  "sourceId": "my-source",
  "name": "My Source",
  "type": "api",
  "status": "active",
  "adapterType": "rest-api",
  "endpointUrl": "https://api.example.com/data",
  "requestMethod": "GET",
  "requestHeaders": {"Authorization": "Bearer token"},
  "metadata": {"key": "value"},
  "policy": {
    "minIntervalSeconds": 60,
    "leaseTtlSeconds": 300,
    "maxRecordsPerRun": 1000,
    "retryLimit": 3,
    "timeoutSeconds": 60
  }
}
```

**Response (201 Created):**
```json
{
  "ok": true,
  "sourceId": "my-source"
}
```

---

### POST /internal/sources/:sourceId/trigger

Trigger a collection with lease acquisition.

**Path Parameters:**
- `sourceId` - The source to trigger

**Request Body:**
```json
{
  "triggeredBy": "system",
  "reason": "Scheduled collection",
  "force": false
}
```

When `force: true`, paused/disabled source status is bypassed for this trigger and propagated
to workflow execution.

**Response (202 Accepted):**
```json
{
  "ok": true,
  "sourceId": "my-source",
  "runId": "collect:my-source:workflow-id",
  "workflowId": "workflow-instance-id",
  "leaseExpiresAt": 1715523600000
}
```

**Error Responses:**
- `404` - Source not found
- `409` - Source not active or lease unavailable

---

### GET /internal/sources/:sourceId/health

Get comprehensive health information for a source.

**Response:**
```json
{
  "source": {
    "sourceId": "my-source",
    "name": "My Source",
    "type": "api",
    "status": "active"
  },
  "policy": {
    "minIntervalSeconds": 60,
    "leaseTtlSeconds": 300,
    "retryLimit": 3
  },
  "runtime": {
    "sourceId": "my-source",
    "leaseOwner": "system",
    "leaseExpiresAt": 1715523600000,
    "cursor": "page-5",
    "consecutiveFailures": 0,
    "lastSuccessAt": "2026-04-12T11:00:00Z"
  },
  "recentRuns": [
    {
      "run_id": "run-123",
      "status": "normalized",
      "received_at": "2026-04-12T12:00:00Z",
      "normalized_count": 100,
      "error_count": 0
    }
  ]
}
```

---

### POST /internal/search/entities

Vector similarity search for entities.

**Request Body:**
```json
{
  "query": "search text",
  "topK": 10,
  "filter": {"entityType": "contact"}
}
```

**Response:**
```json
{
  "query": "search text",
  "results": [
    {
      "entityId": "entity-123",
      "score": 0.95,
      "metadata": {
        "entityId": "entity-123",
        "sourceId": "my-source",
        "entityType": "contact",
        "observedAt": "2026-04-12T12:00:00Z"
      }
    }
  ],
  "total": 1
}
```

---

### GET /internal/alerts

List active alerts with filtering.

**Query Parameters:**
- `severity` - Filter by severity (warning, critical)
- `type` - Filter by alert type
- `sourceId` - Filter by source
- `acknowledged` - Filter by acknowledged status (true/false)
- `limit` - Max results (default: 100)

**Response:**
```json
{
  "alerts": [
    {
      "alert_id": "alert-123",
      "alert_type": "source_failure_rate",
      "severity": "critical",
      "source_id": "my-source",
      "message": "Failure rate exceeded threshold",
      "acknowledged": false,
      "created_at": "2026-04-12T12:00:00Z"
    }
  ],
  "total": 1
}
```

---

### POST /internal/alerts/check

Run alert checks and create alerts if thresholds exceeded.

**Query Parameters:**
- `sourceId` - Optional specific source to check

**Response:**
```json
{
  "ok": true,
  "checksRun": 5,
  "alertsCreated": 1,
  "alertsResolved": 2,
  "errors": []
}
```

---

### POST /internal/alerts/:alertId/acknowledge

Acknowledge an alert.

**Response:**
```json
{
  "ok": true,
  "alertId": "alert-123"
}
```

---

### POST /internal/alerts/:alertId/resolve

Resolve an alert with optional note.

**Request Body:**
```json
{
  "note": "Fixed in deployment v1.2.3"
}
```

**Response:**
```json
{
  "ok": true,
  "alertId": "alert-123"
}
```

---

### GET /internal/metrics/system

Get system-wide metrics.

**Response:**
```json
{
  "totalSources": 10,
  "activeSources": 8,
  "totalRuns": 1000,
  "successRate": 0.98,
  "avgLatencyMs": 150
}
```

---

### GET /internal/metrics/sources

Get metrics for all sources.

**Query Parameters:**
- `window` - Time window in seconds (default: 3600)

**Response:**
```json
{
  "sources": [
    {
      "sourceId": "my-source",
      "runsCount": 100,
      "successCount": 98,
      "failureCount": 2,
      "avgLatencyMs": 120
    }
  ],
  "total": 1
}
```

---

### GET /internal/metrics/sources/:sourceId

Get metrics for a specific source.

**Response:**
```json
{
  "sourceId": "my-source",
  "runsCount": 100,
  "successCount": 98,
  "failureCount": 2,
  "avgLatencyMs": 120,
  "lastRunAt": "2026-04-12T12:00:00Z"
}
```

---

### GET /internal/metrics/queue

Get queue depth and processing metrics.

**Response:**
```json
{
  "queueDepth": 50,
  "processingRate": 10,
  "dlqDepth": 5,
  "avgProcessingTimeMs": 200
}
```

---

### GET /internal/metrics/entities

Get entity-related metrics.

**Response:**
```json
{
  "totalEntities": 5000,
  "entitiesBySource": {
    "my-source": 1000
  },
  "recentObservations": 100
}
```

---

### GET /internal/errors

List ingest errors with filtering.

**Query Parameters:**
- `status` - pending, retrying, resolved, dead_letter
- `sourceId` - Filter by source
- `phase` - Error phase (intake, processing, normalization)
- `errorCategory` - network, timeout, rate_limit, auth, validation, etc.
- `fromDate` - ISO date string
- `toDate` - ISO date string
- `limit` - Max results (default: 50)
- `offset` - Pagination offset

**Response:**
```json
{
  "errors": [
    {
      "error_id": "error-123",
      "run_id": "run-123",
      "source_id": "my-source",
      "phase": "processing",
      "error_code": "TIMEOUT",
      "error_message": "Request timed out",
      "status": "retrying",
      "retry_count": 2,
      "created_at": "2026-04-12T12:00:00Z"
    }
  ],
  "total": 10,
  "limit": 50,
  "offset": 0,
  "hasMore": false
}
```

---

### POST /internal/errors/:errorId/retry

Retry a failed operation.

**Request Body:**
```json
{
  "force": false,
  "triggeredBy": "manual"
}
```

**Response:**
```json
{
  "success": true,
  "errorId": "error-123",
  "newStatus": "retrying",
  "message": "Retry initiated",
  "retryAttemptId": "retry-uuid"
}
```

---

## Ops Endpoints

All `/v1/*` endpoints require Bearer token authentication (OPS_API_KEY).

### GET /health

Health check for the ops service.

**Response:**
```json
{
  "ok": true,
  "service": "uplink-ops",
  "now": "2026-04-12T12:00:00.000Z"
}
```

---

### GET /v1/runs

List runs (proxied to core).

**Query Parameters:**
- `limit` - Max results

**Response:** Same as `/internal/runs`

---

### GET /v1/runs/:runId

Get run details (proxied to core).

**Response:** Same as `/internal/runs/:runId`

---

### POST /v1/runs/:runId/replay

Replay a run (proxied to core).

**Response:** Same as `/internal/runs/:runId/replay`

---

### POST /v1/sources/:sourceId/trigger

Trigger source collection (proxied to core).

**Response:** Same as `/internal/sources/:sourceId/trigger`

---

### GET /v1/sources/:sourceId/health

Get source health (proxied to core).

**Response:** Same as `/internal/sources/:sourceId/health`

---

### GET /v1/artifacts/:artifactId

Get artifact metadata (proxied to core).

**Response:** Same as `/internal/artifacts/:artifactId`

---

## Browser Endpoints

### GET /health

Health check for the browser service.

**Response:**
```json
{
  "ok": true,
  "service": "uplink-browser",
  "now": "2026-04-12T12:00:00.000Z"
}
```

---

### POST /internal/collect

Collect data from a URL (internal use).

**Auth:** Bearer token (BROWSER_API_KEY)

**Request Body:**
```json
{
  "sourceId": "my-source",
  "url": "https://example.com/data",
  "headers": {"Accept": "application/json"},
  "cursor": "optional-pagination-cursor"
}
```

**Response:**
```json
{
  "records": [
    {
      "sourceId": "my-source",
      "url": "https://example.com/data",
      "status": 200,
      "contentType": "application/json",
      "body": "{...response body...}",
      "fetchedAt": "2026-04-12T12:00:00Z"
    }
  ],
  "hasMore": false
}
```

---

## Request/Response Examples

### Complete Ingest Flow

```bash
# 1. Submit ingest
curl -X POST http://localhost:8787/v1/intake \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": "1.0",
    "ingestId": "ingest-001",
    "sourceId": "crm-api",
    "sourceName": "CRM API",
    "sourceType": "api",
    "collectedAt": "2026-04-12T12:00:00Z",
    "records": [
      {
        "externalId": "contact-123",
        "contentHash": "abc123def456",
        "rawPayload": {
          "name": "John Doe",
          "email": "john@example.com",
          "company": "Acme Inc"
        },
        "suggestedEntityType": "contact",
        "observedAt": "2026-04-12T12:00:00Z"
      }
    ],
    "hasMore": false
  }'

# 2. Check run status via ops
curl http://localhost:8789/v1/runs/ingest-001 \
  -H "Authorization: Bearer $OPS_API_KEY"

# 3. Search for entity
curl -X POST http://localhost:8788/internal/search/entities \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "John Doe", "topK": 5}'
```

### Source Configuration

```bash
# Create source
curl -X POST http://localhost:8788/internal/sources \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "salesforce-contacts",
    "name": "Salesforce Contacts",
    "type": "api",
    "status": "active",
    "adapterType": "salesforce-rest",
    "endpointUrl": "https://myinstance.salesforce.com/services/data/v58.0/sobjects/Contact",
    "requestMethod": "GET",
    "requestHeaders": {"Authorization": "Bearer ${SALESFORCE_TOKEN}"},
    "policy": {
      "minIntervalSeconds": 300,
      "leaseTtlSeconds": 600,
      "maxRecordsPerRun": 2000,
      "retryLimit": 3,
      "timeoutSeconds": 120
    }
  }'

# Trigger collection
curl -X POST http://localhost:8787/v1/sources/salesforce-contacts/trigger \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy": "admin", "reason": "Hourly sync"}'
```

### Error Recovery

```bash
# List failed operations
curl "http://localhost:8788/internal/errors?status=pending&limit=10" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Retry specific error
curl -X POST http://localhost:8788/internal/errors/error-123/retry \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force": true, "triggeredBy": "ops-team"}'
```

### Replay Failed Run

```bash
# Replay a failed run
curl -X POST http://localhost:8789/v1/runs/run-123/replay \
  -H "Authorization: Bearer $OPS_API_KEY"

# Response: {"ok": true, "replayRunId": "replay:run-123:uuid"}
```

---

### GET /internal/dashboard/v2

Enhanced dashboard with trends, pipeline topology, and component health.

**Query Parameters:**
- `window` - Time window in seconds (default: 86400 = 24h)

**Response:**
```json
{
  "timestamp": "2026-04-13T12:00:00Z",
  "windowSeconds": 86400,
  "summary": {
    "sources": { "total": 5, "active": 3, "paused": 2, "degraded": 0 },
    "runs": {
      "current": { "normalized": 100, "failed": 5 },
      "trend": { "percentage": 15, "direction": "up" }
    },
    "alerts": { "active": 2, "critical": 0, "warning": 2 }
  },
  "pipeline": {
    "stages": [...],
    "connections": [...],
    "overallHealth": "healthy"
  },
  "components": [...],
  "system": {...},
  "queue": {...},
  "entities": {...},
  "activeAlerts": [...]
}
```

---

### GET /dashboard

Self-hosted HTML dashboard with auto-refresh.

**Response:** HTML page with visual pipeline, metrics, and component health.

---

### GET /internal/health/components

Get health status of all system components.

**Response:**
```json
{
  "components": [
    {
      "id": "uplink-core",
      "name": "Uplink Core",
      "type": "worker",
      "status": "healthy",
      "lastCheckedAt": "2026-04-13T12:00:00Z",
      "latencyMs": 50
    }
  ],
  "timestamp": "2026-04-13T12:00:00Z"
}
```

---

### GET /internal/health/topology

Get the pipeline topology with current health and flow rates.

**Response:**
```json
{
  "stages": [
    {
      "id": "intake",
      "name": "Data Intake",
      "componentId": "uplink-edge",
      "status": "healthy",
      "inputRate": 120,
      "outputRate": 120,
      "latencyMs": 50
    }
  ],
  "connections": [...],
  "overallHealth": "healthy",
  "lastUpdated": "2026-04-13T12:00:00Z"
}
```

---

### GET /internal/health/flow

Get data flow metrics over time.

**Query Parameters:**
- `window` - Time window in seconds (default: 3600)

**Response:**
```json
{
  "timestamp": "2026-04-13T12:00:00Z",
  "windowSeconds": 3600,
  "flows": [
    {
      "path": ["intake", "queue", "processing"],
      "recordsPerSecond": 2.5,
      "bytesPerSecond": 2560,
      "errorRate": 0.01,
      "latencyMs": 150
    }
  ]
}
```

---

### GET /internal/sources/:sourceId/health/timeline

Get time-series health data for a source.

**Query Parameters:**
- `window` - Time window in seconds (default: 3600)

**Response:**
```json
{
  "sourceId": "my-source",
  "intervals": [
    {
      "timestamp": "2026-04-13T11:00:00Z",
      "totalRuns": 10,
      "successCount": 9,
      "failureCount": 1,
      "successRate": 0.9,
      "avgLatencyMs": 120
    }
  ]
}
```

---

### GET /internal/runs/:runId/trace

Get full trace for a run including children, errors, and artifacts.

**Response:**
```json
{
  "runId": "run-123",
  "sourceId": "my-source",
  "status": "normalized",
  "children": [...],
  "errors": [...],
  "artifacts": [...]
}
```

---

### GET /internal/entities/:entityId/lineage

Get complete entity history with change diffs and relationships.

**Response:**
```json
{
  "entityId": "ent-123",
  "sourceId": "my-source",
  "contentHash": "abc123",
  "currentState": {...},
  "history": [
    {
      "eventType": "created",
      "runId": "run-123",
      "observedAt": "2026-04-13T12:00:00Z",
      "changes": [...]
    }
  ],
  "relationships": [...]
}
```

---

### GET /internal/sources/:sourceId/runs/tree

Get visual hierarchy of runs and their replays.

**Response:**
```json
{
  "sourceId": "my-source",
  "tree": [
    {
      "runId": "run-123",
      "status": "normalized",
      "children": [
        { "runId": "replay:run-123:uuid", "status": "normalized" }
      ]
    }
  ]
}
```

---

### GET /internal/settings

Get platform settings.

**Response:**
```json
{
  "defaultSourcePolicy": {...},
  "alertDefaults": {...},
  "retention": {...},
  "platform": {...},
  "features": {...},
  "updatedAt": "2026-04-13T12:00:00Z"
}
```

---

### PUT /internal/settings

Update platform settings.

**Request Body:** Partial settings object

**Response:** Updated settings

---

### GET /internal/audit-log

Get audit trail of operator actions.

**Query Parameters:**
- `limit` - Max results (default: 50)
- `offset` - Pagination offset
- `resourceType` - Filter by resource type
- `actor` - Filter by actor
- `fromDate` - Start date
- `toDate` - End date

**Response:**
```json
{
  "items": [...],
  "total": 100
}
```

---

### GET /internal/schedules

List all source schedules.

**Query Parameters:**
- `sourceId` - Filter by source
- `enabledOnly` - Only return enabled schedules (`true`)

**Response:**
```json
{
  "schedules": [
    {
      "scheduleId": "uuid",
      "sourceId": "usgs-earthquakes",
      "cronExpression": "0 * * * *",
      "enabled": true,
      "label": "Hourly fetch",
      "createdAt": 1713091200,
      "updatedAt": 1713091200
    }
  ]
}
```

---

### POST /internal/schedules

Create a new source schedule.

**Request Body:**
```json
{
  "sourceId": "usgs-earthquakes",
  "cronExpression": "0 * * * *",
  "enabled": true,
  "label": "Hourly fetch"
}
```

**Response:** `201 Created`
```json
{
  "schedule": { ... }
}
```

---

### GET /internal/schedules/:scheduleId

Get a single schedule.

**Response:**
```json
{
  "schedule": { ... }
}
```

---

### PUT /internal/schedules/:scheduleId

Update a schedule.

**Request Body:**
```json
{
  "cronExpression": "*/30 * * * *",
  "enabled": false,
  "label": "Every 30 min"
}
```

**Response:**
```json
{
  "schedule": { ... }
}
```

---

### DELETE /internal/schedules/:scheduleId

Delete a schedule.

**Response:** `200 OK`
```json
{
  "ok": true
}
```

---

### POST /internal/schedules/:scheduleId/trigger

Manually trigger the source associated with a schedule.

**Response:**
```json
{
  "ok": true,
  "triggeredAt": "2026-04-14T18:00:00.000Z",
  "sourceId": "usgs-earthquakes"
}
```

---

### GET /scheduler

HTML scheduler settings page. Allows adding, editing, enabling/disabling, and manually triggering source schedules.

---

### GET /internal/stream/dashboard

WebSocket endpoint for real-time dashboard metrics. Upgrades to WebSocket connection.

**Messages:**
- Send `{"type": "subscribe", "topics": ["metrics", "all"]}` to receive updates
- Receives `{"type": "metrics", "data": {...}}` every 5 seconds

---

### GET /internal/agent/error

WebSocket endpoint for RAG-based error analysis. Upgrades to WebSocket connection.

**Messages:**
- Send `{"type": "chat", "content": "error description"}` to get AI diagnosis
- Send `{"type": "history"}` to get conversation history
- Send `{"type": "clear"}` to reset conversation

---

### GET /internal/export/runs

Export ingest runs in JSON, CSV, or NDJSON format.

**Query Parameters:**
- `sourceId` - Filter by source
- `startDate` - Filter start date
- `endDate` - Filter end date
- `status` - Filter by status
- `format` - `json` (default), `csv`, or `ndjson`
- `limit` - Max records (default: 10000, max: 50000)

**Response:** File download in requested format

---

### GET /internal/export/entities

Export entities in JSON, CSV, or NDJSON format.

**Query Parameters:**
- `sourceId` - Filter by source
- `entityType` - Filter by entity type
- `format` - `json` (default), `csv`, or `ndjson`
- `limit` - Max records (default: 10000, max: 50000)

**Response:** File download in requested format

---

### GET /internal/export/errors

Export errors in JSON, CSV, or NDJSON format.

**Query Parameters:**
- `sourceId` - Filter by source
- `format` - `json` (default), `csv`, or `ndjson`
- `limit` - Max records (default: 10000, max: 50000)

**Response:** File download in requested format

---

## Authentication Summary

| Service | Endpoint Pattern | Auth Method | Key Location |
|---------|-----------------|-------------|--------------|
| uplink-edge | `/health` | None | - |
| uplink-edge | `/v1/*` | Bearer | INGEST_API_KEY env |
| uplink-core | `/health` | None | - |
| uplink-core | `/internal/*` | Header | x-uplink-internal-key |
| uplink-ops | `/health` | None | - |
| uplink-ops | `/v1/*` | Bearer | OPS_API_KEY env |
| uplink-browser | `/health` | None | - |
| uplink-browser | `/internal/*` | Bearer | BROWSER_API_KEY env |

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 202 | Accepted (async processing) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized |
| 404 | Not Found |
| 409 | Conflict (lease unavailable, source disabled) |
| 422 | Unprocessable (retry not possible) |
| 500 | Internal Server Error |
