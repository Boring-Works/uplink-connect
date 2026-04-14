# Uplink Connect Operations Guide

Operational procedures for running Uplink Connect in production.

## Table of Contents

- [Daily Operations Checklist](#daily-operations-checklist)
- [Troubleshooting Common Issues](#troubleshooting-common-issues)
- [How to Add a New Source](#how-to-add-a-new-source)
- [How to Replay Failed Runs](#how-to-replay-failed-runs)
- [How to Monitor Health](#how-to-monitor-health)

---

## Daily Operations Checklist

### Morning Checks (Start of Day)

```bash
# 1. Check system health
curl https://uplink-edge.codyboring.workers.dev/health
curl https://uplink-core.codyboring.workers.dev/health

# 2. Check visual dashboard
curl https://uplink-core.codyboring.workers.dev/dashboard

# 3. Check for active alerts
curl https://uplink-core.codyboring.workers.dev/internal/alerts \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 4. Review queue depth
curl https://uplink-core.codyboring.workers.dev/internal/metrics/queue \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 5. Check recent failed runs
curl "https://uplink-core.codyboring.workers.dev/internal/runs?limit=20" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" | jq '.runs[] | select(.status == "failed")'

# 6. Check component health
curl https://uplink-core.codyboring.workers.dev/internal/health/components \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

### What to Look For

| Metric | Warning Threshold | Critical Threshold | Action |
|--------|------------------|-------------------|--------|
| Queue Depth | > 100 | > 500 | Scale consumers or investigate blockage |
| Failed Runs (1h) | > 5 | > 20 | Check source health, retry failures |
| Alert Count | > 0 unack | > 3 critical | Acknowledge and investigate |
| DLQ Depth | > 10 | > 50 | Replay or purge dead letters |
| Avg Latency | > 5s | > 30s | Check downstream dependencies |

### End of Day Checks

```bash
# 1. Run alert checks to catch any issues
curl -X POST https://uplink-core.codyboring.workers.dev/internal/alerts/check \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 2. Review daily metrics
curl https://uplink-core.codyboring.workers.dev/internal/metrics/system \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 3. Check source health summary
curl https://uplink-core.codyboring.workers.dev/internal/metrics/sources?window=86400 \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 4. Review dashboard v2 API
curl https://uplink-core.codyboring.workers.dev/internal/dashboard/v2 \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# 5. Check pipeline topology
curl https://uplink-core.codyboring.workers.dev/internal/health/topology \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

---

## Troubleshooting Common Issues

### Issue: High Queue Depth

**Symptoms:**
- Queue depth increasing steadily
- Processing lag visible in metrics
- Runs staying in "received" status

**Diagnosis:**
```bash
# Check queue metrics
curl https://uplink-core.codyboring.workers.dev/internal/metrics/queue \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check for processing errors
curl "https://uplink-core.codyboring.workers.dev/internal/errors?status=pending&limit=50" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Solutions:**

1. **Temporary spike:** Wait for natural catch-up if due to burst traffic
2. **Persistent backlog:**
   - Check D1 connection limits (single-threaded per DB)
   - Verify R2 write permissions
   - Review Worker CPU time limits
3. **Blocked by errors:**
   - Retry transient errors: `POST /internal/errors/:id/retry`
   - Send poison pills to DLQ if unrecoverable

### Issue: Source Collection Failing

**Symptoms:**
- Source shows consecutive failures
- No new runs created
- Lease expiring without success

**Diagnosis:**
```bash
# Check source health
curl https://uplink-core.codyboring.workers.dev/v1/sources/SOURCE_ID/health \
  -H "Authorization: Bearer $OPS_API_KEY"

# Check recent errors for source
curl "https://uplink-core.codyboring.workers.dev/internal/errors?sourceId=SOURCE_ID&limit=20" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Common Causes & Solutions:**

| Cause | Check | Solution |
|-------|-------|----------|
| Auth expired | `error_code: AUTH_FAILED` | Rotate credentials in Secrets Store |
| Rate limited | `error_code: RATE_LIMIT` | Increase `minIntervalSeconds` in policy |
| Timeout | `error_code: TIMEOUT` | Increase `timeoutSeconds` or optimize query |
| Endpoint down | `error_code: NETWORK` | Verify endpoint URL, check upstream status |
| Schema change | `error_code: VALIDATION` | Update adapter mapping |

### Issue: Duplicate Entities

**Symptoms:**
- Same external ID appearing multiple times in entities_current
- Content hash mismatches for identical data

**Diagnosis:**
```sql
-- Query D1 directly
SELECT external_id, COUNT(*) as count
FROM entities_current
WHERE source_id = 'SOURCE_ID'
GROUP BY external_id
HAVING count > 1;
```

**Solutions:**

1. **Immediate:** Clean up duplicates manually
2. **Root cause:** Check that `contentHash` is deterministic
3. **Prevention:** Ensure `externalId` is populated and unique per source

### Issue: Workflow Stuck

**Symptoms:**
- Run status stuck on "collecting" for hours
- Workflow instance not progressing
- Lease not released

**Diagnosis:**
```bash
# Check run details
curl https://uplink-core.codyboring.workers.dev/v1/runs/RUN_ID \
  -H "Authorization: Bearer $OPS_API_KEY"

# Check coordinator state
curl https://uplink-core.codyboring.workers.dev/internal/sources/SOURCE_ID/health \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Solutions:**

1. **Force release lease:** Trigger with `force: true`
2. **Cancel workflow:** Use Wrangler CLI to terminate instance
3. **Replay:** Use `/v1/runs/:runId/replay` to restart

```bash
# Force trigger
curl -X POST https://uplink-core.codyboring.workers.dev/v1/sources/SOURCE_ID/trigger \
  -H "Authorization: Bearer $OPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force": true, "triggeredBy": "ops", "reason": "Stuck workflow recovery"}'
```

### Issue: Alert Fatigue

**Symptoms:**
- Too many alerts firing
- Team ignoring warnings
- Critical alerts buried

**Solutions:**

1. **Tune thresholds:**
```bash
# Update source policy with better thresholds
curl -X POST https://uplink-core.codyboring.workers.dev/internal/sources \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "SOURCE_ID",
    "policy": {
      "alertConfiguration": {
        "alertRules": [
          {
            "alertType": "source_failure_rate",
            "severity": "warning",
            "threshold": 0.1,
            "windowSeconds": 300
          }
        ]
      }
    }
  }'
```

2. **Acknowledge non-actionable alerts:**
```bash
curl -X POST https://uplink-core.codyboring.workers.dev/internal/alerts/ALERT_ID/acknowledge \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

---

## How to Add a New Source

### Step 1: Gather Information

Before adding a source, collect:

- **Source type:** API, webhook, browser, file, etc.
- **Endpoint URL:** (if applicable)
- **Authentication method:** API key, OAuth, etc.
- **Rate limits:** Requests per minute/hour
- **Data volume:** Expected records per collection
- **Collection frequency:** Real-time, hourly, daily

### Step 2: Create Source Configuration

```bash
curl -X POST https://uplink-core.codyboring.workers.dev/internal/sources \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "my-new-source",
    "name": "My New Data Source",
    "type": "api",
    "status": "active",
    "adapterType": "rest-json",
    "endpointUrl": "https://api.example.com/v1/data",
    "requestMethod": "GET",
    "requestHeaders": {
      "Authorization": "Bearer ${SECRET_REF}",
      "Accept": "application/json"
    },
    "metadata": {
      "team": "engineering",
      "priority": "high",
      "dataClassification": "internal"
    },
    "policy": {
      "minIntervalSeconds": 300,
      "leaseTtlSeconds": 600,
      "maxRecordsPerRun": 1000,
      "retryLimit": 3,
      "timeoutSeconds": 60,
      "alertConfiguration": {
        "alertRules": [
          {
            "alertType": "source_failure_rate",
            "severity": "critical",
            "threshold": 0.2,
            "windowSeconds": 600
          }
        ]
      }
    }
  }'
```

### Step 3: Store Credentials (if needed)

```bash
# Using Wrangler Secrets Store (beta)
wrangler secret store create --name SRC_MY_NEW_SOURCE_KEY --value "actual-api-key"

# Or using per-Worker secrets
wrangler secret put SRC_MY_NEW_SOURCE_KEY
```

### Step 4: Test the Source

```bash
# 1. Trigger a test collection
curl -X POST https://uplink-core.codyboring.workers.dev/v1/sources/my-new-source/trigger \
  -H "Authorization: Bearer $OPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy": "setup", "reason": "Initial test"}'

# 2. Monitor the run
curl https://uplink-core.codyboring.workers.dev/v1/runs/collect:my-new-source:WORKFLOW_ID \
  -H "Authorization: Bearer $OPS_API_KEY"

# 3. Check source health
curl https://uplink-core.codyboring.workers.dev/v1/sources/my-new-source/health \
  -H "Authorization: Bearer $OPS_API_KEY"
```

### Step 5: Verify Data Flow

```bash
# Check entities were created
curl -X POST https://uplink-core.codyboring.workers.dev/internal/search/entities \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "test",
    "filter": {"sourceId": "my-new-source"},
    "topK": 10
  }'

# Verify artifact in R2 (via metadata)
curl https://uplink-core.codyboring.workers.dev/v1/artifacts/ARTIFACT_ID \
  -H "Authorization: Bearer $OPS_API_KEY"
```

### Step 6: Set Up Monitoring

```bash
# Run initial alert check
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/alerts/check?sourceId=my-new-source" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

---

## How to Replay Failed Runs

### When to Replay

- Transient network errors
- Temporary upstream outages
- Rate limit exceeded (wait then retry)
- Schema validation errors (after fix)

### When NOT to Replay

- Permanent auth failures (fix auth first)
- Data corruption at source
- Schema mismatch (update adapter first)
- Business logic errors

### Replay Methods

#### Method 1: Single Run Replay (Ops API)

```bash
# Replay a specific failed run
curl -X POST https://uplink-core.codyboring.workers.dev/v1/runs/RUN_ID/replay \
  -H "Authorization: Bearer $OPS_API_KEY"

# Response includes new replay run ID
# {
#   "ok": true,
#   "replayRunId": "replay:RUN_ID:uuid"
# }

# Monitor the replay
curl https://uplink-core.codyboring.workers.dev/v1/runs/replay:RUN_ID:uuid \
  -H "Authorization: Bearer $OPS_API_KEY"
```

#### Method 2: Bulk Retry via Error API

```bash
# List failed errors for a source
curl "https://uplink-core.codyboring.workers.dev/internal/errors?sourceId=SOURCE_ID&status=pending" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Retry specific error
curl -X POST https://uplink-core.codyboring.workers.dev/internal/errors/ERROR_ID/retry \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy": "ops-team"}'

# Force retry (bypass some checks)
curl -X POST https://uplink-core.codyboring.workers.dev/internal/errors/ERROR_ID/retry \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force": true, "triggeredBy": "ops-team"}'
```

#### Method 3: Script for Bulk Replay

```bash
#!/bin/bash
# bulk-replay.sh - Replay all failed runs from last 24 hours

SOURCE_ID=$1
API_KEY=$OPS_API_KEY
CORE_KEY=$CORE_INTERNAL_KEY

# Get failed runs
curl -s "https://uplink-core.codyboring.workers.dev/v1/runs?limit=100" \
  -H "Authorization: Bearer $API_KEY" | \
  jq -r '.runs[] | select(.status == "failed") | .run_id' | \
  while read run_id; do
    echo "Replaying $run_id..."
    curl -s -X POST "https://uplink-core.codyboring.workers.dev/v1/runs/$run_id/replay" \
      -H "Authorization: Bearer $API_KEY"
    echo ""
    sleep 1  # Rate limit replays
  done
```

### Replay Verification

```bash
# Check replay succeeded
REPLAY_RUN_ID="replay:original-run-id:uuid"

curl https://uplink-core.codyboring.workers.dev/v1/runs/$REPLAY_RUN_ID \
  -H "Authorization: Bearer $OPS_API_KEY"

# Verify no new errors
curl "https://uplink-core.codyboring.workers.dev/internal/errors?runId=$REPLAY_RUN_ID" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

---

## How to Export Data

Uplink Connect supports exporting runs, entities, and errors in JSON, CSV, or NDJSON formats.

### Export Runs

```bash
# Export last 1000 runs as CSV
curl "https://uplink-core.codyboring.workers.dev/internal/export/runs?format=csv&limit=1000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output runs.csv

# Export failed runs for a specific source as NDJSON
curl "https://uplink-core.codyboring.workers.dev/internal/export/runs?sourceId=SOURCE_ID&status=failed&format=ndjson&limit=5000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output failed-runs.ndjson

# Export runs from a date range as JSON
curl "https://uplink-core.codyboring.workers.dev/internal/export/runs?startDate=2026-04-01&endDate=2026-04-14&format=json&limit=10000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output runs.json
```

### Export Entities

```bash
# Export all entities as CSV
curl "https://uplink-core.codyboring.workers.dev/internal/export/entities?format=csv&limit=10000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output entities.csv

# Export entities for a specific source
curl "https://uplink-core.codyboring.workers.dev/internal/export/entities?sourceId=SOURCE_ID&format=ndjson&limit=5000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output source-entities.ndjson
```

### Export Errors

```bash
# Export recent errors as JSON
curl "https://uplink-core.codyboring.workers.dev/internal/export/errors?format=json&limit=1000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output errors.json

# Export errors for a specific source as CSV
curl "https://uplink-core.codyboring.workers.dev/internal/export/errors?sourceId=SOURCE_ID&format=csv&limit=5000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output source-errors.csv
```

### Export Limits

- **Default limit:** 10,000 records
- **Maximum limit:** 50,000 records
- **Formats:** `json` (default), `csv`, `ndjson`

---

## How to Monitor Health

### Dashboard Queries

#### System Overview
```bash
# Get all key metrics in one call
curl https://uplink-core.codyboring.workers.dev/internal/metrics/system \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Visual dashboard (no auth required for HTML, API needs internal key)
curl https://uplink-core.codyboring.workers.dev/dashboard
curl https://uplink-core.codyboring.workers.dev/internal/dashboard/v2 \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Pipeline topology
curl https://uplink-core.codyboring.workers.dev/internal/health/topology \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Component health
curl https://uplink-core.codyboring.workers.dev/internal/health/components \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Data flow metrics
curl https://uplink-core.codyboring.workers.dev/internal/health/flow \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

#### Per-Source Health
```bash
# All sources
curl https://uplink-core.codyboring.workers.dev/internal/metrics/sources \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Specific source
curl https://uplink-core.codyboring.workers.dev/internal/metrics/sources/SOURCE_ID \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Source health timeline
curl https://uplink-core.codyboring.workers.dev/internal/sources/SOURCE_ID/health/timeline \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Source run tree
curl https://uplink-core.codyboring.workers.dev/internal/sources/SOURCE_ID/runs/tree \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

#### Queue Health
```bash
curl https://uplink-core.codyboring.workers.dev/internal/metrics/queue \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

#### Entity and Error Health
```bash
# Entity metrics
curl https://uplink-core.codyboring.workers.dev/internal/metrics/entities \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Error list
curl "https://uplink-core.codyboring.workers.dev/internal/errors?limit=20" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Entity lineage
curl https://uplink-core.codyboring.workers.dev/internal/entities/ENTITY_ID/lineage \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Run trace
curl https://uplink-core.codyboring.workers.dev/internal/runs/RUN_ID/trace \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

### Alerting Setup

#### Built-in Alert Types

| Alert Type | Description | Default Threshold |
|------------|-------------|-------------------|
| `source_failure_rate` | % of runs failing | > 20% in 10 min |
| `queue_lag` | Messages waiting too long | > 100 messages |
| `run_stuck` | Run in collecting > 1 hour | > 60 min |
| `lease_expired` | Lease not released properly | Any occurrence |

#### Notification Channels

The alerting system supports 8 notification providers:
- `webhook` - Generic HTTP webhook
- `slack` - Slack incoming webhook
- `discord` - Discord webhook
- `teams` - Microsoft Teams webhook
- `pagerduty` - PagerDuty Events API
- `opsgenie` - OpsGenie alert API
- `email` - Email via provider
- `custom` - Custom HTTP endpoint

#### Manual Alert Check

```bash
# Check all sources
curl -X POST https://uplink-core.codyboring.workers.dev/internal/alerts/check \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check specific source
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/alerts/check?sourceId=SOURCE_ID" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

#### Alert Management

```bash
# List active alerts
curl "https://uplink-core.codyboring.workers.dev/internal/alerts?acknowledged=false" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Acknowledge (silence notifications)
curl -X POST https://uplink-core.codyboring.workers.dev/internal/alerts/ALERT_ID/acknowledge \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Resolve (when issue fixed)
curl -X POST https://uplink-core.codyboring.workers.dev/internal/alerts/ALERT_ID/resolve \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"note": "Fixed by rotating API key"}'
```

### Log Analysis

#### Cloudflare Dashboard

1. Go to Workers & Pages > uplink-core
2. Click "Logs" tab
3. Filter by:
   - Status: Error
   - Time range: Last hour
   - Search: `sourceId:my-source`

#### Wrangler CLI

```bash
# Tail logs in real-time
wrangler tail uplink-core

# Filter for errors
wrangler tail uplink-core --format json | jq 'select(.level == "error")'
```

### Key Metrics to Track

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| Success Rate | > 99% | 95-99% | < 95% |
| Avg Latency | < 2s | 2-10s | > 10s |
| Queue Depth | < 50 | 50-200 | > 200 |
| Error Rate | < 1% | 1-5% | > 5% |
| DLQ Depth | 0 | < 10 | > 10 |

### Runbook Template

Create a runbook for each source:

```markdown
## Source: [Source Name]

### Overview
- Type: [API/Webhook/Browser]
- Endpoint: [URL]
- Collection Frequency: [Interval]
- Expected Volume: [Records per run]

### Normal Operation
- Status: active
- Avg Runtime: [X] minutes
- Success Rate: > [Y]%

### Common Issues
1. [Issue 1]: [Solution]
2. [Issue 2]: [Solution]

### Escalation
- Owner: [Team/Person]
- Slack: [#channel]
- PagerDuty: [Policy]

### Quick Commands
```bash
# Check health
curl https://uplink-core.codyboring.workers.dev/v1/sources/SOURCE_ID/health ...

# Trigger manually
curl -X POST https://uplink-core.codyboring.workers.dev/v1/sources/SOURCE_ID/trigger ...
```
```

---

## Emergency Procedures

### Complete System Outage

1. **Check Cloudflare Status:** https://www.cloudflarestatus.com/
2. **Verify Worker deployments:** `wrangler deploy` for each service
3. **Check D1 connectivity:** Query from dashboard
4. **Check Queue status:** Verify queue exists and has consumers

### Data Loss Scenario

1. **Stop all ingestion:** Pause sources
2. **Assess R2 artifacts:** Raw data likely intact
3. **Replay from artifacts:** Use retention workflow
4. **Verify entity consistency:** Run reconciliation

### Security Incident

1. **Rotate all API keys:**
   ```bash
   wrangler secret put INGEST_API_KEY
   wrangler secret put OPS_API_KEY
   wrangler secret put CORE_INTERNAL_KEY
   ```
2. **Revoke source credentials:** Update in Secrets Store
3. **Audit recent runs:** Check for anomalous patterns
4. **Review access logs:** Check Cloudflare Access logs
