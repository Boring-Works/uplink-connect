import { describe, it, expect } from "vitest";
import app from "../../index";

describe("uplink-edge additional", () => {
	const createEnv = () => ({
		INGEST_API_KEY: "test-api-key",
		CORE_INTERNAL_KEY: "test-internal-key",
		INGEST_QUEUE: {
			send: async () => undefined,
		} as unknown as Queue,
		UPLINK_CORE: {
			fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		} as unknown as Fetcher,
	});

	describe("authorization variations", () => {
		it("rejects lowercase bearer prefix", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "bearer test-api-key", "content-type": "application/json" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects missing space after Bearer", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearertest-api-key", "content-type": "application/json" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects empty bearer token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer ", "content-type": "application/json" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("intake edge cases", () => {
		it("accepts webhook source type", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "webhook",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {} }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(202);
		});

		it("accepts browser source type", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "browser",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {} }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(202);
		});

		it("rejects invalid source type", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "invalid",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {} }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("returns receivedAt in response", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {} }],
					}),
				}),
				env,
			);
			const body = await res.json() as { receivedAt: string };
			expect(body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("trigger endpoint", () => {
		it("returns 401 for trigger without auth", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", { method: "POST" }),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("returns 500 when INGEST_API_KEY missing", async () => {
			const env = createEnv();
			(env as unknown as { INGEST_API_KEY: string | undefined }).INGEST_API_KEY = undefined;
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
				}),
				env,
			);
			expect(res.status).toBe(500);
		});

		it("returns 202 on successful trigger", async () => {
			const env = createEnv();
			env.UPLINK_CORE = {
				fetch: async () => new Response(JSON.stringify({ ok: true, workflowInstanceId: "wf-123" }), { status: 202 }),
			} as unknown as Fetcher;
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
				}),
				env,
			);
			expect(res.status).toBe(202);
		});

		it("includes workflowInstanceId in trigger response", async () => {
			const env = createEnv();
			env.UPLINK_CORE = {
				fetch: async () => new Response(JSON.stringify({ ok: true, workflowInstanceId: "wf-123" }), { status: 202 }),
			} as unknown as Fetcher;
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
				}),
				env,
			);
			const body = await res.json() as { workflowInstanceId: string };
			expect(body.workflowInstanceId).toBeDefined();
		});
	});

	describe("intake payload variations", () => {
		it("accepts records with metadata", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						records: [{ contentHash: "abc12345678901234567", rawPayload: { foo: "bar" }, metadata: { key: "value" } }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(202);
		});

		it("rejects empty records array", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						records: [],
					}),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("accepts records with externalId", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						records: [{ contentHash: "abc12345678901234567", rawPayload: {}, externalId: "ext-1" }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(202);
		});
	});

	describe("not found handling", () => {
		it("returns 404 for unknown path", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/unknown/path", {
					headers: { authorization: "Bearer test-api-key" },
				}),
				env,
			);
			expect(res.status).toBe(404);
		});

		it("returns 404 for unknown method", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "PUT",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(404);
		});
	});
});
