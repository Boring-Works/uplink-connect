# Uplink Connect - Daily Operations Runbook

**Version:** 0.1.2
**Last Updated:** 2026-04-24
**For:** Daily production operations

---

## Quick Health Check (30 seconds)

```bash
# Check all services are up
curl https://uplink-edge.codyboring.workers.dev/health
curl https://uplink-core.codyboring.workers.dev/health

# Check dashboard
curl https://uplink-core.codyboring.workers.dev/dashboard

# Check dashboard API
curl https://uplink-core.codyboring.workers.dev/internal/dashboard/v2 \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Expected:**
- `/health` returns `{"ok":true}`
- `/dashboard` returns HTML with 200 status
- `/internal/dashboard/v2` returns JSON metrics

### Live Data Sources

The following public data sources are available for testing and demonstration:

- **USGS Earthquakes (Hourly)** — `usgs-earthquakes-hourly`
  - Setup script: `./scripts/setup-public-sources.sh`
  - Verify collection:
    ```bash
    curl "https://uplink-core.codyboring.workers.dev/internal/runs?sourceId=usgs-earthquakes-hourly&limit=5" \
      -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
    ```

- **GitHub Public Events** — `github-public-events`
- **Hacker News Top Stories** — `hackernews-top-stories`
- **Exchange Rates (USD)** — `exchange-rates-daily`
- **NWS Tennessee Weather** — `nws-weather-tn`

**Note:** Use manual triggers or configure schedules via `/scheduler`. Auto-triggers are driven by the dynamic scheduler, not hard-coded.

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

### 4. Check Component Health
```bash
curl https://uplink-core.codyboring.workers.dev/internal/health/components \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

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
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/sources/{sourceId}/trigger" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"triggeredBy":"ops","reason":"Unpause after fix"}'
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

# Check run trace
curl "https://uplink-core.codyboring.workers.dev/internal/runs/{runId}/trace" \
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

### Issue: Dashboard Not Updating

**Symptoms:**
- Dashboard shows stale data
- "Connecting to real-time updates..." persists

**Investigation:**
```bash
# Check dashboard API directly
curl https://uplink-core.codyboring.workers.dev/internal/dashboard/v2 \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check if WebSocket endpoint is accessible
# (Should upgrade to WebSocket, not return HTML)
curl -i "https://uplink-core.codyboring.workers.dev/internal/stream/dashboard" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Resolution:**
- Dashboard auto-refreshes every 30 seconds as fallback
- WebSocket issues usually resolve on reconnect
- Check that `DASHBOARD_STREAM` DO binding is configured
- If persistent: Redeploy uplink-core

---

### Issue: Need to Export Data

**Export runs:**
```bash
curl "https://uplink-core.codyboring.workers.dev/internal/export/runs?format=csv&limit=1000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output runs.csv
```

**Export entities:**
```bash
curl "https://uplink-core.codyboring.workers.dev/internal/export/entities?format=ndjson&limit=1000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output entities.ndjson
```

**Export errors:**
```bash
curl "https://uplink-core.codyboring.workers.dev/internal/export/errors?format=json&limit=1000" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY" \
  --output errors.json
