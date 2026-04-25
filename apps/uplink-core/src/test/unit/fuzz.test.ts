import { describe, it, expect } from "vitest";
import { IngestEnvelopeSchema, IngestQueueMessageSchema, ulid } from "@uplink/contracts";
import { extractSearchableText, buildVectorMetadata } from "../../lib/vectorize";

describe("fuzz / property tests", () => {
	function randomString(length: number): string {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
	}

	function randomRecord() {
		return {
			externalId: randomString(8),
			contentHash: randomString(20),
			rawPayload: {
				id: randomString(16),
				data: Array.from({ length: Math.floor(Math.random() * 5) }, () => ({
					key: randomString(8),
					value: Math.random() > 0.5 ? randomString(10) : Math.floor(Math.random() * 1000),
				})),
			},
			suggestedEntityType: Math.random() > 0.5 ? randomString(6) : undefined,
			observedAt: Math.random() > 0.5 ? new Date().toISOString() : undefined,
		};
	}

	function randomEnvelope(): Record<string, unknown> {
		return {
			schemaVersion: "1.0",
			ingestId: ulid(),
			sourceId: randomString(8),
			sourceName: randomString(10),
			sourceType: ["api", "webhook", "file", "browser", "email", "manual"][Math.floor(Math.random() * 6)],
			collectedAt: new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString(),
			records: Array.from({ length: 1 + Math.floor(Math.random() * 19) }, randomRecord),
			hasMore: Math.random() > 0.8,
			traceId: Math.random() > 0.3 ? ulid() : undefined,
			metadata: Math.random() > 0.5 ? { tag: randomString(5) } : undefined,
		};
	}

	it("validates 100 random envelopes", () => {
		for (let i = 0; i < 100; i++) {
			const envelope = randomEnvelope();
			expect(IngestEnvelopeSchema.safeParse(envelope).success).toBe(true);
		}
	});

	it("validates queue messages from random envelopes", () => {
		for (let i = 0; i < 100; i++) {
			const msg = {
				envelope: randomEnvelope(),
				receivedAt: new Date().toISOString(),
				requestId: ulid(),
			};
			expect(IngestQueueMessageSchema.safeParse(msg).success).toBe(true);
		}
	});

	it("extractSearchableText never throws", () => {
		for (let i = 0; i < 100; i++) {
			const arr = Array.from({ length: Math.floor(Math.random() * 10) }, () =>
				Math.random() > 0.5 ? randomString(5) : Math.floor(Math.random() * 100),
			);
			const obj = { a: randomString(20), nested: { b: randomString(10), arr } };
			expect(typeof extractSearchableText(JSON.stringify(obj))).toBe("string");
		}
	});

	it("buildVectorMetadata handles random shapes", () => {
		for (let i = 0; i < 100; i++) {
			const keys = ["entityType", "type", "suggestedEntityType", "other"];
			const key = keys[Math.floor(Math.random() * keys.length)];
			const obj: Record<string, unknown> = { name: randomString(10) };
			if (key !== "other") obj[key] = randomString(6);
			const entity = {
				entityId: ulid(),
				sourceId: randomString(8),
				externalId: randomString(8),
				contentHash: randomString(16),
				canonicalJson: JSON.stringify(obj),
				observedAt: new Date().toISOString(),
			};
			const meta = buildVectorMetadata(entity);
			expect(meta.entityId).toBe(entity.entityId);
			expect(meta.sourceId).toBe(entity.sourceId);
			if (key !== "other") {
				expect(meta.entityType).toBe(obj[key] as string);
			} else {
				expect(meta.entityType).toBe("unknown");
			}
		}
	});

	it("handles edge-case strings in searchable text", () => {
		const cases = [
			JSON.stringify({ text: "\u0000\u0001\u0002" }),
			JSON.stringify({ text: "🔥🚀💻" }),
			JSON.stringify({ text: "\n\r\t" }),
			JSON.stringify({ text: "a".repeat(10000) }),
			"not json at all",
			"{ broken json",
			"null",
			"12345",
			'"just a string"',
		];
		for (const c of cases) {
			expect(typeof extractSearchableText(c)).toBe("string");
		}
	});

	it("rejects envelopes with non-array records", () => {
		for (const records of ["not-array", 123, null, { id: "r1" }]) {
			const env = { ...randomEnvelope(), records };
			expect(IngestEnvelopeSchema.safeParse(env).success).toBe(false);
		}
	});

	it("rejects invalid source types", () => {
		const envelope = randomEnvelope();
		envelope.sourceType = "invalid_type";
		expect(IngestEnvelopeSchema.safeParse(envelope).success).toBe(false);
	});

	it("accepts all valid source types", () => {
		for (const t of ["api", "webhook", "file", "browser", "email", "manual"]) {
			const envelope = {
				schemaVersion: "1.0",
				ingestId: ulid(),
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: t,
				collectedAt: new Date().toISOString(),
				records: [{ contentHash: randomString(20), rawPayload: {} }],
			};
			expect(IngestEnvelopeSchema.safeParse(envelope).success).toBe(true);
		}
	});
});
