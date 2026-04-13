# Uplink Connect - Daily Operations Runbook

**Version:** 0.2.0  
**Last Updated:** 2026-04-13  
**For:** Daily production operations

---

## Quick Health Check (30 seconds)

```bash
# Check all services are up
curl https://uplink-edge.codyboring.workers.dev/health
curl https://uplink-core.codyboring.workers.dev/health

# Check dashboard
curl https://uplink-core.codyboring.workers.dev/internal/dashboard \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Expected:** All return `{"ok":true}`

---

## Morning Routine (5 minutes)

### 1. Check Active Alerts
```bash
curl https://uplink-core.codyboring.workers.dev/internal/alerts \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Action if alerts present:**
- Critical alerts → Investigate immediately
- Warning alerts → Check if trending worse

### 2. Review Last 24h Runs
```bash
curl "https://uplink-core.codyboring.workers.dev/internal/runs?limit=20" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Look for:**
- Failed runs (status = "failed")
- Stuck runs (status = "collecting" or "enqueued" for >1 hour)
- Unusual error patterns

### 3. Check Queue Depth
```bash
curl https://uplink-core.codyboring.workers.dev/internal/metrics/queue \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Thresholds:**
- < 100 messages: Healthy
- 100-1000: Monitor closely
- > 1000: Investigate processing bottleneck

---

## Common Issues & Quick Fixes

### Issue: Source Auto-Paused (Consecutive Failures)

**Symptoms:**
- Dashboard shows source status as "paused"
- Alert: "Source paused after N consecutive failures"
- New triggers return 409 with "Source paused" message

**Investigation:**
```bash
# Check source health
curl "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/health" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# View recent errors
curl "https://uplink-core.codyboring.workers.dev/internal/errors?sourceId={sourceId}&limit=10" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Resolution:**

1. **If root cause fixed:**
```bash
# Unpause source via coordinator DO
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/unpause" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

2. **If need to force trigger anyway:**
```bash
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/trigger" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy":"ops","force":true}'
```

---

### Issue: High Queue Lag

**Symptoms:**
- Queue metrics show lag_seconds > 60
- Messages backing up
- Processing delay increasing

**Investigation:**
```bash
# Check queue metrics
curl https://uplink-core.codyboring.workers.dev/internal/metrics/queue \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check system metrics
curl https://uplink-core.codyboring.workers.dev/internal/metrics/system \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Common Causes & Fixes:**

1. **D1 Slowdown:**
   - Check if D1 is experiencing high latency
   - Usually resolves automatically (retry logic handles it)
   - If persistent: Check Cloudflare status page

2. **Circuit Breaker Open:**
   - Check logs for "Circuit breaker open" messages
   - Wait 30 seconds for auto-reset
   - If stuck: May need to restart worker (rare)

3. **External Service Down (R2/Vectorize):**
   - Check Cloudflare status page
   - System degrades gracefully (continues without optional services)
   - No action needed - will auto-recover

---

### Issue: Run Stuck In "collecting" or "enqueued"

**Symptoms:**
- Run status hasn't changed for >1 hour
- No recent updates to run record

**Investigation:**
```bash
# Get run details
curl "https://uplink-core.codyboring.workers.dev/internal/runs/{runId}" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check source coordinator state
curl "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/health" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Resolution:**

1. **If lease expired (coordinator shows no active lease):**
   - Safe to replay the run
   ```bash
   curl -X POST "https://uplink-core.codyboring.workers.dev/internal/runs/{runId}/replay" \
     -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
   ```

2. **If workflow instance stuck:**
   - Check workflow instances in Cloudflare dashboard
   - May need to terminate and replay

---

### Issue: Browser Collection Failing

**Symptoms:**
- Browser sources failing
- "Browser collector failed" errors

