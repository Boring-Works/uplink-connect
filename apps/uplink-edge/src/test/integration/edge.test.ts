import { describe, it, expect, vi } from "vitest";
import app from "../../index";

describe("uplink-edge integration", () => {
	const createEnv = () => ({
		INGEST_API_KEY: "test-api-key",
		CORE_INTERNAL_KEY: "test-internal-key",
		INGEST_QUEUE: {
			send: vi.fn().mockResolvedValue(undefined),
		} as unknown as Queue,
		UPLINK_CORE: {
			fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
		} as unknown as Fetcher,
	});

	describe("GET /health", () => {
		it("returns ok", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.ok).toBe(true);
			expect(body.service).toBe("uplink-edge");
		});
	});

	describe("POST /v1/intake", () => {
		it("returns 401 without authorization", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", { method: "POST", body: "{}" }),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("returns 500 when INGEST_API_KEY not configured", async () => {
			const env = createEnv();
			env.INGEST_API_KEY = undefined;
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(500);
		});

		it("returns 400 for invalid JSON", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
					body: "not json",
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 for invalid envelope schema", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("accepts valid envelope and queues message", async () => {
			const env = createEnv();
			const payload = {
				ingestId: "run-12345",
				sourceId: "src-1",
				sourceName: "Test",
				sourceType: "api",
				collectedAt: "2024-01-01T00:00:00Z",
				records: [{ contentHash: "a".repeat(20), rawPayload: { id: "r1" } }],
			};
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify(payload),
				}),
				env,
			);
			expect(res.status).toBe(202);
			const body = await res.json();
			expect(body.ok).toBe(true);
			expect(body.ingestId).toBe("run-12345");
			expect(env.INGEST_QUEUE.send).toHaveBeenCalled();
		});

		it("fills in defaults for missing fields", async () => {
			const env = createEnv();
			const payload = {
				sourceId: "src-1",
				sourceName: "Test",
				records: [{ contentHash: "a".repeat(20), rawPayload: { id: "r1" } }],
			};
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify(payload),
				}),
				env,
			);
			expect(res.status).toBe(202);
			const body = await res.json();
			expect(body.recordCount).toBe(1);
			expect(body.ingestId).toMatch(/^[0-9a-f-]{36}$/);
		});
	});

	describe("POST /v1/sources/:sourceId/trigger", () => {
		it("returns 401 without auth", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", { method: "POST" }),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("proxies trigger to uplink-core", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({ force: true }),
				}),
				env,
			);
			expect(env.UPLINK_CORE.fetch).toHaveBeenCalled();
			const callUrl = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as string;
			const callInit = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][1] as { body?: string };
			expect(callUrl).toContain("/internal/sources/src-1/trigger");
			expect(JSON.parse(callInit.body ?? "{}")).toMatchObject({ force: true, triggeredBy: "edge" });
		});
	});
});
