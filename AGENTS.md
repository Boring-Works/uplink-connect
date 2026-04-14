# Uplink Connect - Agent Instructions

## Project Overview

Uplink Connect is a **Cloudflare-native data ingestion platform** built for reliability, observability, and scale. It handles everything from simple webhook intake to complex browser-based collection workflows.

**Repository:** https://github.com/Boring-Works/uplink-connect  
**Live Deployment:** https://uplink-core.codyboring.workers.dev  
**Dashboard:** https://uplink-core.codyboring.workers.dev/dashboard  
**License:** MIT

---

## Quick Reference

### Stack
- **Tier:** Boring Stack Tier 3 (Cloudflare Workers bare)
- **Language:** TypeScript 5.8+ (strict mode)
- **Package Manager:** pnpm 10.6+
- **Runtime:** Cloudflare Workers

### Services
| Service | Purpose | URL |
|---------|---------|-----|
| uplink-edge | Public intake API | https://uplink-edge.codyboring.workers.dev |
| uplink-core | Processing, DO, workflows | https://uplink-core.codyboring.workers.dev |
| uplink-ops | Protected operations | (internal only) |
| uplink-browser | Browser collection | (internal only) |

### Key Technologies
- **Durable Objects** - Per-source coordination (leases, cursors)
- **Workflows** - Multi-step collection with retries
- **Queues** - Async processing with DLQ
- **D1** - Operational data (sources, runs, entities)
- **R2** - Raw artifact storage
- **Vectorize** - Semantic entity search
- **Analytics Engine** - Metrics and observability

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Type check
pnpm typecheck

# Build packages
pnpm build

# Run tests
pnpm test                          # Unit tests
pnpm test:watch                    # Watch mode
pnpm vitest run --config vitest.live.config.ts  # Live tests

# Development (run in separate terminals)
pnpm dev:edge      # Terminal 1
pnpm dev:core      # Terminal 2
pnpm dev:browser   # Terminal 3
pnpm dev:ops       # Terminal 4

# Deployment
./scripts/deploy.sh
./scripts/bootstrap.sh --secrets
./scripts/smoke-test.sh
```

---

## Architecture

```
                    Uplink Connect Architecture

    Public Edge          Coordination           Processing
    ┌─────────┐         ┌────────────┐        ┌──────────┐
    │  edge   │────────▶│     DO     │───────▶│   core   │
    │  Worker │  queue  │Coordinator │        │  Worker  │
    └─────────┘         └────────────┘        └────┬─────┘
         │                                           │
         │         Async Queue    ┌─────────┐       │
         └───────────────────────▶│  Queue  │◀──────┘
                                  │Consumer │
                                  └────┬────┘
                                       │
           ┌──────────┬────────┬──────┴──────┬──────────┐
           ▼          ▼        ▼             ▼          ▼
        ┌─────┐   ┌─────┐  ┌─────┐      ┌────────┐  ┌────────┐
        │ D1  │   │ R2  │  │  AE │      │Vectorize│  │Workflow│
        │     │   │     │  │     │      │        │  │        │
        └─────┘   └─────┘  └─────┘      └────────┘  └────────┘