**Investigation:**
```bash
# Check browser manager status
curl https://uplink-core.codyboring.workers.dev/internal/browser/status \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Resolution:**

1. **If all sessions busy:**
   - Normal backpressure - will queue and process
   - Check if queue is growing (indicates real bottleneck)

2. **If sessions in "error" state:**
   - Browser Rendering service may be experiencing issues
   - Check Cloudflare status page
   - Sessions auto-cleanup after errors

3. **Force cleanup if needed:**
   ```bash
   curl -X POST "https://uplink-core.codyboring.workers.dev/internal/browser/admin/cleanup" \
     -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
   ```

---

### Issue: Vector Search Not Working

**Symptoms:**
- Search endpoint returns empty results
- "Vectorize indexing failed" in logs

**Investigation:**
```bash
# Check if Vectorize is responding
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/search/entities" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'
```

**Resolution:**
- Vectorize failures are non-blocking
- Ingest continues, just without semantic search
- Usually auto-resolves when Vectorize recovers
- If persistent: Check Cloudflare status page

---

## Emergency Procedures

### Complete System Outage

**Symptoms:** All health checks failing

**Immediate Actions:**
1. Check Cloudflare Workers status page
2. Check if secrets are valid (rarely expires)
3. Verify D1 database is accessible

**Recovery:**
```bash
# Redeploy if needed
cd apps/uplink-core && npx wrangler deploy
cd apps/uplink-edge && npx wrangler deploy
cd apps/uplink-ops && npx wrangler deploy
cd apps/uplink-browser && npx wrangler deploy
```

### Data Loss Concern

**Check R2 for artifacts:**
```bash
# List recent artifacts
npx wrangler r2 object list uplink-raw --prefix "raw/" --limit 20
```

**Check D1 for runs:**
```bash
npx wrangler d1 execute uplink-control --remote --command "SELECT run_id, status, created_at FROM ingest_runs ORDER BY created_at DESC LIMIT 20"
```

---

## Performance Tuning

### If Processing Too Slow

1. **Increase batch size** (in wrangler.jsonc):
   ```json
   "max_batch_size": 20  // up from 10
   ```

2. **Check for slow sources:**
   ```bash
   curl "https://uplink-core.codyboring.workers.dev/internal/metrics/sources?window=3600" \
     -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
   ```

### If Source Triggering Too Frequently

**Check backpressure settings:**
- Default min interval: 5 seconds
- If hitting rate limits, source may be misconfigured

**Adjust source policy:**
```bash
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "{sourceId}",
    "name": "Source Name",
    "type": "api",
    "adapterType": "api",
    "policy": {
      "minIntervalSeconds": 300,  // Increase from 60
      "leaseTtlSeconds": 300,
      "maxRecordsPerRun": 1000,
      "retryLimit": 3
    }
  }'
```

---

## Monitoring Checklist

### Daily (Morning)
- [ ] Health checks pass
- [ ] No critical alerts
- [ ] Queue depth < 1000
- [ ] Recent runs processing normally
- [ ] No sources stuck paused

### Weekly (Monday)
- [ ] Review error rates by source
- [ ] Check for sources with >10% failure rate
- [ ] Review retention workflow ran successfully
- [ ] Check R2 storage growth
- [ ] Review and acknowledge any lingering warnings

### Monthly
- [ ] Review all source configs for accuracy
- [ ] Check for unused sources (no runs in 30 days)
- [ ] Review metrics trends
- [ ] Update secrets if needed (rotation)
- [ ] Review and update this runbook

---

## Useful Commands Reference

### Check Service Logs
```bash
# Real-time tail
npx wrangler tail --name uplink-core

# Filter for errors
npx wrangler tail --name uplink-core --format pretty | grep "ERROR"
```

### Database Queries

```bash
# Recent failed runs
npx wrangler d1 execute uplink-control --remote --command "SELECT run_id, source_id, status, error_count, created_at FROM ingest_runs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10"

# Source health summary
npx wrangler d1 execute uplink-control --remote --command "SELECT s.source_id, s.name, s.status, COUNT(r.run_id) as run_count FROM source_configs s LEFT JOIN ingest_runs r ON s.source_id = r.source_id AND r.created_at > unixepoch() - 86400 GROUP BY s.source_id"

# Error summary by category
npx wrangler d1 execute uplink-control --remote --command "SELECT error_category, COUNT(*) as count FROM ingest_errors WHERE created_at > unixepoch() - 86400 GROUP BY error_category ORDER BY count DESC"
```

### Manual Operations

```bash
# Trigger source manually
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/trigger" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy":"manual","reason":"Ops intervention"}'

# Replay failed run
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/runs/{runId}/replay" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Acknowledge alert
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/alerts/{alertId}/acknowledge" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

---

## Escalation

**If issue cannot be resolved using this runbook:**

1. Check Cloudflare Status: https://www.cloudflarestatus.com/
2. Review Workers docs: https://developers.cloudflare.com/workers/
3. Check D1 docs: https://developers.cloudflare.com/d1/
4. File support ticket if Cloudflare service issue suspected

---

## Change Log

- **2026-04-13 v0.2.0**: Added BrowserManagerDO, backpressure, structured logging, dashboard endpoint, graceful degradation
- **2026-04-13 v0.1.0**: Initial production deployment
