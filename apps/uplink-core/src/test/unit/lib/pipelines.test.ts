import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	hasPipeline,
	emitIngestEvent,
	emitEntityEvent,
	emitEntityEvents,
	IngestReceivedEvent,
	IngestPersistedEvent,
	IngestNormalizedEvent,
	EntityCreatedEvent,
	EntityUpdatedEvent,
} from "../../../lib/pipelines";
import { IngestEnvelope, IngestQueueMessage } from "@uplink/contracts";
import type { NormalizedEntity } from "@uplink/normalizers";

describe("pipelines", () => {
	let sentEvents: unknown[];
	let mockEnv: { ANALYTICS_PIPELINE?: { send: (e: unknown) => Promise<void> } };

	beforeEach(() => {
		sentEvents = [];
		mockEnv = {
			ANALYTICS_PIPELINE: {
				send: vi.fn().mockImplementation(async (e) => {
					sentEvents.push(e);
				}),
			},
		};
	});

	const envelope: IngestEnvelope = {
		ingestId: "run-123",
		sourceId: "src-1",
		sourceName: "Test Source",
		sourceType: "api",
		collectedAt: "2024-01-01T00:00:00Z",
		records: [{ id: "r1", data: {} }],
		metadata: { triggeredBy: "user-1", replayOf: "run-000" },
		traceId: "trace-123",
	};

	const message: IngestQueueMessage = {
		envelope,
		receivedAt: "2024-01-01T00:01:00Z",
		requestId: "req-1",
	};

	describe("hasPipeline", () => {
		it("returns true when ANALYTICS_PIPELINE is present", () => {
			expect(hasPipeline(mockEnv)).toBe(true);
		});

		it("returns false when ANALYTICS_PIPELINE is missing", () => {
			expect(hasPipeline({})).toBe(false);
		});

		it("returns false when env is null", () => {
			expect(hasPipeline(null)).toBe(false);
		});
	});

	describe("emitIngestEvent", () => {
		it("returns early when no pipeline", async () => {
			await emitIngestEvent({}, "ingest.received", { envelope, message });
			expect(sentEvents).toHaveLength(0);
		});

		it("emits ingest.received event", async () => {
			await emitIngestEvent(mockEnv, "ingest.received", { envelope, message });
			expect(sentEvents).toHaveLength(1);
			const event = sentEvents[0] as IngestReceivedEvent;
			expect(event.eventType).toBe("ingest.received");
			expect(event.sourceId).toBe("src-1");
			expect(event.runId).toBe("run-123");
			expect(event.recordCount).toBe(1);
			expect(event.triggeredBy).toBe("user-1");
			expect(event.replayOfRunId).toBe("run-000");
			expect(event.traceId).toBe("trace-123");
			expect(event.timestamp).toMatch(/^\d{4}-/);
		});

		it("emits ingest.persisted event with artifact info", async () => {
			await emitIngestEvent(mockEnv, "ingest.persisted", {
				envelope,
				message,
				artifactKey: "artifacts/src-1/run-123/raw.json",
				sizeBytes: 1024,
			});
			const event = sentEvents[0] as IngestPersistedEvent;
			expect(event.eventType).toBe("ingest.persisted");
			expect(event.artifactKey).toBe("artifacts/src-1/run-123/raw.json");
			expect(event.sizeBytes).toBe(1024);
		});

		it("skips ingest.persisted when artifactKey is missing", async () => {
			await emitIngestEvent(mockEnv, "ingest.persisted", { envelope, message });
			expect(sentEvents).toHaveLength(0);
		});

		it("emits ingest.normalized event", async () => {
			await emitIngestEvent(mockEnv, "ingest.normalized", {
				envelope,
				message,
				normalizedCount: 5,
				durationMs: 250,
			});
			const event = sentEvents[0] as IngestNormalizedEvent;
			expect(event.eventType).toBe("ingest.normalized");
			expect(event.normalizedCount).toBe(5);
			expect(event.durationMs).toBe(250);
		});

		it("silently fails when pipeline throws", async () => {
			mockEnv.ANALYTICS_PIPELINE = {
				send: vi.fn().mockRejectedValue(new Error("pipeline down")),
			};
			await expect(emitIngestEvent(mockEnv, "ingest.received", { envelope, message })).resolves.toBeUndefined();
		});
	});

	describe("emitEntityEvent", () => {
		const entity: NormalizedEntity = {
			entityId: "ent-1",
			sourceId: "src-1",
			externalId: "ext-1",
			contentHash: "hash-1",
			canonicalJson: '{"name":"Alice"}',
			observedAt: "2024-01-01T00:00:00Z",
		};

		it("returns early when no pipeline", async () => {
			await emitEntityEvent({}, "entity.created", { envelope, entity });
			expect(sentEvents).toHaveLength(0);
		});

		it("emits entity.created event", async () => {
			await emitEntityEvent(mockEnv, "entity.created", { envelope, entity });
			expect(sentEvents).toHaveLength(1);
			const event = sentEvents[0] as EntityCreatedEvent;
			expect(event.eventType).toBe("entity.created");
			expect(event.entityId).toBe("ent-1");
			expect(event.externalId).toBe("ext-1");
			expect(event.contentHash).toBe("hash-1");
		});

		it("emits entity.updated event with previous hash", async () => {
			await emitEntityEvent(mockEnv, "entity.updated", {
				envelope,
				entity,
				previousContentHash: "old-hash",
			});
			const event = sentEvents[0] as EntityUpdatedEvent;
			expect(event.eventType).toBe("entity.updated");
			expect(event.previousContentHash).toBe("old-hash");
		});

		it("silently fails when pipeline throws", async () => {
			mockEnv.ANALYTICS_PIPELINE = {
				send: vi.fn().mockRejectedValue(new Error("pipeline down")),
			};
			await expect(emitEntityEvent(mockEnv, "entity.created", { envelope, entity })).resolves.toBeUndefined();
		});
	});

	describe("emitEntityEvents", () => {
		const entities: NormalizedEntity[] = [
			{ entityId: "ent-1", sourceId: "src-1", externalId: "ext-1", contentHash: "h1", canonicalJson: "{}", observedAt: "2024-01-01T00:00:00Z" },
			{ entityId: "ent-2", sourceId: "src-1", externalId: "ext-2", contentHash: "h2", canonicalJson: "{}", observedAt: "2024-01-01T00:00:00Z" },
		];

		it("returns early when no pipeline", async () => {
			await emitEntityEvents({}, "entity.created", { envelope, entities });
			expect(sentEvents).toHaveLength(0);
		});

		it("emits events for all entities in parallel", async () => {
			const previousHashes = new Map([["ent-1", "old-h1"]]);
			await emitEntityEvents(mockEnv, "entity.updated", { envelope, entities, previousContentHashes: previousHashes });
			expect(sentEvents).toHaveLength(2);
			const ev0 = sentEvents[0] as EntityUpdatedEvent;
			const ev1 = sentEvents[1] as EntityUpdatedEvent;
			// One should have previous hash, the other undefined
			const hashes = [ev0.previousContentHash, ev1.previousContentHash];
			expect(hashes).toContain("old-h1");
			expect(hashes).toContain(undefined);
		});

		it("silently fails when pipeline throws", async () => {
			mockEnv.ANALYTICS_PIPELINE = {
				send: vi.fn().mockRejectedValue(new Error("pipeline down")),
			};
			await expect(emitEntityEvents(mockEnv, "entity.created", { envelope, entities })).resolves.toBeUndefined();
		});
	});

	describe("emitIngestEvent edge cases", () => {
		it("returns early for unknown event type", async () => {
			await emitIngestEvent(mockEnv, "unknown.type" as never, { envelope, message });
			expect(sentEvents).toHaveLength(0);
		});

		it("uses defaults for optional ingest.normalized fields", async () => {
			await emitIngestEvent(mockEnv, "ingest.normalized", { envelope, message });
			const event = sentEvents[0] as IngestNormalizedEvent;
			expect(event.normalizedCount).toBe(0);
			expect(event.durationMs).toBeUndefined();
		});
	});

	describe("emitEntityEvent edge cases", () => {
		it("emits entity.created without externalId", async () => {
			const entityNoExt: NormalizedEntity = {
				entityId: "ent-noext",
				sourceId: "src-1",
				externalId: undefined,
				contentHash: "hash-noext",
				canonicalJson: "{}",
				observedAt: "2024-01-01T00:00:00Z",
			};
			await emitEntityEvent(mockEnv, "entity.created", { envelope, entity: entityNoExt });
			const event = sentEvents[0] as EntityCreatedEvent;
			expect(event.externalId).toBeUndefined();
			expect(event.entityId).toBe("ent-noext");
		});
	});
});
