# Uplink Connect Infrastructure

This directory contains infrastructure templates and deployment configurations for Uplink Connect.

## Architecture

Uplink Connect is deployed as 4 interconnected Cloudflare Workers:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ uplink-edge │────▶│ uplink-core │────▶│uplink-browser│
│  (public)   │     │  (internal) │     │  (internal)  │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  uplink-ops │
                    │  (internal) │
                    └─────────────┘
```

### Worker Responsibilities

| Worker | Purpose | Public |
|--------|---------|--------|
| `uplink-edge` | Ingest API, source triggers | Yes |
| `uplink-core` | Queue processing, workflows, D1, R2 | Yes (workers_dev) |
| `uplink-browser` | Browser rendering service | No |
| `uplink-ops` | Operations proxy API | No (internal only via service bindings) |

## Cloudflare Resources

### D1 Database
- **Name**: `uplink-control`
- **Purpose**: Operational truth for runs, sources, artifacts
- **Migrations**: `apps/uplink-core/migrations/`

### R2 Bucket
- **Name**: `uplink-raw`
- **Purpose**: Immutable raw payload storage

### Queues
- **uplink-ingest**: Main ingest queue
- **uplink-ingest-dlq**: Dead letter queue

### Vectorize Index
- **Name**: `uplink-entities`
- **Dimensions**: 384 (gte-small embeddings)
- **Metric**: Cosine

### Analytics Engine
- **Dataset**: `uplink-ops`
- **Purpose**: Operational metrics

## Deployment

### First-time Setup

```bash
# Run bootstrap to create all resources
./scripts/bootstrap.sh

# Or step by step:
./scripts/bootstrap.sh --resources  # Create CF resources
./scripts/bootstrap.sh --secrets    # Set secrets
./scripts/bootstrap.sh --env        # Create env files
```

### Deploy

```bash
# Full deployment
./scripts/deploy.sh

# Deploy specific components:
./scripts/deploy.sh --resources  # Resources only
./scripts/deploy.sh --workers    # Workers only
./scripts/deploy.sh --health     # Health checks only
```

### Smoke Tests

```bash
# Run all smoke tests
./scripts/smoke-test.sh

# Test specific components:
./scripts/smoke-test.sh --health  # Health endpoints
./scripts/smoke-test.sh --intake  # Intake flow
./scripts/smoke-test.sh --ops     # Ops API
```

## Required Secrets

Set these via `wrangler secret put`:

| Secret | Workers | Purpose |
|--------|---------|---------|
| `INGEST_API_KEY` | uplink-edge | Auth for /v1/intake |
| `OPS_API_KEY` | uplink-ops | Auth for ops API |
| `BROWSER_API_KEY` | uplink-browser | Auth for browser service |
| `CORE_INTERNAL_KEY` | uplink-edge, uplink-core, uplink-ops | Internal service auth |

Generate strong keys:
```bash
openssl rand -base64 32
```

## Environment Files

### .env (root)
Local development environment variables. Not committed to git.

### .dev.vars (root)
Secrets for `wrangler dev`. Not committed to git.

## Templates

The `wrangler.*.template.jsonc` files are the source of truth for worker configurations. During bootstrap, these are copied to each app's directory. Modify templates and re-run bootstrap to update configurations.

## Custom Domains

To use custom domains instead of workers.dev:

1. Add routes to wrangler.jsonc:
```jsonc
{
  "routes": [
    { "pattern": "edge.your-domain.com/*", "zone_name": "your-domain.com" }
  ]
}
```

2. Update smoke test URLs:
```bash
export UPLINK_EDGE_URL=https://edge.your-domain.com
export UPLINK_CORE_URL=https://core.your-domain.com
./scripts/smoke-test.sh
```

## Troubleshooting

### Workers not communicating
- Check service bindings are configured correctly
- Verify `CORE_INTERNAL_KEY` is set on all workers
- Check logs: `wrangler tail --name uplink-core`

### D1 migrations failing
- Ensure database exists: `wrangler d1 list`
- Check migrations directory path in wrangler.jsonc
- Run manually: `wrangler d1 migrations apply uplink-control --remote`

### Queue not processing
- Verify queue exists: `wrangler queues list`
- Check consumer is attached: `wrangler queues list`
- Check uplink-core logs for errors

### Vectorize not working
- Verify index exists: `wrangler vectorize list`
- Check dimensions match (384 for gte-small)
- Feature may need enabling in Cloudflare dashboard

## Scripts Reference

| Script | Purpose |
|--------|---------|
| `bootstrap.sh` | First-time setup |
| `deploy.sh` | Deploy workers and resources |
| `smoke-test.sh` | Post-deploy validation |

All scripts are idempotent - safe to run multiple times.