```

---

### Issue: Error Agent Not Responding

**Symptoms:**
- WebSocket connection to error agent fails
- No AI diagnosis received

**Investigation:**
```bash
# Check if endpoint is accessible
curl -i "https://uplink-core.codyboring.workers.dev/internal/agent/error" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"
```

**Resolution:**
- Ensure `ERROR_AGENT` DO binding is in wrangler.jsonc
- Check that v4 migration was applied
- Verify Workers AI is available in the account
- If persistent: Redeploy uplink-core

---

### Issue: Dashboard Auth Loop (JSON POSTs Return 401)

**Symptoms:**
- API clients sending JSON to core endpoints get stuck in 401 loop
- Dashboard password gate appears even for non-dashboard requests
- Error logs show "Invalid form data" from `dashboard-auth.ts`

**Root Cause:**
- `dashboard-auth.ts` attempted to parse ALL POST requests as form data
- JSON POSTs threw on `request.formData()`, fell through to password gate

**Status:** ✅ Fixed April 24 — body parsing now content-type gated

**Verification:**
```bash
# Should return 401 (not HTML password gate)
curl -X POST https://uplink-core.codyboring.workers.dev/internal/runs \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
```

---

### Issue: Infinite DLQ Retry Loop

**Symptoms:**
- Same message retried indefinitely
- Queue metrics show high retry count on single message
- Error logs show repeated "DLQ send failed" but message never acked

**Root Cause:**
- `sendToDlq()` could throw if queue binding failed or network error
- Uncaught exception prevented `message.ack()`, causing re-delivery

**Status:** ✅ Fixed April 24 — DLQ sends wrapped in try/catch with fallback ack

**If Seen:**
- Check `wrangler logs` for "DLQ send failed, acking to prevent loop"
- Verify DLQ queue binding is configured in wrangler.jsonc
- Message will be lost if DLQ itself is unavailable (by design — prevents worse looping)

---

### Issue: Ops Proxy Returns 500 / Internal Errors

**Symptoms:**
- Ops API calls return 500 with "CORE_INTERNAL_KEY not configured"
- Proxy requests reach core without `x-uplink-internal-key` header
- Internal endpoints return 401 despite ops being configured

**Root Cause:**
- `proxyToCore()` did not verify `CORE_INTERNAL_KEY` env var was set
- Missing secret caused empty auth header to be forwarded

**Status:** ✅ Fixed April 24 — fails closed with 500 if secret missing

**Resolution:**
```bash
# Verify secret is set
npx wrangler secret list --name uplink-ops

# If missing, set it:
npx wrangler secret put CORE_INTERNAL_KEY --name uplink-ops
```

---

## Emergency Procedures

### Deployment Rate Limiting (Code 10429)

**Symptoms:**
- `wrangler deploy` fails with "Rate limited" (code 10429)
- Multiple parallel deployments hit Cloudflare API limits
- "Max auth failures reached" (code 9109) from rapid retry

**Resolution:**
```bash
# Deploy sequentially with delays, not in parallel
for app in uplink-core uplink-edge uplink-ops uplink-browser; do
  echo "Deploying $app..."
  sleep 10
  cd "apps/$app" && npx wrangler deploy && cd ../..
done
```

**Prevention:**
- Use sequential deploys in CI/CD (not parallel)
- Add `sleep 10` between worker deployments
- Use `wrangler deploy --keep-vars` to preserve existing secrets

---

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
- [ ] Dashboard loads correctly

### Weekly (Monday)
- [ ] Review error rates by source
- [ ] Check for sources with >10% failure rate
- [ ] Review retention workflow ran successfully
- [ ] Check R2 storage growth
- [ ] Review and acknowledge any lingering warnings
- [ ] Test WebSocket dashboard connection

### Monthly
- [ ] Review all source configs for accuracy
- [ ] Check for unused sources (no runs in 30 days)
- [ ] Review metrics trends
- [ ] Update secrets if needed (rotation)
- [ ] Review and update this runbook
- [ ] Verify export API works end-to-end

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

# Notification delivery status
npx wrangler d1 execute uplink-control --remote --command "SELECT provider, status, COUNT(*) as count FROM notification_deliveries WHERE created_at > unixepoch() - 86400 GROUP BY provider, status"
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

# Run alert check
curl -X POST "https://uplink-core.codyboring.workers.dev/internal/alerts/check" \
  -H "x-uplink-internal-key: $CORE_INTERNAL_KEY"

# Check pipeline topology
curl "https://uplink-core.codyboring.workers.dev/internal/health/topology" \
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

- **2026-04-14 v0.2.1**: Added WebSocket dashboard, RAG error agent, data export API, export commands, error agent troubleshooting
- **2026-04-13 v0.2.0**: Added BrowserManagerDO, backpressure, structured logging, dashboard endpoint, graceful degradation
- **2026-04-13 v0.1.0**: Initial production deployment
