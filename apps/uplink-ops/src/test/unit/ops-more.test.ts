import { describe, it, expect, vi } from "vitest";
import app from "../../index";

describe("uplink-ops additional", () => {
	const createEnv = () => ({
		OPS_API_KEY: "ops-key",
		CORE_INTERNAL_KEY: "internal-key",
		UPLINK_CORE: {
			fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
		} as unknown as Fetcher,
	});

	describe("auth variations", () => {
		it("rejects lowercase bearer prefix", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "bearer ops-key" },
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects empty bearer token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer " },
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("rejects missing space after Bearer", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearerops-key" },
				}),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("proxy behavior", () => {
		it("forwards GET /v1/runs", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.method).toBe("GET");
		});

		it("forwards GET /v1/runs/:runId", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/runs/run-123", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/runs/run-123");
		});

		it("forwards POST /v1/runs/:runId/replay", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/runs/run-123/replay", {
					method: "POST",
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.method).toBe("POST");
			expect(callArg.url).toContain("/internal/runs/run-123/replay");
		});

		it("forwards GET /v1/sources/:sourceId/health", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/sources/src-1/health", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/sources/src-1/health");
		});

		it("forwards GET /v1/artifacts/:artifactId", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/artifacts/art-1", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/artifacts/art-1");
		});

		it("forwards query parameters on /v1/runs", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/runs?limit=10", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("limit=10");
		});

		it("returns core response status", async () => {
			const env = createEnv();
			vi.mocked(env.UPLINK_CORE.fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
			);
			const res = await app.fetch(
				new Request("http://localhost/v1/runs/run-123", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			expect(res.status).toBe(404);
		});

		it("forwards POST /v1/sources/:sourceId/trigger with triggeredBy", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer ops-key", "content-type": "application/json" },
					body: JSON.stringify({ extra: "data" }),
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.method).toBe("POST");
			expect(callArg.url).toContain("/internal/sources/src-1/trigger");
			const body = await callArg.text();
			expect(body).toContain("triggeredBy");
			expect(body).toContain("ops");
		});
	});

	describe("missing env", () => {
		it("returns 500 when OPS_API_KEY is missing", async () => {
			const env = createEnv();
			(env as unknown as { OPS_API_KEY: string | undefined }).OPS_API_KEY = undefined;
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			expect(res.status).toBe(500);
		});
	});
});
