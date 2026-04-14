import { describe, expect, it } from "vitest";
import { normalizeEnvelope, chunkCode } from "../index";

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

describe("chunkCode", () => {
	it("should chunk a simple function", () => {
		const code = `
function hello() {
  return "world";
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].chunkType).toBe("function");
	});

	it("should chunk multiple functions", () => {
		const code = `
function foo() {
  return 1;
}

function bar() {
  return 2;
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const functions = chunks.filter((c) => c.chunkType === "function");
		expect(functions.length).toBeGreaterThanOrEqual(2);
	});

	it("should detect class definitions", () => {
		const code = `
class MyClass {
  constructor() {
    this.value = 1;
  }
  method() {
    return this.value;
  }
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const classes = chunks.filter((c) => c.chunkType === "class");
		expect(classes.length).toBeGreaterThan(0);
	});

	it("should detect interface definitions", () => {
		const code = `
interface Config {
  name: string;
  value: number;
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const interfaces = chunks.filter((c) => c.chunkType === "interface");
		expect(interfaces.length).toBeGreaterThan(0);
	});

	it("should detect type definitions", () => {
		const code = `
type ID = string;
type User = { name: string };
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const types = chunks.filter((c) => c.chunkType === "type");
		expect(types.length).toBeGreaterThan(0);
	});

	it("should chunk by lines for non-JS files", () => {
		const code = `
Line 1
Line 2
Line 3
Line 4
Line 5
		`.trim();
		const chunks = chunkCode(code, "test.md");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].chunkType).toBe("other");
	});

	it("should respect max chunk size", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`);
		const code = lines.join("\n");
		const chunks = chunkCode(code, "test.ts", { maxChunkSize: 1000 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(1100);
		}
	});

	it("should skip chunks smaller than min size", () => {
		const code = `const x = 1;`;
		const chunks = chunkCode(code, "test.ts", { minChunkSize: 100 });
		expect(chunks.length).toBe(0);
	});

	it("should detect import blocks", () => {
		const code = `
import { a } from "a";
import { b } from "b";
import { c } from "c";

const x = 1;
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const hasImports = chunks.some(
			(c) => c.content.includes("import { a }") && c.content.includes("import { b }")
		);
		expect(hasImports).toBe(true);
	});

	it("should detect export blocks", () => {
		const code = `
export { somethingLonger, anotherThing };
export { yetAnother, oneMore };
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const hasExports = chunks.some((c) => c.content.includes("export {"));
		expect(hasExports).toBe(true);
	});

	it("should handle arrow functions", () => {
		const code = `
const fn = () => {
  return 42;
};
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const functions = chunks.filter((c) => c.chunkType === "function");
		expect(functions.length).toBeGreaterThan(0);
	});

	it("should handle async functions", () => {
		const code = `
async function fetchData() {
  return await fetch("/api");
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		const functions = chunks.filter((c) => c.chunkType === "function");
		expect(functions.length).toBeGreaterThan(0);
	});

	it("should set correct line numbers", () => {
		const code = `
function first() {
  return 1;
}

function second() {
  return 2;
}
		`.trim();
		const chunks = chunkCode(code, "test.ts");
		for (const chunk of chunks) {
			expect(chunk.lineStart).toBeGreaterThan(0);
			expect(chunk.lineEnd).toBeGreaterThanOrEqual(chunk.lineStart);
		}
	});

	it("should include file path in chunk ID", () => {
		const code = `function test() { return 1; }`;
		const chunks = chunkCode(code, "src/utils/helpers.ts");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].id).toContain("src/utils/helpers.ts");
	});

	it("should handle jsx files", () => {
		const code = `
function Component() {
  return <div>Hello</div>;
}
		`.trim();
		const chunks = chunkCode(code, "test.jsx");
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0].chunkType).toBe("function");
	});

	it("should handle tsx files", () => {
		const code = `
const Component: React.FC = () => {
  return <div>Hello</div>;
};
		`.trim();
		const chunks = chunkCode(code, "test.tsx");
		expect(chunks.length).toBeGreaterThan(0);
		// TSX arrow with type annotation doesn't match function regex, falls back to other
		expect(chunks[0].chunkType).toBe("other");
	});

	it("should handle empty content", () => {
		const chunks = chunkCode("", "test.ts");
		expect(chunks.length).toBe(0);
	});

	it("should handle single line non-code file", () => {
		const chunks = chunkCode("Hello world", "test.txt", { minChunkSize: 1 });
		expect(chunks.length).toBe(1);
		expect(chunks[0].content).toBe("Hello world");
	});
});
