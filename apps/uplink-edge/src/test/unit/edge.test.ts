import { describe, it, expect, vi } from "vitest";
import app from "../../index";

describe("uplink-edge unit", () => {
	const createEnv = () => ({
		INGEST_API_KEY: "test-api-key",
		CORE_INTERNAL_KEY: "test-internal-key",
		INGEST_QUEUE: {
			send: async () => undefined,
		} as unknown as Queue,
		UPLINK_CORE: {
			fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		} as unknown as Fetcher,
		RAW_BUCKET: {
			put: async () => undefined,
		} as unknown as R2Bucket,
	});

	describe("health", () => {
		it("returns service name", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json() as { service: string };
			expect(body.service).toBe("uplink-edge");
		});

		it("returns current timestamp", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json() as { now: string };
			expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("intake validation", () => {
		it("rejects empty body", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: "",
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects array body", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: "[]",
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects missing records", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({ sourceId: "src-1", sourceName: "Test", sourceType: "api" }),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects records without contentHash", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						records: [{ rawPayload: {} }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects records without rawPayload", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/intake", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({
						sourceId: "src-1",
						sourceName: "Test",
						sourceType: "api",
						records: [{ contentHash: "abc123" }],
					}),
				}),
				env,
			);
			expect(res.status).toBe(400);
		});
	});

	describe("intake defaults", () => {
		it("defaults sourceType to api", async () => {
			const env = createEnv();
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const queue = { send: sendSpy } as unknown as Queue;
			env.INGEST_QUEUE = queue;

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
			expect(res.status).toBe(202);
			expect(sendSpy).toHaveBeenCalledTimes(1);
			const msg = sendSpy.mock.calls[0][0] as { envelope: { sourceType: string } };
			expect(msg.envelope.sourceType).toBe("api");
		});

		it("generates UUID for missing ingestId", async () => {
			const env = createEnv();
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const queue = { send: sendSpy } as unknown as Queue;
			env.INGEST_QUEUE = queue;

			await app.fetch(
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

			const msg = sendSpy.mock.calls[0][0] as { envelope: { ingestId: string } };
			expect(msg.envelope.ingestId).toMatch(/^[0-9a-f-]{36}$/);
		});

		it("defaults hasMore to false", async () => {
			const env = createEnv();
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const queue = { send: sendSpy } as unknown as Queue;
			env.INGEST_QUEUE = queue;

			await app.fetch(
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

			const msg = sendSpy.mock.calls[0][0] as { envelope: { hasMore: boolean } };
			expect(msg.envelope.hasMore).toBe(false);
		});
	});

	describe("file upload", () => {
		it("rejects non-multipart requests", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/files/src-1", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: "{}",
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects missing files", async () => {
			const env = createEnv();
			const form = new FormData();
			const res = await app.fetch(
				new Request("http://localhost/v1/files/src-1", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
					body: form,
				}),
				env,
			);
			expect(res.status).toBe(400);
		});

		it("rejects when RAW_BUCKET not configured", async () => {
			const env = createEnv();
			delete (env as Record<string, unknown>).RAW_BUCKET;
			const form = new FormData();
			form.append("file", new File(["test"], "test.txt", { type: "text/plain" }));
			const res = await app.fetch(
				new Request("http://localhost/v1/files/src-1", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
					body: form,
				}),
				env,
			);
			expect(res.status).toBe(500);
		});

		it("uploads file and queues envelope", async () => {
			const env = createEnv();
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const putSpy = vi.fn().mockResolvedValue(undefined);
			env.INGEST_QUEUE = { send: sendSpy } as unknown as Queue;
			env.RAW_BUCKET = { put: putSpy } as unknown as R2Bucket;

			const form = new FormData();
			form.append("file", new File(["hello world"], "hello.txt", { type: "text/plain" }));

			const res = await app.fetch(
				new Request("http://localhost/v1/files/src-1", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
					body: form,
				}),
				env,
			);

			expect(res.status).toBe(202);
			expect(putSpy).toHaveBeenCalledTimes(1);
			expect(sendSpy).toHaveBeenCalledTimes(1);

			const body = await res.json() as { uploaded: number; files: Array<{ fileName: string }> };
			expect(body.uploaded).toBe(1);
			expect(body.files[0].fileName).toBe("hello.txt");
		});

		it("uploads multiple files", async () => {
			const env = createEnv();
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const putSpy = vi.fn().mockResolvedValue(undefined);
			env.INGEST_QUEUE = { send: sendSpy } as unknown as Queue;
			env.RAW_BUCKET = { put: putSpy } as unknown as R2Bucket;

			const form = new FormData();
			form.append("file", new File(["a"], "a.txt", { type: "text/plain" }));
			form.append("file", new File(["b"], "b.txt", { type: "text/plain" }));

			const res = await app.fetch(
				new Request("http://localhost/v1/files/src-1", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key" },
					body: form,
				}),
				env,
			);

			expect(res.status).toBe(202);
			expect(putSpy).toHaveBeenCalledTimes(2);
			expect(sendSpy).toHaveBeenCalledTimes(2);

			const body = await res.json() as { uploaded: number };
			expect(body.uploaded).toBe(2);
		});
	});

	describe("trigger proxy", () => {
		it("passes force parameter to core", async () => {
			const env = createEnv();
			let capturedBody: string | undefined;
			const fetcher = {
				fetch: async (url: string | Request, init?: RequestInit) => {
					capturedBody = init?.body as string;
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				},
			} as unknown as Fetcher;
			env.UPLINK_CORE = fetcher;

			await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
					body: JSON.stringify({ force: true }),
				}),
				env,
			);

			expect(JSON.parse(capturedBody ?? "{}")).toMatchObject({ force: true, triggeredBy: "edge" });
		});

		it("passes empty body when no params provided", async () => {
			const env = createEnv();
			let capturedBody: string | undefined;
			const fetcher = {
				fetch: async (url: string | Request, init?: RequestInit) => {
					capturedBody = init?.body as string;
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				},
			} as unknown as Fetcher;
			env.UPLINK_CORE = fetcher;

			await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer test-api-key", "content-type": "application/json" },
				}),
				env,
			);

			expect(JSON.parse(capturedBody ?? "{}")).toMatchObject({ triggeredBy: "edge" });
		});
	});
});
