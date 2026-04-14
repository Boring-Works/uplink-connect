import { describe, expect, it } from "vitest";
import { normalizeEnvelope } from "../index";

describe("normalizeEnvelope", () => {
	it("normalizes single record", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "record-1",
					contentHash: "abc123def4567890",
					rawPayload: { name: "Test Entity", value: 42 },
					observedAt: "2026-04-13T10:00:00Z",
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities).toHaveLength(1);
		expect(entities[0].entityId).toBe("src-1:ext:record-1");
		expect(entities[0].sourceId).toBe("src-1");
		expect(entities[0].sourceType).toBe("api");
		expect(entities[0].externalId).toBe("record-1");
		expect(entities[0].contentHash).toBe("abc123def4567890");
	});

	it("normalizes multiple records", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "record-1",
					contentHash: "hash1",
					rawPayload: { name: "Entity 1" },
				},
				{
					externalId: "record-2",
					contentHash: "hash2",
					rawPayload: { name: "Entity 2" },
				},
				{
					externalId: "record-3",
					contentHash: "hash3",
					rawPayload: { name: "Entity 3" },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities).toHaveLength(3);
		expect(entities[0].entityId).toBe("src-1:ext:record-1");
		expect(entities[1].entityId).toBe("src-1:ext:record-2");
		expect(entities[2].entityId).toBe("src-1:ext:record-3");
	});

	it("uses collectedAt when observedAt is missing", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: { name: "Entity 1" },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].observedAt).toBe("2026-04-13T10:00:00Z");
	});

	it("falls back to hash-based entityId when no externalId", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "myhash123",
					rawPayload: { name: "Entity 1" },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].entityId).toBe("src-1:hash:myhash123:0");
		expect(entities[0].externalId).toBeUndefined();
	});

	it("uses index in hash-based entityId for duplicates", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "samehash",
					rawPayload: { name: "Entity 1" },
				},
				{
					contentHash: "samehash",
					rawPayload: { name: "Entity 2" },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].entityId).toBe("src-1:hash:samehash:0");
		expect(entities[1].entityId).toBe("src-1:hash:samehash:1");
	});

	it("wraps primitive payload in canonical object", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: "just a string",
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ value: "just a string" });
	});

	it("wraps array payload in canonical object", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: [1, 2, 3],
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ items: [1, 2, 3] });
	});

	it("preserves object payload as-is", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: { nested: { value: 42 } },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ nested: { value: 42 } });
	});

	it("wraps null payload", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: null,
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ value: null });
	});

	it("wraps number payload", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: 42,
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ value: 42 });
	});

	it("wraps boolean payload", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					contentHash: "hash1",
					rawPayload: true,
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({ value: true });
	});

	it("preserves suggestedEntityType if present", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "record-1",
					contentHash: "hash1",
					rawPayload: { name: "Entity 1" },
					suggestedEntityType: "person",
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].entityId).toBe("src-1:ext:record-1");
	});

	it("returns empty array for empty records", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [],
		};

		// Empty records test - runtime validation catches this
		const entities = normalizeEnvelope(envelope as unknown as Parameters<typeof normalizeEnvelope>[0]);
		expect(entities).toEqual([]);
	});

	it("normalizes records with different source types", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "webhook" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "record-1",
					contentHash: "hash1",
					rawPayload: { event: "click" },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].sourceType).toBe("webhook");
	});

	it("preserves record order", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{ externalId: "a", contentHash: "h1", rawPayload: {} },
				{ externalId: "b", contentHash: "h2", rawPayload: {} },
				{ externalId: "c", contentHash: "h3", rawPayload: {} },
				{ externalId: "d", contentHash: "h4", rawPayload: {} },
				{ externalId: "e", contentHash: "h5", rawPayload: {} },
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities.map((e) => e.externalId)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("handles deeply nested payload", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "deep",
					contentHash: "hash1",
					rawPayload: { level1: { level2: { level3: { value: "deep" } } } },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical.level1.level2.level3.value).toBe("deep");
	});

	it("handles record with metadata field", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "meta",
					contentHash: "hash1",
					rawPayload: { name: "Test" },
					metadata: { tags: ["a", "b"] },
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].entityId).toBe("src-1:ext:meta");
	});

	it("handles empty object payload", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{
					externalId: "empty",
					contentHash: "hash1",
					rawPayload: {},
				},
			],
		};

		const entities = normalizeEnvelope(envelope);
		const canonical = JSON.parse(entities[0].canonicalJson);
		expect(canonical).toEqual({});
	});

	it("generates unique entityIds for mixed externalId and hash records", () => {
		const envelope = {
			schemaVersion: "1.0" as const,
			ingestId: "ingest-123",
			sourceId: "src-1",
			sourceName: "Test Source",
			sourceType: "api" as const,
			collectedAt: "2026-04-13T10:00:00Z",
			hasMore: false,
			records: [
				{ externalId: "ext-1", contentHash: "hash1", rawPayload: {} },
				{ contentHash: "hash2", rawPayload: {} },
				{ externalId: "ext-2", contentHash: "hash3", rawPayload: {} },
			],
		};

		const entities = normalizeEnvelope(envelope);
		expect(entities[0].entityId).toBe("src-1:ext:ext-1");
		expect(entities[1].entityId).toBe("src-1:hash:hash2:1");
		expect(entities[2].entityId).toBe("src-1:ext:ext-2");
	});
});