```

---

## Key Files

### Application Entry Points
- `apps/uplink-edge/src/index.ts` - Public API (intake, triggers)
- `apps/uplink-core/src/index.ts` - Core processing (40+ endpoints)
- `apps/uplink-ops/src/index.ts` - Protected ops proxy
- `apps/uplink-browser/src/index.ts` - Browser collection

### Critical Libraries
- `apps/uplink-core/src/lib/db.ts` - All D1 operations
- `apps/uplink-core/src/lib/processing.ts` - Queue batch processing
- `apps/uplink-core/src/lib/alerting.ts` - Alert system
- `apps/uplink-core/src/lib/health-monitor.ts` - Health monitoring
- `apps/uplink-core/src/durable/source-coordinator.ts` - DO implementation
- `apps/uplink-core/src/workflows/collection-workflow.ts` - Collection workflow

### Shared Packages
- `packages/contracts/src/index.ts` - Zod schemas, types
- `packages/source-adapters/src/index.ts` - API, webhook, browser adapters
- `packages/normalizers/src/index.ts` - Entity normalization

### Database
- `apps/uplink-core/migrations/*.sql` - 8 migration files

---

## Coding Standards

### TypeScript
- Strict mode enabled
- No implicit any
- Explicit return types on exports
- Branded types for IDs (`type RunId = string & { __brand: "RunId" }`)

### Style
- Tabs for indentation
- 100 character line width
- Biome for lint/format (not eslint/prettier)
- No em-dashes in writing

### Patterns
- Durable Objects for per-source state
- Deterministic IDs for idempotency
- Structured logging (JSON)
- Integer cents for money (never float)

### Testing
- Vitest with @cloudflare/vitest-pool-workers
- 500+ tests across unit, integration, e2e, live
- Tests run in actual Workers runtime

---

## Data Flow

1. **Intake** - Data enters via `/v1/intake` (edge)
2. **Queue** - Envelope queued for async processing
3. **Process** - Core worker normalizes and persists
4. **Store** - Raw artifacts → R2, entities → D1
5. **Index** - Vector embeddings for search
6. **Observe** - Metrics emitted to Analytics Engine

---

## Environment Variables

### Required for Development
Create `.dev.vars` in each app directory:

**apps/uplink-edge/.dev.vars:**
```
INGEST_API_KEY=dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

**apps/uplink-core/.dev.vars:**
```
CORE_INTERNAL_KEY=internal-dev-key
BROWSER_API_KEY=browser-dev-key
```

**apps/uplink-ops/.dev.vars:**
```
OPS_API_KEY=ops-dev-key-change-in-production
CORE_INTERNAL_KEY=internal-dev-key
```

**apps/uplink-browser/.dev.vars:**
```
BROWSER_API_KEY=browser-dev-key
```

---

## Common Tasks

### Add a New Endpoint
1. Add route in `apps/uplink-core/src/index.ts`
2. Add Zod schema in `packages/contracts/src/index.ts` if needed
3. Add DB function in `apps/uplink-core/src/lib/db.ts` if needed
4. Add tests
5. Update API.md documentation

### Add a Database Migration
1. Create `apps/uplink-core/migrations/000X_description.sql`
2. Apply locally: `wrangler d1 migrations apply uplink-control --local`
3. Apply remotely: `wrangler d1 migrations apply uplink-control --remote`

### Run Live Tests
```bash
cd apps/uplink-core
export UPLINK_LIVE_INGEST_API_KEY="your-key"
export UPLINK_LIVE_INTERNAL_KEY="your-key"
export UPLINK_LIVE_OPS_API_KEY="your-key"
pnpm vitest run --config vitest.live.config.ts
```

---

## Troubleshooting

### Common Issues

**Tests failing with D1 errors:**
- Run migrations: `wrangler d1 migrations apply uplink-control --local`

**Type errors after changes:**
- Run `pnpm typecheck` to see all errors
- Check `packages/contracts/src/index.ts` for schema changes

**Deployment fails:**
- Check `wrangler.jsonc` for missing bindings
- Verify secrets are set: `wrangler secret list`

**Dashboard shows zeros:**
- Normal if no data ingested
- Check `/internal/dashboard/v2` with internal key

---

## Documentation

| Document | Purpose |
|----------|---------|
| README.md | Main project overview |
| API.md | Complete API reference |
| CLAUDE.md | Detailed stack/agent info |
| OPERATIONS.md | Runbooks and procedures |
| ROADMAP.md | Development planning |
| RUNBOOK.md | Incident response |
| METRICS_ALERTING.md | Observability guide |
| CHANGELOG.md | Release notes |
| AUDIT_REPORT.md | Previous audit results |

---

## Deployment Order

1. **uplink-core** (foundational, has DO and Workflows)
2. **uplink-browser** (internal dependency)
3. **uplink-edge** (public API)
4. **uplink-ops** (protected ops)

---

## Security Notes

- Never commit `.dev.vars` files
- Never log secrets or API keys
- Internal endpoints require `x-uplink-internal-key` header
- External endpoints require Bearer token auth
- All secrets managed via `wrangler secret`

---

## Contact

- **Author:** BoringWorks
- **Repository:** https://github.com/Boring-Works/uplink-connect
- **Issues:** Use GitHub Issues

---

## Last Updated

April 13, 2026 - v0.1.0 production release
