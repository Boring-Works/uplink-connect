import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	generateEmbedding,
	extractSearchableText,
	buildVectorMetadata,
	upsertEntityVector,
	upsertEntityVectors,
	querySimilarEntities,
	deleteEntityVector,
	deleteEntityVectors,
} from "../../../lib/vectorize";
import type { NormalizedEntity } from "@uplink/normalizers";

describe("vectorize", () => {
	let mockAi: Ai;
	let mockIndex: VectorizeIndex;
	let upsertedVectors: Array<{ id: string; values: number[]; metadata: Record<string, string> }>;
	let deletedIds: string[];
	let queryResults: Array<{ id: string; score: number; metadata?: Record<string, string> }>;

	beforeEach(() => {
		upsertedVectors = [];
		deletedIds = [];
		queryResults = [];

		mockAi = {
			run: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
		} as unknown as Ai;

		mockIndex = {
			upsert: vi.fn().mockImplementation((vectors) => {
				upsertedVectors.push(...(vectors as { id: string; values: number[]; metadata: Record<string, string> }[]));
				return Promise.resolve();
			}),
			query: vi.fn().mockImplementation(() => Promise.resolve({ matches: queryResults })),
			deleteByIds: vi.fn().mockImplementation((ids: string[]) => {
				deletedIds.push(...ids);
				return Promise.resolve();
			}),
		} as unknown as VectorizeIndex;
	});

	describe("generateEmbedding", () => {
		it("returns embedding from array response", async () => {
			const env = { AI: mockAi };
			const result = await generateEmbedding(env, "test text");
			expect(result).toEqual([0.1, 0.2, 0.3]);
			expect(mockAi.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: ["test text"] });
		});

		it("returns embedding from object response with data property", async () => {
			mockAi = {
				run: vi.fn().mockResolvedValue({ data: [[0.4, 0.5, 0.6]] }),
			} as unknown as Ai;
			const result = await generateEmbedding({ AI: mockAi }, "test text");
			expect(result).toEqual([0.4, 0.5, 0.6]);
		});

		it("throws on invalid response format", async () => {
			mockAi = {
				run: vi.fn().mockResolvedValue({ invalid: true }),
			} as unknown as Ai;
			await expect(generateEmbedding({ AI: mockAi }, "test")).rejects.toThrow("Failed to generate embedding");
		});

		it("throws when AI binding is missing", async () => {
			await expect(generateEmbedding({}, "test")).rejects.toThrow("AI binding not available");
		});
	});

	describe("extractSearchableText", () => {
		it("extracts strings from flat object", () => {
			const text = extractSearchableText('{"name":"Alice","age":30}');
			expect(text).toContain("Alice");
			expect(text).toContain("30");
		});

		it("extracts strings from nested object", () => {
			const text = extractSearchableText('{"user":{"name":"Bob","tags":["a","b"]}}');
			expect(text).toContain("Bob");
			expect(text).toContain("a");
			expect(text).toContain("b");
		});

		it("falls back to truncated raw JSON on parse error", () => {
			const raw = "x".repeat(3000);
			const text = extractSearchableText(raw);
			expect(text.length).toBeLessThanOrEqual(2000);
		});

		it("handles arrays of primitives", () => {
			const text = extractSearchableText('["hello", 42, true, null]');
			expect(text).toContain("hello");
			expect(text).toContain("42");
			expect(text).toContain("true");
		});

		it("returns empty string for null", () => {
			expect(extractSearchableText("null")).toBe("");
		});

		it("returns empty string for empty object", () => {
			expect(extractSearchableText("{}")).toBe("");
		});

		it("handles deeply nested structures", () => {
			const text = extractSearchableText('{"a":{"b":{"c":{"d":"deep"}}}}');
			expect(text).toContain("deep");
		});
	});

	describe("buildVectorMetadata", () => {
		it("uses entityType from canonical JSON", () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"entityType":"person","name":"Alice"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityType).toBe("person");
		});

		it("falls back to type field", () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"type":"company"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityType).toBe("company");
		});

		it("falls back to suggestedEntityType field", () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"suggestedEntityType":"product"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityType).toBe("product");
		});

		it("defaults to unknown when no type found", () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"name":"NoType"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityType).toBe("unknown");
		});

		it("includes all required fields", () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"name":"Test"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityId).toBe("ent-1");
			expect(meta.sourceId).toBe("src-1");
			expect(meta.observedAt).toBe("2024-01-01T00:00:00Z");
			expect(meta.contentHash).toBe("hash-1");
		});
	});

	describe("upsertEntityVector", () => {
		it("skips entities with no searchable text", async () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			await upsertEntityVector({ AI: mockAi, ENTITY_INDEX: mockIndex }, entity);
			expect(upsertedVectors).toHaveLength(0);
		});

		it("upserts a valid entity vector", async () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"name":"Alice"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			await upsertEntityVector({ AI: mockAi, ENTITY_INDEX: mockIndex }, entity);
			expect(upsertedVectors).toHaveLength(1);
			expect(upsertedVectors[0].id).toBe("ent-1");
			expect(upsertedVectors[0].values).toEqual([0.1, 0.2, 0.3]);
		});

		it("skips when ENTITY_INDEX is missing", async () => {
			const entity: NormalizedEntity = {
				entityId: "ent-1",
				sourceId: "src-1",
				externalId: "ext-1",
				contentHash: "hash-1",
				canonicalJson: '{"name":"Alice"}',
				observedAt: "2024-01-01T00:00:00Z",
			};
			await upsertEntityVector({ AI: mockAi }, entity);
			expect(upsertedVectors).toHaveLength(0);
		});
	});

	describe("upsertEntityVectors", () => {
		it("returns early for empty array", async () => {
			await upsertEntityVectors({ AI: mockAi, ENTITY_INDEX: mockIndex }, []);
			expect(upsertedVectors).toHaveLength(0);
		});

		it("upserts multiple entities", async () => {
			const entities: NormalizedEntity[] = [
				{ entityId: "ent-1", sourceId: "src-1", externalId: "ext-1", contentHash: "h1", canonicalJson: '{"name":"A"}', observedAt: "2024-01-01T00:00:00Z" },
				{ entityId: "ent-2", sourceId: "src-1", externalId: "ext-2", contentHash: "h2", canonicalJson: '{"name":"B"}', observedAt: "2024-01-01T00:00:00Z" },
			];
			await upsertEntityVectors({ AI: mockAi, ENTITY_INDEX: mockIndex }, entities);
			expect(upsertedVectors).toHaveLength(2);
		});

		it("skips entities with empty text and logs error on embedding failure", async () => {
			mockAi = {
				run: vi.fn().mockImplementation((_, { text }: { text: string[] }) => {
					if (text[0].includes("FAIL")) throw new Error("AI error");
					return [[0.1, 0.2]];
				}),
			} as unknown as Ai;
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const entities: NormalizedEntity[] = [
				{ entityId: "ent-1", sourceId: "src-1", externalId: "ext-1", contentHash: "h1", canonicalJson: '{"name":"FAIL"}', observedAt: "2024-01-01T00:00:00Z" },
				{ entityId: "ent-2", sourceId: "src-1", externalId: "ext-2", contentHash: "h2", canonicalJson: '{"name":"OK"}', observedAt: "2024-01-01T00:00:00Z" },
			];
			await upsertEntityVectors({ AI: mockAi, ENTITY_INDEX: mockIndex }, entities);
			expect(upsertedVectors).toHaveLength(1);
			expect(upsertedVectors[0].id).toBe("ent-2");
			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});
	});

	describe("querySimilarEntities", () => {
		it("returns empty array when no matches", async () => {
			queryResults = [];
			const result = await querySimilarEntities({ AI: mockAi, ENTITY_INDEX: mockIndex }, "test");
			expect(result).toEqual([]);
		});

		it("maps matches to SearchResult format", async () => {
			queryResults = [
				{ id: "ent-1", score: 0.95, metadata: { sourceId: "src-1", entityType: "person", observedAt: "2024-01-01T00:00:00Z", contentHash: "h1" } },
			];
			const result = await querySimilarEntities({ AI: mockAi, ENTITY_INDEX: mockIndex }, "test");
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				entityId: "ent-1",
				score: 0.95,
				metadata: {
					entityId: "ent-1",
					sourceId: "src-1",
					entityType: "person",
					observedAt: "2024-01-01T00:00:00Z",
					contentHash: "h1",
				},
			});
		});

		it("uses defaults for missing metadata", async () => {
			queryResults = [{ id: "ent-1", score: 0.8 }];
			const result = await querySimilarEntities({ AI: mockAi, ENTITY_INDEX: mockIndex }, "test");
			expect(result[0].metadata.sourceId).toBe("unknown");
			expect(result[0].metadata.entityType).toBe("unknown");
			expect(result[0].metadata.contentHash).toBe("");
		});

		it("passes topK and filter options", async () => {
			await querySimilarEntities({ AI: mockAi, ENTITY_INDEX: mockIndex }, "test", {
				topK: 5,
				filter: { sourceId: { $eq: "src-1" } },
				returnValues: true,
				returnMetadata: false,
			});
			expect(mockIndex.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
				topK: 5,
				filter: { sourceId: { $eq: "src-1" } },
				returnValues: true,
				returnMetadata: false,
			});
		});

		it("throws when ENTITY_INDEX is missing", async () => {
			await expect(querySimilarEntities({ AI: mockAi }, "test")).rejects.toThrow("Vectorize index not available");
		});
	});

	describe("deleteEntityVector", () => {
		it("deletes a single vector by id", async () => {
			await deleteEntityVector({ ENTITY_INDEX: mockIndex }, "ent-1");
			expect(deletedIds).toEqual(["ent-1"]);
		});

		it("skips when ENTITY_INDEX is missing", async () => {
			await deleteEntityVector({}, "ent-1");
			expect(deletedIds).toHaveLength(0);
		});
	});

	describe("deleteEntityVectors", () => {
		it("returns early for empty array", async () => {
			await deleteEntityVectors({ ENTITY_INDEX: mockIndex }, []);
			expect(deletedIds).toEqual([]);
		});

		it("deletes multiple vectors by ids", async () => {
			await deleteEntityVectors({ ENTITY_INDEX: mockIndex }, ["ent-1", "ent-2"]);
			expect(deletedIds).toEqual(["ent-1", "ent-2"]);
		});

		it("skips when ENTITY_INDEX is missing", async () => {
			await deleteEntityVectors({}, ["ent-1", "ent-2"]);
			expect(deletedIds).toHaveLength(0);
		});
	});
});
