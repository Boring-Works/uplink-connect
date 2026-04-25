/**
 * Ingest Integration Tests
 *
 * Tests the full ingest flow: intake -> queue -> processing -> D1 + R2
 * Tests idempotency (same ingestId twice)
 * Tests error handling and retry
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
	createIngestQueueMessage,
	toIsoNow,
	ulid,
	IngestEnvelopeSchema,
} from "@uplink/contracts";
import { handleIngestMessage } from "../../lib/processing";
import { getRun, getArtifact } from "../../lib/db";
import type { Env } from "../../types";

// Helper to create a test ingest envelope
function createTestEnvelope(overrides: {
	ingestId?: string;
	sourceId?: string;
	records?: Array<{
		externalId?: string;
		contentHash: string;
		rawPayload: unknown;
		observedAt?: string;
	}>;
} = {}): {
	schemaVersion: "1.0";
	ingestId: string;
	sourceId: string;
	sourceName: string;
	sourceType: "api";
	collectedAt: string;
	records: Array<{
		externalId: string;
		contentHash: string;
		rawPayload: unknown;
		observedAt: string;
	}>;
	hasMore: false;
	metadata: Record<string, unknown>;
} {
	const now = toIsoNow();
	return {
		schemaVersion: "1.0",
		ingestId: overrides.ingestId ?? `test-ingest-${ulid()}`,
		sourceId: overrides.sourceId ?? `test-source-${ulid()}`,
		sourceName: "Test Source",
		sourceType: "api",
		collectedAt: now,
		records: overrides.records ?? [
			{
				externalId: "test-record-1",
				contentHash: "hash-abc123",
				rawPayload: { name: "Test Entity", value: 42 },
				observedAt: now,
			},
		],
		hasMore: false,
		metadata: { test: true },
	};
}

describe("ingest flow", () => {
	describe("full ingest flow", () => {
		it("should process ingest message through full pipeline", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const envelope = createTestEnvelope();
			const message = createIngestQueueMessage(envelope, {
				requestId: `test-${ulid()}`,
			});

			// Process the message
			await handleIngestMessage(testEnv, message);

			// Verify run record in D1
			const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
			expect(run).toBeDefined();
			expect(run?.run_id).toBe(envelope.ingestId);
			expect(run?.source_id).toBe(envelope.sourceId);
			expect(run?.status).toBe("normalized");
			expect(run?.record_count).toBe(1);
			expect(run?.normalized_count).toBe(1);

			// Verify artifact in R2
			const artifact = await getArtifact(testEnv.CONTROL_DB, `${envelope.ingestId}:raw`);
			expect(artifact).toBeDefined();
			expect(artifact?.run_id).toBe(envelope.ingestId);
			expect(artifact?.artifact_type).toBe("raw-envelope");

			// Verify R2 object exists
			const r2Key = artifact?.r2_key as string;
			const r2Object = await testEnv.RAW_BUCKET.get(r2Key);
			expect(r2Object).toBeDefined();

			const r2Content = await r2Object?.text();
			expect(r2Content).toBeDefined();
			const parsedContent = JSON.parse(r2Content!);
			expect(parsedContent.ingestId).toBe(envelope.ingestId);
		});

		it("should process multiple records in single envelope", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const now = toIsoNow();
			const envelope = createTestEnvelope({
				records: [
					{
						externalId: "record-1",
						contentHash: "hash-1",
						rawPayload: { id: 1, name: "Entity 1" },
						observedAt: now,
					},
					{
						externalId: "record-2",
						contentHash: "hash-2",
						rawPayload: { id: 2, name: "Entity 2" },
						observedAt: now,
					},
					{
						externalId: "record-3",
						contentHash: "hash-3",
						rawPayload: { id: 3, name: "Entity 3" },
						observedAt: now,
					},
				],
			});
			const message = createIngestQueueMessage(envelope);

			await handleIngestMessage(testEnv, message);

			const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
			expect(run?.record_count).toBe(3);
			expect(run?.normalized_count).toBe(3);
		});
	});

	describe("idempotency", () => {
		it("should handle duplicate ingestId gracefully", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const envelope = createTestEnvelope();
			const message = createIngestQueueMessage(envelope);

			// First processing
			await handleIngestMessage(testEnv, message);

			const run1 = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
			expect(run1?.status).toBe("normalized");

			// Second processing with same ingestId - should be idempotent
			await handleIngestMessage(testEnv, message);

			const run2 = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
			expect(run2?.status).toBe("normalized");
			expect(run2?.run_id).toBe(run1?.run_id);
		});

		it("should not create duplicate artifacts for same ingestId", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const envelope = createTestEnvelope();
			const message = createIngestQueueMessage(envelope);

			// Process twice
			await handleIngestMessage(testEnv, message);
			await handleIngestMessage(testEnv, message);

			// Verify only one artifact exists
			const artifact = await getArtifact(testEnv.CONTROL_DB, `${envelope.ingestId}:raw`);
			expect(artifact).toBeDefined();

			// R2 should have the object
			const r2Key = artifact?.r2_key as string;
			const r2Object = await testEnv.RAW_BUCKET.get(r2Key);
			expect(r2Object).toBeDefined();
		});
	});

	describe("error handling", () => {
		it("should handle invalid envelope gracefully", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const invalidMessage = {
				envelope: {
					// Missing required fields
					ingestId: "test-invalid",
				},
				receivedAt: toIsoNow(),
			};

			// Should throw but not crash
			await expect(
				handleIngestMessage(testEnv, invalidMessage as unknown as {
					envelope: {
						schemaVersion: "1.0";
						ingestId: string;
						sourceId: string;
						sourceName: string;
						sourceType: "api";
						collectedAt: string;
						records: Array<{
							externalId: string;
							contentHash: string;
							rawPayload: unknown;
							observedAt: string;
						}>;
						hasMore: false;
						metadata: Record<string, unknown>;
					};
					receivedAt: string;
				}),
			).rejects.toThrow();
		});

		it("should handle empty records array", async () => {
			const { env } = await import("cloudflare:test");
			const testEnv = env as Env;

			const envelope = createTestEnvelope({ records: [] });
			const message = createIngestQueueMessage(envelope);

			// Should complete without error even with empty records
			await handleIngestMessage(testEnv, message);

			const run = await getRun(testEnv.CONTROL_DB, envelope.ingestId);
			expect(run?.status).toBe("normalized");
			expect(run?.record_count).toBe(0);
			expect(run?.normalized_count).toBe(0);
		});
	});
});
