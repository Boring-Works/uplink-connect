# Uplink Core Integration Tests

Integration tests for the Uplink Core service using `@cloudflare/vitest-pool-workers`.

## Test Structure

```
src/test/integration/
├── vitest.config.ts          # Vitest configuration with pool-workers
├── wrangler.jsonc            # Test-specific wrangler config
├── worker.ts                 # Test worker entry point
├── setup.ts                  # Test setup/teardown + D1 migration bootstrap
├── fixtures.ts               # Test data factories and helpers
├── types.d.ts                # Type declarations for cloudflare:test
├── ingest.test.ts            # Ingest flow tests
├── source-coordinator.test.ts # Source coordinator tests
├── workflow.test.ts          # Collection workflow tests
├── replay-upsert.test.ts     # Replay guards + run conflict upsert tests
└── retry-recovery.test.ts    # Manual retry reconstruction tests
```

## Running Tests

```bash
# Run all integration tests
pnpm test

# Run with watch mode
pnpm test:watch

# Run from root
pnpm --filter @uplink/core test
```

## Test Coverage

### Ingest Tests (`ingest.test.ts`)
- Full ingest flow: intake -> queue -> processing -> D1 + R2
- Idempotency (same ingestId twice)
- Error handling and retry
- Multiple records in single envelope

### Source Coordinator Tests (`source-coordinator.test.ts`)
- Lease acquire/release
- Concurrent lease attempts
- Cursor advancement
- Success/failure recording
- State persistence across restarts

### Workflow Tests (`workflow.test.ts`)
- CollectionWorkflow execution
- Source trigger -> workflow -> ingest flow
- API endpoint testing
- Concurrent trigger handling

### Replay/Upsert Tests (`replay-upsert.test.ts`)
- Replay blocked for in-progress and placeholder runs
- Replay blocked for invalid stored envelope JSON
- Placeholder run conflict replacement behavior
- Terminal run protection against overwrite

### Retry Recovery Tests (`retry-recovery.test.ts`)
- Retry from queue message payload
- Retry from raw envelope payload
- Retry fallback to stored run envelope when payload is invalid

## Test Environment

Tests run inside the Workers runtime with real bindings:
- D1: SQLite database for control plane
- R2: Object storage for raw artifacts
- Queues: Message queue for ingest pipeline
- Durable Objects: Source coordinator state
- Workflows: Collection workflow execution

## Configuration

The `wrangler.jsonc` defines test-specific bindings:
- Separate database/bucket names to avoid conflicts
- Shorter lease TTLs for faster tests
- Test queue names

`setup.ts` applies all local SQL migrations once per test runtime so schema-dependent tests
run against the current control-plane schema.

## Fixtures

Use the fixture utilities in `fixtures.ts` for consistent test data:

```typescript
import { createTestIngestEnvelope, createTestSourceConfig } from "./fixtures";

const envelope = createTestIngestEnvelope({ recordCount: 5 });
const source = createTestSourceConfig({ status: "active" });
```
