import { describe, it, expect, vi } from "vitest";
import app from "../../index";

describe("uplink-ops integration", () => {
	const createEnv = () => ({
		OPS_API_KEY: "ops-key",
		CORE_INTERNAL_KEY: "internal-key",
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
			expect(body.service).toBe("uplink-ops");
		});
	});

	describe("auth middleware", () => {
		it("returns 500 when OPS_API_KEY not configured", async () => {
			const env = createEnv();
			env.OPS_API_KEY = undefined;
			const res = await app.fetch(new Request("http://localhost/v1/runs"), env);
			expect(res.status).toBe(500);
		});

		it("returns 401 without authorization header", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/v1/runs"), env);
			expect(res.status).toBe(401);
		});

		it("returns 401 with wrong token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", { headers: { authorization: "Bearer wrong" } }),
				env,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("GET /v1/runs", () => {
		it("proxies to core with default limit", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", { headers: { authorization: "Bearer ops-key" } }),
				env,
			);
			expect(res.status).toBe(200);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/runs?limit=50");
			expect(callArg.headers.get("x-uplink-internal-key")).toBe("internal-key");
		});

		it("proxies to core with custom limit", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs?limit=10", { headers: { authorization: "Bearer ops-key" } }),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/runs?limit=10");
		});
	});

	describe("GET /v1/runs/:runId", () => {
		it("proxies to core", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs/run-123", { headers: { authorization: "Bearer ops-key" } }),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/runs/run-123");
		});
	});

	describe("POST /v1/runs/:runId/replay", () => {
		it("proxies POST to core", async () => {
			const env = createEnv();
			const res = await app.fetch(
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
	});

	describe("POST /v1/sources/:sourceId/trigger", () => {
		it("proxies trigger with ops triggeredBy", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/trigger", {
					method: "POST",
					headers: { authorization: "Bearer ops-key", "content-type": "application/json" },
					body: JSON.stringify({ force: true }),
				}),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/sources/src-1/trigger");
			const body = await callArg.text();
			expect(JSON.parse(body)).toMatchObject({ force: true, triggeredBy: "ops" });
		});
	});

	describe("GET /v1/sources/:sourceId/health", () => {
		it("proxies to core", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/sources/src-1/health", { headers: { authorization: "Bearer ops-key" } }),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/sources/src-1/health");
		});
	});

	describe("GET /v1/artifacts/:artifactId", () => {
		it("proxies to core", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/artifacts/art-1", { headers: { authorization: "Bearer ops-key" } }),
				env,
			);
			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain("/internal/artifacts/art-1");
		});
	});
});
