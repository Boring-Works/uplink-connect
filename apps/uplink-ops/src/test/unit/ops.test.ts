import { describe, it, expect, vi } from "vitest";
import app from "../../index";

describe("uplink-ops unit", () => {
	const createEnv = () => ({
		OPS_API_KEY: "ops-key",
		CORE_INTERNAL_KEY: "internal-key",
		UPLINK_CORE: {
			fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
		} as unknown as Fetcher,
	});

	describe("health", () => {
		it("returns service name", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json();
			expect(body.service).toBe("uplink-ops");
		});

		it("returns current timestamp", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/health"), env);
			const body = await res.json();
			expect(body.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("auth", () => {
		it("rejects requests to /v1 without auth", async () => {
			const env = createEnv();
			const res = await app.fetch(new Request("http://localhost/v1/runs"), env);
			expect(res.status).toBe(401);
		});

		it("rejects wrong bearer token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer wrong-key" },
				}),
				env,
			);
			expect(res.status).toBe(401);
		});

		it("accepts correct bearer token", async () => {
			const env = createEnv();
			const res = await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);
			expect(res.status).toBe(200);
		});
	});

	describe("proxy headers", () => {
		it("adds internal key header to core requests", async () => {
			const env = createEnv();
			await app.fetch(
				new Request("http://localhost/v1/runs", {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);

			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.headers.get("x-uplink-internal-key")).toBe("internal-key");
		});

		it("preserves original method in proxy", async () => {
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
		});
	});

	describe("url encoding", () => {
		it("encodes sourceId with special characters", async () => {
			const env = createEnv();
			const sourceId = "src/with/slashes";
			await app.fetch(
				new Request(`http://localhost/v1/sources/${encodeURIComponent(sourceId)}/health`, {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);

			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain(encodeURIComponent(sourceId));
		});

		it("encodes runId with special characters", async () => {
			const env = createEnv();
			const runId = "run:with:colons";
			await app.fetch(
				new Request(`http://localhost/v1/runs/${encodeURIComponent(runId)}`, {
					headers: { authorization: "Bearer ops-key" },
				}),
				env,
			);

			const callArg = vi.mocked(env.UPLINK_CORE.fetch).mock.calls[0][0] as Request;
			expect(callArg.url).toContain(encodeURIComponent(runId));
		});
	});
});
