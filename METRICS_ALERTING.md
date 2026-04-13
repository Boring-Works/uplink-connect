# Metrics and Alerting Infrastructure for Uplink Connect

This document summarizes the comprehensive metrics and alerting infrastructure added to Uplink Connect.

## Files Created

### 1. `apps/uplink-core/src/lib/alerting.ts`
Core alerting engine with:
- **Alert Types**: `source_failure_rate`, `queue_lag`, `run_stuck`, `lease_expired`
- **Severity Levels**: `warning`, `critical`
- **Alert Deduplication**: Uses unique `dedup_key` per alert type/severity/source/run combination
- **Default Alert Rules**:
  - Source failure rate: warning at 10%, critical at 30% (5min window)
  - Queue lag: warning at 60s, critical at 300s
  - Run stuck: warning at 10min, critical at 30min
  - Lease expired: critical (immediate)

**Key Functions**:
- `listActiveAlerts()` - Query active alerts with filters
- `createAlert()` - Create new alert with deduplication
- `acknowledgeAlert()` - Mark alert as acknowledged
- `resolveAlert()` - Move alert to history
- `runAllAlertChecks()` - Evaluate all alert rules
- `autoResolveAlerts()` - Auto-resolve cleared conditions

### 2. `apps/uplink-core/migrations/0005_alerting_metrics.sql`
Database migration adding:
- `alert_config_json` column to `source_policies` table
- `alerts_active` table with deduplication support
- `alerts_history` table for resolved alerts
- `source_metrics_5min` table for time-series metrics
- `source_metrics_daily` table for daily rollups

### 3. Updated `apps/uplink-core/src/lib/metrics.ts`
Comprehensive metrics aggregation:
- `writeMetric()` - Base metric writer to Analytics Engine
- `writeIngestMetrics()` - Per-ingest success/failure/latency/error rates
- `writeQueueMetrics()` - Queue lag and pending counts
- `writeEntityMetrics()` - Entity creation/update tracking
- `writeCoordinatorMetrics()` - Lease/cursor lifecycle events
- `getPerSourceMetrics()` - Per-source success/failure rates
- `getAllSourceMetrics()` - All sources metrics
- `getQueueMetrics()` - Queue lag and pending counts
- `getEntityMetrics()` - Entity counts by source
- `getSystemMetrics()` - System-wide overview
- `aggregateMetricsWindow()` - 5-minute window aggregation

## API Endpoints Added

### Alert Endpoints
- `GET /internal/alerts` - List active alerts with filters (severity, type, sourceId, acknowledged)
- `POST /internal/alerts/check` - Trigger alert evaluation
- `POST /internal/alerts/:alertId/acknowledge` - Acknowledge an alert
- `POST /internal/alerts/:alertId/resolve` - Resolve an alert with optional note

### Metrics Endpoints
- `GET /internal/metrics/system` - System-wide metrics (sources, runs, entities, alerts)
- `GET /internal/metrics/sources` - All sources metrics (configurable window)
- `GET /internal/metrics/sources/:sourceId` - Per-source detailed metrics
- `GET /internal/metrics/queue` - Queue lag and pending counts
- `GET /internal/metrics/entities` - Entity creation rates by source

## Alert Configuration

Alerts can be configured per-source via the `alertConfiguration` field in `SourcePolicy`:

```typescript
{
  alertRules: [
    {
      alertType: "source_failure_rate",
      severity: "critical",
      threshold: 0.25,  // 25% failure rate
      windowSeconds: 300,
      enabled: true
    }
  ],
  notificationChannels: {
    webhook: "https://hooks.slack.com/...",
    email: ["ops@example.com"]
  }
}
```

Default rules are used when no configuration is provided.

## Actionable Alerts

All alerts include:
- `sourceId` - Affected source (when applicable)
- `runId` - Affected run (when applicable)
- `recommendedAction` - Specific guidance based on alert type and severity

Example recommended actions:
- **Source failure rate (warning)**: Monitor source health, check error logs
- **Source failure rate (critical)**: Investigate immediately, consider pausing source
- **Queue lag (warning)**: Scale workers, check bottlenecks
- **Queue lag (critical)**: Emergency scale-up, consider load shedding
- **Run stuck (warning)**: Check workflow status, may need manual intervention
- **Run stuck (critical)**: Force-release lease, trigger recovery
- **Lease expired**: Force-release lease, check coordinator health

## Integration Points

### Processing Pipeline (`processing.ts`)
- Tracks processing time for each ingest
- Writes success/failure metrics with latency
- Tracks entity creation rates

### Source Coordinator (`source-coordinator.ts`)
- Emits metrics for lease acquire/release
- Tracks cursor advances
- Records success/failure with consecutive failure count

### Analytics Engine
All metrics are written to `OPS_METRICS` Analytics Engine dataset with:
- Blobs: sourceId, sourceType, event name, metadata JSON
- Doubles: metric value
- Indexes: runId or unique identifier

## Usage Examples

### Check All Alerts
```bash
curl -X POST http://localhost:8787/internal/alerts/check \
  -H "Authorization: Bearer $CORE_INTERNAL_KEY"
```

### Check Source-Specific Alerts
```bash
curl -X POST "http://localhost:8787/internal/alerts/check?sourceId=my-source" \
  -H "Authorization: Bearer $CORE_INTERNAL_KEY"
```

### Get System Metrics
```bash
curl http://localhost:8787/internal/metrics/system \
  -H "Authorization: Bearer $CORE_INTERNAL_KEY"
```

### Get Per-Source Metrics (last hour)
```bash
curl "http://localhost:8787/internal/metrics/sources/my-source?window=3600" \
  -H "Authorization: Bearer $CORE_INTERNAL_KEY"
```

### List Critical Unacknowledged Alerts
```bash
curl "http://localhost:8787/internal/alerts?severity=critical&acknowledged=false" \
  -H "Authorization: Bearer $CORE_INTERNAL_KEY"
```

## Migration

Apply the migration:
```bash
cd apps/uplink-core
pnpm run d1:migrate:local   # For local dev
pnpm run d1:migrate:remote  # For production
```

## Future Enhancements

- Webhook notifications for critical alerts
- Alert suppression windows (maintenance mode)
- Metric-based auto-scaling triggers
- Custom alert rule DSL
- Alert correlation and grouping
