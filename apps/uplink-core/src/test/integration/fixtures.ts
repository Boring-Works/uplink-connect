/**
 * Test Fixtures and Helpers
 *
 * Shared utilities for integration tests
 */

import { ulid, toIsoNow, type IngestEnvelope, type SourceConfig } from "@uplink/contracts";

// Test data factories
export function createTestIngestEnvelope(overrides: {
	ingestId?: string;
	sourceId?: string;
	sourceName?: string;
	sourceType?: "api" | "webhook" | "browser" | "manual";
	recordCount?: number;
	hasMore?: boolean;
	nextCursor?: string;
} = {}): IngestEnvelope {
	const now = toIsoNow();
	const ingestId = overrides.ingestId ?? `test-${ulid()}`;
	const sourceId = overrides.sourceId ?? `source-${ulid()}`;

	return {
		schemaVersion: "1.0",
		ingestId,
		sourceId,
		sourceName: overrides.sourceName ?? `Test Source ${sourceId}`,
		sourceType: overrides.sourceType ?? "api",
		collectedAt: now,
		records: Array.from({ length: overrides.recordCount ?? 1 }, (_, i) =>
			createTestRecord(i),
		),
		hasMore: overrides.hasMore ?? false,
		nextCursor: overrides.nextCursor,
		metadata: { test: true },
	};
}

export function createTestRecord(index: number): {
	externalId: string;
	contentHash: string;
	rawPayload: unknown;
	observedAt: string;
} {
	const now = toIsoNow();
	return {
		externalId: `record-${index}`,
		contentHash: `hash-${ulid().slice(0, 16)}`,
		rawPayload: {
			id: index,
			name: `Test Entity ${index}`,
			createdAt: now,
		},
		observedAt: now,
	};
}

export function createTestSourceConfig(overrides: {
	sourceId?: string;
	name?: string;
	type?: "api" | "webhook" | "browser";
	status?: "active" | "paused" | "disabled";
	endpointUrl?: string;
} = {}): SourceConfig {
	const sourceId = overrides.sourceId ?? `source-${ulid()}`;

	return {
		sourceId,
		name: overrides.name ?? `Test Source ${sourceId}`,
		type: overrides.type ?? "api",
		status: overrides.status ?? "active",
		adapterType: "generic-api",
		endpointUrl: overrides.endpointUrl ?? "https://api.example.com/data",
		requestMethod: "GET",
		requestHeaders: { "X-Test": "true" },
		metadata: { test: true },
		policy: {
			minIntervalSeconds: 60,
			leaseTtlSeconds: 300,
			maxRecordsPerRun: 1000,
			retryLimit: 3,
			timeoutSeconds: 60,
		},
	};
}

// Mock fetch helpers
export function createMockFetch(responseData: unknown, status = 200) {
	return async () =>
		new Response(JSON.stringify(responseData), {
			status,
			headers: { "content-type": "application/json" },
		});
}

export function createMockFetchSequence(
	responses: Array<{ data: unknown; status?: number; delayMs?: number }>,
) {
	let callIndex = 0;
	return async () => {
		const response = responses[callIndex++] ?? responses[responses.length - 1];
		if (response.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, response.delayMs));
		}
		return new Response(JSON.stringify(response.data), {
			status: response.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
}

// D1 helpers
export async function clearTestData(db: D1Database): Promise<void> {
	// Clear test data - use with caution, only in test environments
	await db.prepare("DELETE FROM ingest_runs WHERE run_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM raw_artifacts WHERE artifact_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM entities_current WHERE entity_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM entity_observations WHERE entity_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM source_configs WHERE source_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM source_policies WHERE source_id LIKE 'test-%'").run();
	await db.prepare("DELETE FROM source_capabilities WHERE source_id LIKE 'test-%'").run();
}

// R2 helpers
export async function clearTestObjects(
	bucket: R2Bucket,
	prefix = "test-",
): Promise<void> {
	const objects = await bucket.list({ prefix });
	for (const obj of objects.objects) {
		await bucket.delete(obj.key);
	}
}

// Queue helpers
export async function drainQueue(queue: Queue): Promise<unknown[]> {
	const messages: unknown[] = [];
	// Note: In tests, we can't actually drain queues, but we can track messages sent
	return messages;
}

// Assertion helpers
export function expectValidIsoTimestamp(value: string): void {
	expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	const date = new Date(value);
	expect(date.toISOString()).toBe(value);
}

export function expectValidUUID(value: string): void {
	expect(value).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
}
